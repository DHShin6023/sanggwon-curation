import numpy as np
import pandas as pd
import pytest

from etl.adapters.schema import AGE_COLUMNS, INDUSTRY_COLUMNS, TIME_COLUMNS, Normalized
from etl.engine import axes


def _fixture() -> Normalized:
    """4개 상권 × 2개 업종의 최소 픽스처. 값은 순위가 명확하도록 넣는다."""
    area_rows = []
    for i, code in enumerate(["A", "B", "C", "D"]):
        area_rows.append({
            "area_code": code, "area_name": f"상권{code}", "area_type": "alley",
            "gu_code": "11440",
            "dong_code": "11440510", "x": 0.0, "y": 0.0, "area_size": 10000.0,
            "resident_pop": 100 * (i + 1),
            "household": 40 * (i + 1),
            "worker_pop": 100 * (4 - i),
            "footfall": 1000 * (i + 1),
        })
    ind_rows = []
    for i, code in enumerate(["A", "B", "C", "D"]):
        for ind in ["CS100001", "CS200001"]:
            row = {c: 0.0 for c in INDUSTRY_COLUMNS}
            row.update({
                "area_code": code, "industry_code": ind, "industry_name": ind,
                "store_count": i + 1,
                "sales_total": 1_000_000.0 * (i + 1),
                "sales_per_store": 1_000_000.0,       # 동일 → 순위 무차별
                "sales_trend": 0.1 * i,
                "store_delta": i, "close_rate": 0.1 * (3 - i), "open_rate": 0.1,
                "avg_months": 12.0 * (i + 1), "weekday_ratio": 0.5,
            })
            for c in TIME_COLUMNS:
                row[c] = 1.0 / len(TIME_COLUMNS)
            for c in AGE_COLUMNS:
                row[c] = 1.0 / len(AGE_COLUMNS)
            ind_rows.append(row)
    return Normalized(
        areas=pd.DataFrame(area_rows),
        industries=pd.DataFrame(ind_rows)[INDUSTRY_COLUMNS],
        period="20261", region="seoul",
    )


def test_percentile_spans_zero_to_hundred():
    out = axes.percentile(pd.Series([1, 2, 3, 4]))
    assert out.min() == pytest.approx(0.0)
    assert out.max() == pytest.approx(100.0)


def test_percentile_preserves_missing():
    out = axes.percentile(pd.Series([1.0, np.nan, 3.0]))
    assert out.isna().sum() == 1


def test_percentile_of_single_sample_is_missing():
    """표본 1개로는 순위가 정의되지 않는다. 50점을 주면 '정확히 중간'이라는
    없는 정보를 지어내는 것이고 진짜 중앙값과 구분할 수 없게 된다."""
    assert axes.percentile(pd.Series([7.0])).isna().all()
    assert axes.percentile(pd.Series([7.0, np.nan])).isna().all()


def test_backing_population_missing_does_not_become_zero():
    """인구 한쪽만 결측인 상권을 0명으로 채우면 배후가 과소집계돼 경쟁축이
    부당하게 깎인다. 실측: 그런 상권 20곳(업종행 95개), 김포공항역은 이 탓에
    21,188행 중 최하위(0.6점)로 찍혔었다. 채우지 말고 결측으로 전파한다."""
    data = _fixture()
    data.areas.loc[data.areas["area_code"] == "A", "resident_pop"] = np.nan
    out = axes.score(data).set_index(["area_code", "industry_code"])
    assert pd.isna(out.at[("A", "CS100001"), "competition"])
    # 대조군: 인구가 멀쩡한 상권은 그대로 계산된다
    assert not pd.isna(out.at[("B", "CS100001"), "competition"])


def test_competition_is_missing_when_either_component_is():
    """경쟁축은 필수 축이라 구성요소 하나만 없어도 NaN이다 (2026-08-08 결정).

    점포수 0인 253행은 '매출은 잡히는데 점포수가 0'인 원본 불일치다. 밀도만으로
    채점하면 데이터 결함이 '경쟁자 없음'이라는 호재로 둔갑한다. Task 5가 이 행의
    등급을 보류한다.
    """
    data = _fixture()
    data.industries.loc[data.industries["area_code"] == "A", "sales_per_store"] = np.nan
    out = axes.score(data).set_index(["area_code", "industry_code"])
    assert pd.isna(out.at[("A", "CS100001"), "competition"])


def test_demand_is_scored_inside_the_pool():
    """수요축도 다른 축과 같은 풀에서 매겨야 한다.

    전체 상권을 놓고 매기면 업종이 큰 상권에 몰려 있는 탓에 풀 안에서 수요
    점수가 위로 쏠린다(실측 풀 평균 63.7~66.2, 균일하면 50). 그 쏠림이
    등급컷을 왜곡해 광역상권 "상" 비율을 18.9%까지 떨어뜨렸었다.
    광역 상권의 인구만 키워도 골목 상권의 수요 점수는 움직이면 안 된다.
    """
    before = axes.score(_split_pools()).set_index(["area_code", "industry_code"])

    shifted = _split_pools()
    metro = shifted.areas["area_code"].isin(["C", "D"])
    for col in ("resident_pop", "worker_pop", "footfall"):
        shifted.areas.loc[metro, col] *= 1000.0
    after = axes.score(shifted).set_index(["area_code", "industry_code"])

    for area in ("A", "B"):
        for col in ("demand_raw_resident", "demand_raw_worker", "demand_raw_footfall"):
            key = (area, "CS100001")
            assert before.at[key, col] == pytest.approx(after.at[key, col]), col


def test_pool_size_is_emitted():
    """Task 5가 얇은 풀의 등급을 보류하려면 표본 크기를 알아야 한다."""
    out = axes.score(_split_pools())
    # 픽스처: 골목 A·B / 광역 C·D, 업종 2개 → 모든 풀이 2행
    assert set(out["pool_size"]) == {2}


def test_demand_axes_are_not_merged():
    """수요축은 3개 원점수로 남아야 한다. 미리 합치면 업종별 가중이 불가능해진다."""
    out = axes.score(_fixture())
    for col in ("demand_raw_resident", "demand_raw_worker", "demand_raw_footfall"):
        assert col in out.columns
    assert "demand" not in out.columns


def test_all_axes_bounded():
    out = axes.score(_fixture())
    cols = ["demand_raw_resident", "demand_raw_worker", "demand_raw_footfall",
            "competition", "vitality", "fit"]
    values = out[cols].to_numpy(dtype=float)
    assert np.nanmin(values) >= 0.0 and np.nanmax(values) <= 100.0


def test_competition_rewards_higher_sales_per_store():
    """점포당매출이 높을수록 경쟁축 점수가 높아야 한다 (스펙 7.1)."""
    data = _fixture()
    data.industries.loc[data.industries["area_code"] == "A", "sales_per_store"] = 9_000_000.0
    data.industries.loc[data.industries["area_code"] == "D", "sales_per_store"] = 100_000.0
    out = axes.score(data).set_index(["area_code", "industry_code"])
    assert out.at[("A", "CS100001"), "competition"] > out.at[("D", "CS100001"), "competition"]


def test_vitality_penalises_high_close_rate():
    data = _fixture()
    out = axes.score(data).set_index(["area_code", "industry_code"])
    # 픽스처에서 close_rate는 A가 가장 높고 D가 가장 낮다
    assert out.at[("D", "CS100001"), "vitality"] > out.at[("A", "CS100001"), "vitality"]


def test_fit_is_percentile_of_profile_similarity():
    """상권 소비 프로필과 업종 전국 프로필이 어긋날수록 궁합이 낮아야 한다."""
    data = _fixture()
    ind = data.industries
    # A상권 CS100001만 심야 편중으로 비틀어 놓는다
    mask = (ind["area_code"] == "A") & (ind["industry_code"] == "CS100001")
    for c in TIME_COLUMNS:
        ind.loc[mask, c] = 0.0
    ind.loc[mask, "time_21_24"] = 1.0
    out = axes.score(data).set_index(["area_code", "industry_code"])
    others = [out.at[(a, "CS100001"), "fit"] for a in ("B", "C", "D")]
    assert out.at[("A", "CS100001"), "fit"] <= min(others)


def test_row_count_preserved():
    data = _fixture()
    assert len(axes.score(data)) == len(data.industries)


def _split_pools() -> Normalized:
    """C·D만 광역상권으로 돌린 픽스처. A·B는 골목으로 남는다."""
    data = _fixture()
    data.areas.loc[data.areas["area_code"].isin(["C", "D"]), "area_type"] = "metro"
    return data


def test_area_type_is_emitted():
    """Task 5가 등급컷을 같은 풀로 끊으려면 풀 키가 따라 나와야 한다."""
    out = axes.score(_split_pools())
    assert set(out["area_type"]) == {"alley", "metro"}


def test_other_pools_do_not_move_alley_scores():
    """다른 풀의 값이 아무리 흔들려도 골목상권 점수는 그대로여야 한다.

    한 풀로 매기면 골목 물건지가 광역상권에 눌린다(실측 백분위 중앙값 40.4점).
    광역 쪽 점포당매출만 100배로 키운 뒤 골목 점수가 미동도 없는지로 검증한다.
    """
    before = axes.score(_split_pools()).set_index(["area_code", "industry_code"])

    shifted = _split_pools()
    metro = shifted.industries["area_code"].isin(["C", "D"])
    shifted.industries.loc[metro, "sales_per_store"] *= 100.0
    after = axes.score(shifted).set_index(["area_code", "industry_code"])

    for area in ("A", "B"):
        key = (area, "CS100001")
        assert before.at[key, "competition"] == pytest.approx(after.at[key, "competition"])


def test_area_without_type_raises():
    """풀을 못 정하는 상권을 조용히 통과시키면 그 상권만 점수가 NaN이 된다."""
    data = _fixture()
    data.areas.loc[data.areas["area_code"] == "A", "area_type"] = None
    with pytest.raises(ValueError, match="A"):
        axes.score(data)
