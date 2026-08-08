import json

from etl.config import SEOUL_GU, WEB_DATA_DIR
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


def test_no_percentage_success_field_anywhere():
    """스펙 5.2 — % 성공확률은 데이터에조차 존재해선 안 된다."""
    for path in WEB_DATA_DIR.rglob("*.json"):
        text = path.read_text(encoding="utf-8")
        for banned in ("success_rate", "success_probability", "성공확률", "성공_확률"):
            assert banned not in text, f"{path.name}에 금지 필드 {banned}"


def test_each_gu_file_under_size_budget():
    for path in WEB_DATA_DIR.rglob("*.json"):
        assert path.stat().st_size < 3_000_000, f"{path} 과대 ({path.stat().st_size}B)"
