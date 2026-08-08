import json

from etl.config import ROOT, SEOUL_GU, WEB_DATA_DIR
from etl import build


def test_build_writes_meta():
    build.main()
    meta = json.loads((WEB_DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    for key in ("period", "period_label", "generated_at", "grade_cuts",
                "industries", "gu", "provisional", "sources"):
        assert key in meta, f"meta.json에 {key} 없음"
    assert meta["period_label"].endswith("분기")


def test_grade_cuts_present_for_every_industry():
    meta = json.loads((WEB_DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    for item in meta["industries"]:
        assert item["code"] in meta["grade_cuts"], f"{item['code']} 등급컷 없음"


def test_score_files_exist_per_gu():
    written = {p.stem for p in (WEB_DATA_DIR / "score").glob("*.json")}
    assert written and written.issubset(set(SEOUL_GU))


def test_score_file_shape():
    path = next((WEB_DATA_DIR / "score").glob("*.json"))
    payload = json.loads(path.read_text(encoding="utf-8"))
    area = next(iter(payload["areas"].values()))
    assert {"name", "area_type", "industries"}.issubset(area)
    assert area["area_type"] in {"alley", "market", "metro"}
    entry = next(iter(area["industries"].values()))
    assert {"base", "store_count", "patterns",
            "patterns_unknown", "pool_size"}.issubset(entry)
    assert isinstance(entry["patterns"], list)
    assert isinstance(entry["patterns_unknown"], list)


def test_unjudgeable_rows_ship_null_base_not_zero():
    """경쟁축 결측 365행은 등급을 매기지 않는다. base가 0으로 나가면 웹이
    "최악 입지"로 렌더한다 — 없는 판정을 지어내는 것과 같다(스펙 10.3)."""
    seen_null = False
    for path in (WEB_DATA_DIR / "score").glob("*.json"):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for area in payload["areas"].values():
            for entry in area["industries"].values():
                assert entry["base"] is None or entry["base"] > 0, \
                    "판정 불가가 0점으로 나갔다"
                seen_null |= entry["base"] is None
    assert seen_null, "판정 불가 행이 하나도 안 나왔다 — 필터링돼 버린 것 아닌가"


def test_unknown_patterns_are_not_reported_as_absent():
    """확인 못 한 패턴이 patterns에 섞이면 "경고 없음"으로 읽힌다."""
    found = False
    for path in (WEB_DATA_DIR / "score").glob("*.json"):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for area in payload["areas"].values():
            for entry in area["industries"].values():
                assert not set(entry["patterns"]) & set(entry["patterns_unknown"])
                found |= bool(entry["patterns_unknown"])
    assert found, "patterns_unknown이 전부 비었다 — 전달이 끊긴 것 아닌가"


def test_dong_industry_codes_are_all_named():
    """meta에 없는 업종코드가 폴백에 뜨면 화면에 코드가 그대로 노출된다.
    실측: dong_sales에만 있는 CS200036이 이름 없이 나가고 있었다."""
    meta = json.loads((WEB_DATA_DIR / "meta.json").read_text(encoding="utf-8"))
    known = {i["code"] for i in meta["industries"]}
    for path in (WEB_DATA_DIR / "dong").glob("*.json"):
        for dong in json.loads(path.read_text(encoding="utf-8"))["dongs"].values():
            unknown = set(dong["industries"]) - known
            assert not unknown, f"{path.name}: meta에 없는 업종 {sorted(unknown)}"


def test_build_does_not_leak_source_field_names():
    """build.py가 서울 원본 필드명을 쓰면 어댑터 계약이 무의미해지고
    경기 어댑터를 붙이는 순간 깨진다."""
    source = (ROOT / "etl" / "build.py").read_text(encoding="utf-8")
    for leaked in ("ADSTRD_CD", "SVC_INDUTY_CD", "STDR_YYQU_CD",
                   "THSMON_SELNG_AMT", "TRDAR_CD"):
        assert leaked not in source, f"원본 필드명 누출: {leaked}"


def test_every_boundary_area_has_a_score_entry():
    """경계 폴리곤에만 있고 score에 없는 상권이 있으면, Task 8이 주소를 그
    폴리곤 안으로 매칭해 놓고 데이터를 못 찾는다. 실측 1,650 vs 1,564로
    86개가 비어 있었다 — 매출 데이터 없는 상권은 빈 껍데기로라도 나가야 한다."""
    for path in (WEB_DATA_DIR / "boundary").glob("*.json"):
        boundary_codes = {a["code"] for a in json.loads(
            path.read_text(encoding="utf-8"))["areas"]}
        score_path = WEB_DATA_DIR / "score" / path.name
        assert score_path.exists(), f"{path.name} 경계는 있는데 score가 없다"
        score_codes = set(json.loads(
            score_path.read_text(encoding="utf-8"))["areas"])
        missing = boundary_codes - score_codes
        assert not missing, f"{path.name}: score에 없는 상권 {sorted(missing)[:5]}"


def test_json_is_parseable_by_strict_parsers():
    """json.dumps는 Infinity를 그대로 쓰는데 브라우저 JSON.parse는 거부한다.
    자치구 파일 하나가 통째로 안 열리고, 로컬 파이썬 테스트는 멀쩡히 통과한다."""
    def reject(value):
        raise AssertionError(f"JSON 표준 밖의 값: {value}")

    for path in WEB_DATA_DIR.rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"), parse_constant=reject)


def test_no_percentage_success_field_anywhere():
    """스펙 5.2 — % 성공확률은 데이터에조차 존재해선 안 된다."""
    for path in WEB_DATA_DIR.rglob("*.json"):
        text = path.read_text(encoding="utf-8")
        for banned in ("success_rate", "success_probability", "성공확률", "성공_확률"):
            assert banned not in text, f"{path.name}에 금지 필드 {banned}"


def test_each_gu_file_under_size_budget():
    for path in WEB_DATA_DIR.rglob("*.json"):
        assert path.stat().st_size < 3_000_000, f"{path} 과대 ({path.stat().st_size}B)"
