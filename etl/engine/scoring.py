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


DEMAND_KEYS = ("resident", "worker", "footfall")

# 수요 3축을 합치는 방식(2026-08-09 신동환 결정).
MODE_MEAN = "평균"            # 세 축을 각자 가중치대로 더한다
MODE_STRONGEST = "최강우선"   # 세 축의 가중치를 하나로 합쳐 최강축 우선으로 쓴다
SUPPORTED_MODES = (MODE_MEAN, MODE_STRONGEST)


@dataclass(frozen=True)
class DomainAssets:
    groups: dict[str, str]              # 업종코드 → 그룹명
    weights: dict[str, dict[str, float]]  # 그룹명 → {축키: 가중치}
    demand_modes: dict[str, str]          # 그룹명 → 수요결합방식
    strongest_weight: float               # 최강우선에서 최강축이 갖는 몫
    floors: dict[str, dict[str, float]]   # 그룹명 → {층수코드: 계수}
    # 아래 둘은 브라우저가 쓰는 임계값이라 build가 meta.json에 실어 보낸다.
    # 웹은 data/ 아래만 fetch할 수 있어서(GitHub Pages 루트가 web/) data/domain/을
    # 직접 읽지 못한다 — 도메인 자산은 반드시 빌드 산출물을 거쳐야 한다.
    floor_warn_below: float               # 이 계수 미만이면 화면에 층수 경고
    floor_min_coefficient: float          # 이 계수 미만이면 대안 추천 후보에서 제외
    provisional: bool


def load_domain() -> DomainAssets:
    def read(name: str) -> dict:
        return json.loads((DOMAIN_DIR / name).read_text(encoding="utf-8"))

    g, w, f = read("industry_groups.json"), read("axis_weights.json"), read("floor_coefficients.json")

    # 수요결합방식을 모르면 죽는다. 조용히 평균으로 떨어뜨리면 복합의존형이
    # "최강우선으로 계산됐다"는 표시만 달고 실제로는 평균으로 계산된다 —
    # 이 프로젝트가 반복해서 잡아온 결함(없는 사실을 있는 것처럼)의 전형이다.
    # demand_modes는 weights와 **분리해서** 둔다. 예전엔 가중치 dict 안에
    # 문자열로 섞여 있었는데, 가중치 합계를 검사하는 코드가 그대로 깨졌다.
    # 숫자만 담는 dict에 문자열을 섞지 않는다.
    declared = w.get("demand_modes", {})
    modes = {}
    for group in w["weights"]:
        mode = declared.get(group, MODE_MEAN)
        if mode not in SUPPORTED_MODES:
            raise ValueError(
                f"axis_weights.json의 '{group}' demand_mode가 '{mode}'인데 "
                f"엔진이 아는 방식은 {SUPPORTED_MODES}뿐이다. 구현하거나 값을 고칠 것 — "
                "모르는 방식을 평균으로 넘기면 화면 설명과 실제 계산이 달라진다"
            )
        modes[group] = mode

    # 조용한 기본값을 두지 않는다 — 임계값이 빠진 채 배포되면 경고도 필터도
    # 있는 척만 하고 아무 일도 하지 않는다. 없으면 빌드가 여기서 죽는 편이 낫다.
    return DomainAssets(
        groups={code: item["group"] for code, item in g["assignment"].items()},
        weights=w["weights"],
        demand_modes=modes,
        strongest_weight=float(w["strongest_weight"]),
        floors=f["coefficients"],
        floor_warn_below=float(f["warn_below"]),
        floor_min_coefficient=float(f["min_coefficient"]),
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

    # 분류표에 없는 업종코드를 그냥 두면 모든 가중치가 0이 되어 base_score가
    # NaN이 되고, 다운스트림에서는 "경쟁 데이터 없음"과 구분되지 않는다.
    # 새 분기에 업종코드가 하나 늘어난 것만으로 서울 전역에서 그 업종이 조용히
    # 사라진다 → 드러낸다.
    unmapped = sorted(out.loc[group.isna(), "industry_code"].unique())
    if unmapped:
        raise ValueError(
            f"industry_groups.json에 없는 업종코드 {len(unmapped)}개: {unmapped[:5]}. "
            "분류표를 갱신할 것 — 임의로 넘기면 해당 업종이 통째로 판정 불가가 된다"
        )
    missing_group = sorted({g for g in group.unique() if g not in assets.weights})
    if missing_group:
        raise ValueError(f"axis_weights.json에 없는 업종그룹: {missing_group}")

    total = pd.Series(0.0, index=out.index)
    weight_sum = pd.Series(0.0, index=out.index)

    # 최강우선 그룹은 수요 3축을 개별로 더하지 않는다 — 아래에서 하나로 묶어
    # 처리하므로 이 루프에서는 건너뛴다.
    strongest = group.map(lambda g: assets.demand_modes.get(g) == MODE_STRONGEST)

    for key, column in AXIS_KEYS.items():
        w = group.map(lambda g: assets.weights.get(g, {}).get(key, 0.0)).astype(float)
        if key in DEMAND_KEYS:
            w = w.where(~strongest, 0.0)
        value = pd.to_numeric(out[column], errors="coerce")
        present = value.notna()
        # .where(present, 0.0)가 이미 결측 행을 0으로 만든다. 여기에 fillna를
        # 덧붙이면 "결측을 0으로 채운다"는 코드가 점수 계산 한복판에 남아
        # 다음 사람을 오도한다 — 이 프로젝트에서 세 번 터진 결함이다.
        total += (value * w).where(present, 0.0)
        weight_sum += w.where(present, 0.0)

    # ── 최강우선 (2026-08-09 신동환 결정) ────────────────────────────
    #
    # 한식·커피·편의점처럼 주거·직장·유동 중 **하나만 강해도 성립**하는 업종이
    # 있다. 평균으로 더하면 여의도 한식(직장 99·주거 19·유동 24)이 세 축 평균에
    # 눌려 실제보다 나쁘게 나온다.
    #
    # 그래서 세 축의 가중치를 하나의 "수요예산"으로 합치고, 그 예산 안에서
    #     최강축 × 0.6 + 나머지 평균 × 0.4
    # 로 계산한다. 한 축만 강한 자리를 제대로 집으면서, 세 축이 전부 약한 자리는
    # 여전히 걸러낸다(나머지 0.4가 그 역할을 한다).
    if strongest.any():
        demand = out[[AXIS_KEYS[k] for k in DEMAND_KEYS]].apply(
            pd.to_numeric, errors="coerce")
        n_present = demand.notna().sum(axis=1)
        mx = demand.max(axis=1)          # skipna 기본값 True
        rest_sum = demand.sum(axis=1) - mx.fillna(0.0)
        # 축이 하나뿐이면 "나머지 평균"이 없다. 그때는 그 축이 곧 수요다 —
        # 0으로 채우면 있지도 않은 약점을 지어내는 셈이 된다.
        rest_mean = (rest_sum / (n_present - 1)).where(n_present > 1)
        combined = np.where(
            n_present > 1,
            mx * assets.strongest_weight + rest_mean * (1 - assets.strongest_weight),
            mx,
        )
        combined = pd.Series(combined, index=out.index).where(n_present > 0)

        # 예산은 세 축 가중치의 합이다. 일부 축이 결측이어도 예산을 깎지 않는다 —
        # "하나만 강해도 성립"이 이 방식의 전제이므로, 축이 없다고 수요 자체의
        # 비중을 줄이면 방식이 스스로를 부정한다.
        budget = group.map(
            lambda g: sum(assets.weights.get(g, {}).get(k, 0.0) for k in DEMAND_KEYS)
        ).astype(float).where(strongest, 0.0)

        present = combined.notna() & strongest
        total += (combined * budget).where(present, 0.0)
        weight_sum += budget.where(present, 0.0)

    # 0~100 입력의 가중평균은 정의상 0~100을 벗어날 수 없다. clip을 걸면
    # 상류에서 범위가 깨졌을 때 조용히 감춰지므로 걸지 않는다.
    out["base_score"] = total / weight_sum.replace(0, np.nan)
    out["base_score"] = out["base_score"].where(out[REQUIRED_AXIS].notna())
    return out


def grade_cuts(scored: pd.DataFrame) -> dict[str, list[float]]:
    """업종별 75/50/25 분위. 스펙 7.2 — 등급은 반드시 동일 업종 안에서 매긴다.

    상권종류(area_type)로는 더 쪼개지 않는다. base_score를 이루는 **6개 축 전부가**
    (업종 × 상권종류) 안의 백분위라 각 풀의 점수가 저마다 0~100을 채우고,
    따라서 업종 단위 컷 하나로도 풀 간 공평하다. 여기서 또 쪼개면 (업종 ×
    상권종류) 그룹 중 18개가 10행 미만이라 분위수가 잡음이 된다.

    "6개 축 전부"가 전제다. 수요 3축만 전체 상권 기준으로 매기던 시절에는 그
    쏠림(풀 평균 63.7~66.2)이 그대로 새어나와 광역상권의 "상" 비율이 18.9%까지
    떨어졌다(골목 28.3%). test_grades_are_even_across_pools가 이 전제를 지킨다.
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
    # isinstance(x, float)는 np.float32 NaN에 False라 그대로 통과해 "하"가
    # 나온다 — 없는 점수에서 등급을 지어내는 셈. pd.isna는 float32·pd.NA·
    # None을 전부 잡는다.
    if score is None or pd.isna(score):
        raise ValueError("점수 없이 등급을 매기지 않는다")
    for boundary, grade in zip(cuts, GRADES):
        if score >= boundary:
            return grade
    return GRADES[-1]
