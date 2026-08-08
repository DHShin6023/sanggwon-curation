import pandas as pd

from etl.adapters import seoul
from etl.adapters.schema import AREA_COLUMNS, INDUSTRY_COLUMNS


def test_normalize_produces_contract_columns():
    result = seoul.normalize()
    assert list(result.areas.columns) == AREA_COLUMNS
    assert list(result.industries.columns) == INDUSTRY_COLUMNS


def test_normalize_has_no_source_column_names():
    """엔진이 서울 원본 스키마를 보지 못하도록, 한글 원본 컬럼명이 새어나오면 안 된다."""
    result = seoul.normalize()
    leaked = [c for c in list(result.areas.columns) + list(result.industries.columns)
              if any("가" <= ch <= "힣" for ch in c)]
    assert leaked == [], f"원본 컬럼명 누출: {leaked}"


def test_period_is_latest_quarter():
    result = seoul.normalize()
    assert len(result.period) == 5 and result.period[4] in "1234"


def test_sales_per_store_is_positive_where_stores_exist():
    result = seoul.normalize()
    have = result.industries[result.industries["store_count"] > 0]
    assert (have["sales_per_store"] > 0).all()


def test_every_area_has_a_gu_code():
    result = seoul.normalize()
    assert result.areas["gu_code"].notna().all()
    assert result.areas["gu_code"].str.len().eq(5).all()


def test_profiles_sum_to_one():
    """궁합축 재료인 비중 벡터는 각 행에서 합이 1이어야 한다 (매출 0인 행 제외)."""
    result = seoul.normalize()
    rows = result.industries[result.industries["sales_total"] > 0]
    for prefix in ("time_", "age_"):
        cols = [c for c in INDUSTRY_COLUMNS if c.startswith(prefix)]
        assert (rows[cols].sum(axis=1) - 1.0).abs().max() < 1e-6
