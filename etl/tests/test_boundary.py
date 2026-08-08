import json

from etl.config import SEOUL_GU
from etl.geometry import boundary


def test_mode_is_polygon():
    assert boundary.MODE == "polygon"


def test_build_covers_gu_codes():
    result = boundary.build()
    assert set(result).issubset(set(SEOUL_GU))
    assert len(result) >= 20, "서울 25개 자치구 중 최소 20개는 나와야 한다"


def test_every_bucket_declares_same_mode():
    result = boundary.build()
    assert {v["mode"] for v in result.values()} == {boundary.MODE}


def test_coordinates_are_wgs84_inside_seoul():
    """어느 분기든 출력 좌표는 WGS84여야 하고 서울 경계 안이어야 한다."""
    result = boundary.build()
    for payload in result.values():
        for area in payload["areas"]:
            lng, lat = area["rings"][0][0]
            assert 126.7 < lng < 127.3, f"{area['code']} 경도 이상: {lng}"
            assert 37.4 < lat < 37.7, f"{area['code']} 위도 이상: {lat}"


def test_serialisable_and_bounded_size():
    """자치구 1개 파일이 2MB를 넘으면 모바일에서 못 쓴다."""
    for gu, payload in boundary.build().items():
        size = len(json.dumps(payload, ensure_ascii=False).encode())
        assert size < 2_000_000, f"{gu} 경계 {size}바이트 — 단순화 필요"


def test_all_areas_covered():
    """SHP 1,650개가 자치구 버킷에 빠짐없이 담겨야 한다."""
    total = sum(len(p["areas"]) for p in boundary.build().values())
    assert total == 1650, f"{total}개만 담김 — 누락 {1650 - total}개"


def test_rings_are_closed():
    """point-in-polygon은 닫힌 링을 전제한다."""
    for payload in boundary.build().values():
        for area in payload["areas"]:
            for ring in area["rings"]:
                assert len(ring) >= 4
                assert ring[0] == ring[-1], f"{area['code']} 링이 닫히지 않음"


def test_bbox_contains_rings():
    """bbox 프리필터가 실제 링을 감싸야 한다. 어긋나면 매칭이 조용히 실패한다."""
    for payload in boundary.build().values():
        for area in payload["areas"]:
            min_lng, min_lat, max_lng, max_lat = area["bbox"]
            for ring in area["rings"]:
                for lng, lat in ring:
                    assert min_lng <= lng <= max_lng and min_lat <= lat <= max_lat
