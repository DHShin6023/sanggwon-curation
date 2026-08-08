import pytest

from etl.sources import seoul_api


def test_all_services_declared():
    assert set(seoul_api.SERVICES) == set(seoul_api.REQUIRED_COLUMNS)
    assert len(seoul_api.SERVICES) == 8


def test_page_ranges_respect_1000_row_limit():
    ranges = list(seoul_api.page_ranges(2500))
    assert ranges == [(1, 1000), (1001, 2000), (2001, 2500)]
    assert all(end - start < 1000 for start, end in ranges)


def test_page_ranges_handles_exact_multiple():
    assert list(seoul_api.page_ranges(2000)) == [(1, 1000), (1001, 2000)]


def test_page_ranges_empty():
    assert list(seoul_api.page_ranges(0)) == []


def test_load_rejects_unknown_dataset():
    with pytest.raises(ValueError):
        seoul_api.load("nope")


def test_area_loads_with_required_columns():
    """실제 API(또는 캐시)를 때려 필수 필드가 전부 있는지 검증한다.
    원본 스키마가 바뀌면 여기서 터져야 한다."""
    df = seoul_api.load("area")
    assert len(df) > 1000
    for col in seoul_api.REQUIRED_COLUMNS["area"]:
        assert col in df.columns, f"'{col}' 누락"


def test_all_datasets_load_and_validate():
    for name in seoul_api.SERVICES:
        df = seoul_api.load(name)
        assert len(df) > 0, f"{name} 비어 있음"


def test_quarter_helpers():
    assert seoul_api.shift_quarters("20261", 4) == "20251"
    assert seoul_api.shift_quarters("20261", 1) == "20254"
    assert seoul_api.quarter_distance("20261", "20251") == 4
    assert seoul_api.quarter_distance("20263", "20261") == 2
    assert len(seoul_api.current_quarter()) == 5


@pytest.mark.parametrize("dataset", ["sales", "stores", "footfall", "change", "dong_sales"])
def test_periods_are_latest_and_four_apart(dataset):
    """분기 필터를 쓰는 데이터셋은 「최신 분기 + 그 4분기 전」 정확히 2개여야 한다.

    표본에서 max를 뽑던 초기 구현이 sales를 2022년으로 잡은 적이 있다.
    최신성 검사가 없으면 조용히 4년 묵은 데이터로 판정하게 된다.
    """
    periods = sorted(seoul_api.load(dataset)["STDR_YYQU_CD"].astype(str).unique())
    assert len(periods) == 2, f"{dataset} 분기 {periods}"
    older, newer = periods
    assert seoul_api.shift_quarters(newer, 4) == older
    # 게시 지연을 감안해도 오늘로부터 3분기 이내여야 한다
    gap = seoul_api.quarter_distance(seoul_api.current_quarter(), newer)
    assert 0 <= gap <= 3, f"{dataset} 최신 분기 {newer} — 오늘 기준 {gap}분기 전"
