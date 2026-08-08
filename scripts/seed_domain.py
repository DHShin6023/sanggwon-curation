"""도메인 자산 잠정 시드 생성.

⚠️ 여기서 나오는 값은 전부 placeholder이며 판정 품질에 아무 의미가 없다.
provisional=true 인 동안에는 절대 공개 배포하지 않는다.
실제 값 작성 주체는 신동환(도메인 전문가)이다 — 스펙 7.4.
"""
import json
import sys

sys.path.insert(0, ".")
from etl.adapters import seoul          # noqa: E402
from etl.config import DOMAIN_DIR, FLOORS  # noqa: E402

GROUP_IDS = ["유동의존형", "배후의존형", "직장의존형", "목적방문형",
             "생활서비스형", "야간업종형"]

def main() -> None:
    DOMAIN_DIR.mkdir(parents=True, exist_ok=True)
    ind = seoul.normalize().industries
    codes = sorted(ind[["industry_code", "industry_name"]]
                   .drop_duplicates().itertuples(index=False), key=lambda r: r[0])

    (DOMAIN_DIR / "industry_groups.json").write_text(json.dumps({
        "provisional": True,
        "_note": "모든 업종을 유동의존형에 몰아넣은 잠정값. 신동환이 6~8개 그룹으로 배정할 것.",
        "groups": GROUP_IDS,
        "assignment": {c: {"name": n, "group": "유동의존형"} for c, n in codes},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (DOMAIN_DIR / "axis_weights.json").write_text(json.dumps({
        "provisional": True,
        "_note": "전 그룹 동일 가중 잠정값. 그룹별 차등이 이 서비스의 핵심 자산이다.",
        "weights": {g: {
            "resident": 0.15, "worker": 0.10, "footfall": 0.15,
            "competition": 0.25, "vitality": 0.20, "fit": 0.15,
        } for g in GROUP_IDS},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (DOMAIN_DIR / "floor_coefficients.json").write_text(json.dumps({
        "provisional": True,
        "basis": "heuristic",
        "_note": ("공공데이터에 층별 매출이 존재하지 않는다. 이 계수는 데이터 산출값이 "
                  "아니라 도메인 휴리스틱이며 화면에 그 성격을 표기한다 — 스펙 7.5."),
        "warn_below": 0.75,
        "coefficients": {g: {f: 1.0 for f in FLOORS} for g in GROUP_IDS},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (DOMAIN_DIR / "startup_filter.json").write_text(json.dumps({
        "provisional": True,
        "_note": ("일반 예비창업자가 실제로 열 수 있는 업종만 남기는 필터. "
                  "이게 없으면 대안 추천에 병원·약국이 튀어나온다 — 스펙 8.2. "
                  "작성 주체는 신동환."),
        "excluded": [],
        "_excluded_examples": ["의원", "치과의원", "한의원", "약국",
                               "일반병원", "산부인과", "동물병원"],
        "min_coefficient": 0.6,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"시드 생성 완료: 업종 {len(codes)}개, 그룹 {len(GROUP_IDS)}개")


if __name__ == "__main__":
    main()
