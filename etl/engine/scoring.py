"""업종그룹 가중합 + 업종별 등급컷. 스펙 7.2 / 7.4.

층수 계수는 여기서 곱하지 않는다. 사용자 입력이라 사전계산이 불가능하고,
브라우저(web/js/verdict.js)가 base_score에 곱해 등급컷과 대조한다.
"""
import json
from dataclasses import dataclass

import numpy as np
import pandas as pd

from etl.config import DOMAIN_DIR, GRADES

AXIS_KEYS = {
    "resident": "demand_raw_resident",
    "worker": "demand_raw_worker",
    "footfall": "demand_raw_footfall",
    "competition": "competition",
    "vitality": "vitality",
    "fit": "fit",
}


@dataclass(frozen=True)
class DomainAssets:
    groups: dict[str, str]              # 업종코드 → 그룹명
    weights: dict[str, dict[str, float]]  # 그룹명 → {축키: 가중치}
    floors: dict[str, dict[str, float]]   # 그룹명 → {층수코드: 계수}
    provisional: bool


def load_domain() -> DomainAssets:
    def read(name: str) -> dict:
        return json.loads((DOMAIN_DIR / name).read_text(encoding="utf-8"))

    g, w, f = read("industry_groups.json"), read("axis_weights.json"), read("floor_coefficients.json")
    return DomainAssets(
        groups={code: item["group"] for code, item in g["assignment"].items()},
        weights=w["weights"],
        floors=f["coefficients"],
        provisional=any(x.get("provisional", False) for x in (g, w, f)),
    )


REQUIRED_AXIS = "competition"


def base_score(axis_df: pd.DataFrame, assets: DomainAssets) -> pd.DataFrame:
    """층수 미적용 가중합 (0~100). 결측 축은 가중치에서 빼고 재정규화한다.

    단 경쟁축만은 필수다(2026-08-08 결정). 창업자가 가장 알아야 할 게 경쟁 강도인데
    그걸 빼고 낸 등급은 틀린 등급보다 위험하다. 경쟁축이 없으면 base_score를 NaN으로
    두고, 화면은 스펙 10.3의 🔴 "분석 불가"로 표시한다(수요·활력·궁합 수치는 보여준다).
    실측 21,188행 중 약 350행(1.7%) — 점포수 0인 원본 불일치 253행 + 배후인구
    미집계 약 95행.
    """
    out = axis_df.copy()
    group = out["industry_code"].map(assets.groups)

    total = pd.Series(0.0, index=out.index)
    weight_sum = pd.Series(0.0, index=out.index)

    for key, column in AXIS_KEYS.items():
        w = group.map(lambda g: assets.weights.get(g, {}).get(key, 0.0)).astype(float)
        value = pd.to_numeric(out[column], errors="coerce")
        present = value.notna()
        total += (value.fillna(0.0) * w).where(present, 0.0)
        weight_sum += w.where(present, 0.0)

    out["base_score"] = (total / weight_sum.replace(0, np.nan)).clip(0, 100)
    out["base_score"] = out["base_score"].where(out[REQUIRED_AXIS].notna())
    return out


def grade_cuts(scored: pd.DataFrame) -> dict[str, list[float]]:
    """업종별 75/50/25 분위. 스펙 7.2 — 등급은 반드시 동일 업종 안에서 매긴다.

    상권종류(area_type)로는 더 쪼개지 않는다. base_score를 이루는 4축이 이미
    (업종 × 상권종류) 안의 백분위라 각 풀의 점수가 저마다 0~100을 채우고,
    따라서 업종 단위 컷 하나로도 풀 간 공평하다. 여기서 또 쪼개면 (업종 ×
    상권종류) 그룹 중 18개가 10행 미만이라 분위수가 잡음이 된다.
    이 가정은 test_grades_are_even_across_pools가 지킨다.
    """
    cuts: dict[str, list[float]] = {}
    for code, group in scored.groupby("industry_code"):
        s = group["base_score"].dropna()
        if s.empty:
            continue
        cuts[str(code)] = [round(float(s.quantile(q)), 4) for q in (0.75, 0.50, 0.25)]
    return cuts


def grade_of(score: float, cuts: list[float]) -> str:
    """cuts = [상컷, 중상컷, 중하컷]"""
    if score is None or (isinstance(score, float) and np.isnan(score)):
        raise ValueError("점수 없이 등급을 매기지 않는다")
    for boundary, grade in zip(cuts, GRADES):
        if score >= boundary:
            return grade
    return GRADES[-1]
