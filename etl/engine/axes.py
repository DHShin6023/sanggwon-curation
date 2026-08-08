"""4축 원점수 산출. 스펙 7.1.

전 축을 「같은 풀 안에서의 백분위(0~100, 클수록 좋음)」로 통일한다.
단위가 다른 지표(명, 원, 개월, %)를 그대로 더할 수 없기 때문이다.

풀 = (업종 × 상권종류). 업종을 나누는 이유는 스펙 7.2(마진 좋은 업종은 어딜
찍어도 "상"이 나온다)이고, 상권종류를 나누는 이유도 같다 — 실측(2026-08-08)에서
한 풀로 매기면 골목상권 물건지의 업종내 백분위 중앙값이 40.4점(기대 50),
상위 25% 진입률이 17.1%(기대 25%)로 눌렸다. 예비창업자가 보는 물건은 대부분
골목상권이라 어딜 찍어도 "중하"가 나오면 후보를 걸러주지 못한다.
창업자가 바꿀 수 없는 구조적 조건은 비교에서 빼고 같은 조건끼리 겨루게 한다.

수요축만은 3개 인구를 합치지 않고 따로 내보낸다. 업종마다 중요한 인구가
다르므로(카페=유동, 세탁편의점=배후세대, 국밥집=직장) 합성은 업종그룹
가중치를 아는 scoring.py의 몫이다.
"""
import numpy as np
import pandas as pd

from etl.adapters.schema import AGE_COLUMNS, TIME_COLUMNS, Normalized

OUTPUT_COLUMNS = [
    "area_code", "industry_code", "area_type", "pool_size",
    "demand_raw_resident", "demand_raw_worker", "demand_raw_footfall",
    "competition", "vitality", "fit",
]


def percentile(series: pd.Series) -> pd.Series:
    """풀 안에서의 0~100 순위 점수. 결측은 결측으로 남긴다.

    pandas의 rank(pct=True)는 rank/n이라 최솟값이 0이 아니라 1/n이 된다
    (n=4면 25,50,75,100). 여기서는 (rank-1)/(n-1)로 직접 정규화해 풀 크기와
    무관하게 0~100 전 구간을 채운다 — 등급컷이 업종 단위 하나뿐이라(Task 5)
    서로 다른 크기의 풀에서 나온 점수가 같은 자로 재어져야 하기 때문이다.
    rank/n을 쓰면 3행짜리 풀의 평균이 67점, 200행짜리 풀은 50점이 되어
    작은 풀이 통째로 유리해진다.

    표본이 1개뿐이면 순위 자체가 정의되지 않는다. 50.0을 주면 "정확히 중간"이라는
    없는 정보를 지어내는 것이고 다운스트림에서 진짜 중앙값과 구분되지 않으므로
    결측으로 남긴다(Global Constraint: 평균·0·임의값으로 채우지 않는다).
    """
    numeric = pd.to_numeric(series, errors="coerce")
    n = numeric.notna().sum()
    if n <= 1:
        return pd.Series(np.nan, index=series.index, dtype=float)
    ranks = numeric.rank(method="average", na_option="keep")
    return (ranks - 1) / (n - 1) * 100.0


def _cosine(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    na = np.linalg.norm(a, axis=1)
    nb = np.linalg.norm(b, axis=1)
    denom = na * nb
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(denom > 0, (a * b).sum(axis=1) / denom, np.nan)


def score(data: Normalized) -> pd.DataFrame:
    areas = data.areas.set_index("area_code")
    ind = data.industries.merge(
        data.areas[["area_code", "area_type"]], on="area_code", how="left")

    orphan = sorted(ind.loc[ind["area_type"].isna(), "area_code"].unique())
    if orphan:
        raise ValueError(
            f"채점 풀을 정할 수 없는 상권 {len(orphan)}개: {orphan[:5]}. "
            "임의로 분류하면 등급이 조용히 틀어진다 — 어댑터의 area_type을 확인할 것"
        )

    def by_pool(series: pd.Series) -> pd.Series:
        """(업종 × 상권종류) 안에서만 순위를 매긴다 — 모듈 docstring 참조."""
        return series.groupby(
            [ind["industry_code"], ind["area_type"]], group_keys=False
        ).apply(percentile)

    # ── ① 수요: 3개 인구를 각각 백분위. 합성하지 않는다 ──
    # 다른 축과 똑같이 (업종 × 상권종류) 풀 안에서 매긴다. 상권 단위 지표라
    # 전체 상권을 놓고 매기고 싶어지지만 그러면 안 된다 — 업종은 큰 상권에
    # 몰려 있어서, 그 업종이 실제로 있는 상권들만 모아 놓으면 수요 점수가 위로
    # 쏠린다. 실측(2026-08-08): 전체 기준으로 매겼을 때 풀 평균이 63.7~66.2점
    # (균일하면 50), 반면 경쟁·활력·궁합은 49.8~50.0. 이 쏠림이 등급컷을
    # 왜곡해 광역상권의 "상" 비율을 18.9%까지 떨어뜨렸다(골목 28.3%).
    # 풀 기준으로 바꾸면 세 풀 모두 24~26%로 고르게 맞는다.
    out = ind[["area_code", "industry_code", "area_type"]].copy()
    for target, source in (("demand_raw_resident", "resident_pop"),
                           ("demand_raw_worker", "worker_pop"),
                           ("demand_raw_footfall", "footfall")):
        out[target] = by_pool(ind["area_code"].map(areas[source]))

    # 풀이 얇으면 순위 점수가 잡음이다 — n=3이면 가능한 값이 0/50/100 셋뿐이다.
    # 실측 18개 풀(92행)이 10행 미만. 어느 선부터 신뢰하지 않을지는 제품 판단이라
    # 여기서는 자르지 않고 표본 크기를 실어 보내고, Task 5/웹이 판단한다.
    out["pool_size"] = ind.groupby(
        ["industry_code", "area_type"])["area_code"].transform("size")

    # ── ② 경쟁: 점포당매출(↑) + 배후 대비 점포밀도(↓) ──
    sales_rank = by_pool(ind["sales_per_store"])

    # 한쪽 인구만 결측일 때 0으로 채우면 배후가 과소집계되어 밀도가 부풀고
    # 경쟁축이 일방적으로 깎인다. 실측: 한쪽만 결측인 상권 20곳(업종행 95개),
    # 그중 김포공항역(3120115)은 상주인구 결측을 0으로 채운 탓에 경쟁축이
    # 21,188행 중 최하위(0.6점)로 찍혔다. 없는 인구를 0명이라고 하지 않는다.
    backing = areas["resident_pop"] + areas["worker_pop"]
    density = ind["store_count"] / ind["area_code"].map(backing).replace(0, np.nan)
    density_rank = 100.0 - by_pool(density)
    # 두 구성요소 중 하나라도 없으면 경쟁축은 NaN이다 — 재정규화하지 않는다.
    # 특히 sales_per_store 결측 253행은 "매출은 잡히는데 점포수가 0"인 원본
    # 불일치라, 밀도만으로 채점하면 데이터 결함이 "경쟁자 없음"이라는 호재로
    # 둔갑한다. 경쟁축은 필수 축이고, 없으면 Task 5가 등급을 보류한다.
    out["competition"] = (sales_rank * 0.6 + density_rank * 0.4)

    # ── ③ 활력: 매출추세(↑) + 폐업률(↓) + 평균영업개월(↑) + 점포증감(↓) ──
    trend_rank = by_pool(ind["sales_trend"])
    close_rank = 100.0 - by_pool(ind["close_rate"])
    months_rank = by_pool(ind["avg_months"])
    delta_rank = 100.0 - by_pool(ind["store_delta"])
    vitality = pd.concat([trend_rank * 0.35, close_rank * 0.30,
                          months_rank * 0.20, delta_rank * 0.15], axis=1)
    # 결측 축은 빼고 남은 가중치로 재정규화한다 — 없는 값을 0점으로 취급하지 않는다
    weights = pd.DataFrame({c: (0.35, 0.30, 0.20, 0.15)[i]
                            for i, c in enumerate(vitality.columns)},
                           index=vitality.index).where(vitality.notna())
    out["vitality"] = vitality.sum(axis=1, min_count=1) / weights.sum(axis=1)

    # ── ④ 궁합: 상권 소비 프로필 vs 업종의 서울 전체 프로필 코사인 유사도 ──
    profile_cols = TIME_COLUMNS + AGE_COLUMNS
    weighted = ind[profile_cols].mul(ind["sales_total"], axis=0)

    area_profile = weighted.groupby(ind["area_code"]).sum()
    area_profile = area_profile.div(area_profile.sum(axis=1).replace(0, np.nan), axis=0)

    ind_profile = weighted.groupby(ind["industry_code"]).sum()
    ind_profile = ind_profile.div(ind_profile.sum(axis=1).replace(0, np.nan), axis=0)

    sim = _cosine(
        area_profile.reindex(ind["area_code"]).to_numpy(dtype=float),
        ind_profile.reindex(ind["industry_code"]).to_numpy(dtype=float),
    )
    # 업종 프로필은 서울 전체 기준으로 잡되(풀을 나누면 표본이 얇아진다),
    # 유사도를 점수로 환산할 때만 같은 풀 안에서 줄 세운다.
    out["fit"] = by_pool(pd.Series(sim, index=ind.index))

    return out.reindex(columns=OUTPUT_COLUMNS).reset_index(drop=True)
