import pandas as pd

from etl.adapters import seoul
from etl.adapters.schema import AREA_COLUMNS, INDUSTRY_COLUMNS
from etl.sources import seoul_api


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


def test_sales_per_store_is_nan_not_zero_when_no_stores():
    """점포수가 0이면 '점포당 매출 0원'을 지어내지 말고 NaN으로 남겨야 한다.

    매출이 실제로 있는데(sales_total > 0) 집계 시점 점포수가 0으로 잡힌
    (상권, 업종) 조합이 실측 데이터에 존재한다 — 이 경우 0으로 채우면
    경쟁축 최하위로 랭크되어 판정이 왜곡된다.
    """
    result = seoul.normalize()
    none = result.industries[result.industries["store_count"] == 0]
    assert not none.empty, "회귀 검증 전제(store_count==0 행 존재)가 깨졌다"
    assert none["sales_per_store"].isna().all()


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


def test_population_aggregation_uses_min_count_to_avoid_false_zero(monkeypatch):
    """전부 NaN인 인구 그룹을 groupby().sum()이 0.0으로 뭉개면 안 된다 (min_count=1 검증).

    실측 캐시 데이터에는 완전히 빈 인구 그룹이 없어 이 회귀를 실데이터로는
    못 잡는다. 합성 입력으로 인구 필드가 전부 NaN인 상권(A002)을 만들어
    직접 검증한다 — 값이 없으면 NaN이어야지, "인구 0명"을 지어내면 안 된다.
    """
    period, prev = "20261", "20251"

    sales = pd.DataFrame({
        "STDR_YYQU_CD": [period, period],
        "TRDAR_CD": ["A001", "A002"],
        "SVC_INDUTY_CD": ["CS001", "CS001"],
        "SVC_INDUTY_CD_NM": ["카페", "카페"],
        "THSMON_SELNG_AMT": [1000.0, 1000.0],
        "MDWK_SELNG_AMT": [600.0, 600.0],
        "WKEND_SELNG_AMT": [400.0, 400.0],
        "TMZON_00_06_SELNG_AMT": [0.0, 0.0],
        "TMZON_06_11_SELNG_AMT": [0.0, 0.0],
        "TMZON_11_14_SELNG_AMT": [500.0, 500.0],
        "TMZON_14_17_SELNG_AMT": [200.0, 200.0],
        "TMZON_17_21_SELNG_AMT": [200.0, 200.0],
        "TMZON_21_24_SELNG_AMT": [100.0, 100.0],
        "AGRDE_10_SELNG_AMT": [0.0, 0.0],
        "AGRDE_20_SELNG_AMT": [500.0, 500.0],
        "AGRDE_30_SELNG_AMT": [500.0, 500.0],
        "AGRDE_40_SELNG_AMT": [0.0, 0.0],
        "AGRDE_50_SELNG_AMT": [0.0, 0.0],
        "AGRDE_60_ABOVE_SELNG_AMT": [0.0, 0.0],
    })

    stores = pd.DataFrame({
        "STDR_YYQU_CD": [period, period],
        "TRDAR_CD": ["A001", "A002"],
        "SVC_INDUTY_CD": ["CS001", "CS001"],
        "STOR_CO": [1, 1],
        "OPBIZ_RT": [0.0, 0.0],
        "CLSBIZ_RT": [0.0, 0.0],
    })

    area = pd.DataFrame({
        "TRDAR_CD": ["A001", "A002"],
        "TRDAR_CD_NM": ["상권1", "상권2"],
        "SIGNGU_CD": ["11110", "11110"],
        "ADSTRD_CD": ["11110101", "11110101"],
        "XCNTS_VALUE": [100.0, 200.0],
        "YDNTS_VALUE": [100.0, 200.0],
        "RELM_AR": [1000.0, 1000.0],
    })

    # A002는 인구 필드가 전부 NaN인 상권 — min_count=1이 없으면 0.0으로 뭉개진다.
    resident = pd.DataFrame({
        "STDR_YYQU_CD": [period, period, period],
        "TRDAR_CD": ["A001", "A002", "A002"],
        "TOT_REPOP_CO": [100.0, float("nan"), float("nan")],
        "TOT_HSHLD_CO": [50.0, float("nan"), float("nan")],
    })

    worker = pd.DataFrame({
        "STDR_YYQU_CD": [period, period],
        "TRDAR_CD": ["A001", "A002"],
        "TOT_WRC_POPLTN_CO": [10.0, 20.0],
    })

    footfall = pd.DataFrame({
        "STDR_YYQU_CD": [period, period],
        "TRDAR_CD": ["A001", "A002"],
        "TOT_FLPOP_CO": [10.0, 20.0],
    })

    change = pd.DataFrame({
        "STDR_YYQU_CD": [period, period],
        "TRDAR_CD": ["A001", "A002"],
        "OPR_SALE_MT_AVRG": [12.0, 12.0],
    })

    fakes = {
        "sales": sales, "stores": stores, "area": area,
        "resident": resident, "worker": worker,
        "footfall": footfall, "change": change,
    }

    def fake_load(dataset: str) -> pd.DataFrame:
        return fakes[dataset].copy()

    monkeypatch.setattr(seoul_api, "load", fake_load)

    result = seoul.normalize()

    row = result.areas.set_index("area_code").loc["A002"]
    assert pd.isna(row["resident_pop"]), "전부 NaN인 인구 그룹이 0.0으로 뭉개졌다"
    assert pd.isna(row["household"]), "전부 NaN인 가구 그룹이 0.0으로 뭉개졌다"
    # 대조군: 정상 값이 있는 상권은 그대로 집계돼야 한다.
    row_ok = result.areas.set_index("area_code").loc["A001"]
    assert row_ok["resident_pop"] == 100.0
    assert row_ok["household"] == 50.0
