import pandas as pd

from etl.adapters.schema import INDUSTRY_COLUMNS
from etl.engine import patterns


def _frames(**overrides):
    axis = pd.DataFrame({
        "area_code": ["A"], "industry_code": ["CS1"],
        "demand_raw_resident": [50.0], "demand_raw_worker": [50.0],
        "demand_raw_footfall": [50.0], "competition": [50.0],
        "vitality": [50.0], "fit": [50.0],
        # 패턴 조건은 합성 경쟁축이 아니라 이 두 원 지표 백분위에 걸린다
        "sales_per_store_pct": [50.0], "density_pct": [50.0],
    })
    row = {c: 0.0 for c in INDUSTRY_COLUMNS}
    row.update({"area_code": "A", "industry_code": "CS1", "industry_name": "테스트",
                "store_count": 10, "sales_total": 1e8, "sales_per_store": 1e7,
                "sales_trend": 0.0, "store_delta": 0, "close_rate": 0.05,
                "open_rate": 0.05, "avg_months": 36.0})
    for key, value in overrides.items():
        if key in axis.columns:
            axis[key] = value
        else:
            row[key] = value
    return axis, pd.DataFrame([row])[INDUSTRY_COLUMNS]


def _detect(**overrides) -> list[str]:
    axis, ind = _frames(**overrides)
    return patterns.detect(axis, ind).loc[0, "patterns"]


def test_pattern_names_are_fixed():
    assert patterns.PATTERNS == ("함정상권", "침몰상권", "포화", "블루오션")


def test_trap_area_detected():
    """유동 상위 + 점포당매출 하위 → 함정 상권"""
    assert "함정상권" in _detect(demand_raw_footfall=95.0, sales_per_store_pct=10.0)


def test_trap_area_not_detected_when_sales_healthy():
    assert "함정상권" not in _detect(demand_raw_footfall=95.0, sales_per_store_pct=80.0)


def test_sinking_area_detected():
    """매출 하락 + 폐업률 상승 + 점포수 증가 → 침몰 상권"""
    assert "침몰상권" in _detect(sales_trend=-0.15, close_rate=0.20, store_delta=3)


def test_sinking_needs_all_three_conditions():
    assert "침몰상권" not in _detect(sales_trend=-0.15, close_rate=0.20, store_delta=-2)


def test_saturation_detected():
    """스펙 7.3: 점포밀도 상위 5%. 합성 경쟁축이 아니라 밀도 백분위로 판정한다."""
    assert "포화" in _detect(density_pct=97.0)


def test_blue_ocean_detected():
    """배후 충분 + 경쟁 하위 → 블루오션 (대안 추천의 핵심 신호)"""
    assert "블루오션" in _detect(demand_raw_resident=90.0, competition=85.0, store_count=1)


def test_normal_area_has_no_pattern():
    assert _detect() == []


def test_output_row_count_matches_input():
    axis, ind = _frames()
    assert len(patterns.detect(axis, ind)) == len(axis)


def test_saturation_uses_raw_density_not_the_composite():
    """스펙 7.3의 포화는 "점포밀도 상위 5%"다.

    합성 경쟁축으로 근사하면 안 된다. competition은 두 백분위의 0.6/0.4
    가중합이라 분포가 가운데로 몰려(평균 49.8, 5분위 값 15.98) `<= 5`가
    5%가 아니라 0.50%를 고른다 — 실측 스펙 대상 1,136행 중 105행만 잡혔다.
    """
    axis, ind = _frames()
    axis = axis.copy()
    # 밀도는 최상위인데 점포당매출이 좋아 합성 경쟁축은 멀쩡한 상권
    axis.loc[0, "density_pct"] = 99.0
    axis.loc[0, "sales_per_store_pct"] = 90.0
    axis.loc[0, "competition"] = 90.0 * 0.6 + (100.0 - 99.0) * 0.4
    out = patterns.detect(axis, ind)
    assert "포화" in out.loc[0, "patterns"]


def test_trap_uses_sales_per_store_not_the_composite():
    """스펙 7.3의 함정상권은 "유동 상위 + 점포당매출 하위"다.
    밀도를 섞으면 의미가 달라진다 — 실측 대칭차 890행."""
    axis, ind = _frames()
    axis = axis.copy()
    # 점포당매출은 바닥인데 밀도가 낮아 합성 경쟁축은 중간인 상권
    axis.loc[0, "demand_raw_footfall"] = 95.0
    axis.loc[0, "sales_per_store_pct"] = 5.0
    axis.loc[0, "density_pct"] = 5.0
    axis.loc[0, "competition"] = 5.0 * 0.6 + (100.0 - 5.0) * 0.4   # = 41.0
    out = patterns.detect(axis, ind)
    assert "함정상권" in out.loc[0, "patterns"]


def test_missing_input_is_unknown_not_absent():
    """입력이 없으면 "패턴 없음"이 아니라 "판정 못 함"이다.

    비교 연산이 NaN에 False를 주는 탓에 침몰상권이 조용히 "최악 조합 아님"으로
    나오고 있었다 — sales_trend 결측 1,101행 중 1,076행은 등급까지 정상 부여되어
    사용자가 구분할 방법이 없었다.
    """
    axis, ind = _frames()
    ind = ind.copy()
    ind.loc[0, "sales_trend"] = float("nan")
    out = patterns.detect(axis, ind)
    assert "침몰상권" in out.loc[0, "patterns_unknown"]
    assert "침몰상권" not in out.loc[0, "patterns"]
