import pandas as pd

from etl.adapters.schema import INDUSTRY_COLUMNS
from etl.engine import patterns


def _frames(**overrides):
    axis = pd.DataFrame({
        "area_code": ["A"], "industry_code": ["CS1"],
        "demand_raw_resident": [50.0], "demand_raw_worker": [50.0],
        "demand_raw_footfall": [50.0], "competition": [50.0],
        "vitality": [50.0], "fit": [50.0],
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
    assert "함정상권" in _detect(demand_raw_footfall=95.0, competition=10.0)


def test_trap_area_not_detected_when_sales_healthy():
    assert "함정상권" not in _detect(demand_raw_footfall=95.0, competition=80.0)


def test_sinking_area_detected():
    """매출 하락 + 폐업률 상승 + 점포수 증가 → 침몰 상권"""
    assert "침몰상권" in _detect(sales_trend=-0.15, close_rate=0.20, store_delta=3)


def test_sinking_needs_all_three_conditions():
    assert "침몰상권" not in _detect(sales_trend=-0.15, close_rate=0.20, store_delta=-2)


def test_saturation_detected():
    assert "포화" in _detect(competition=3.0)


def test_blue_ocean_detected():
    """배후 충분 + 경쟁 하위 → 블루오션 (대안 추천의 핵심 신호)"""
    assert "블루오션" in _detect(demand_raw_resident=90.0, competition=85.0, store_count=1)


def test_normal_area_has_no_pattern():
    assert _detect() == []


def test_output_row_count_matches_input():
    axis, ind = _frames()
    assert len(patterns.detect(axis, ind)) == len(axis)
