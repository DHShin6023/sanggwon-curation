"""파이프라인 엔트리포인트.

로컬에서도 CI(.github/workflows/quarterly-etl.yml)에서도 동일하게 돈다.
수집이 OpenAPI 경로라 자동화가 가능하다 — 인증키만 있으면 된다.

    set -a && . ./.env && set +a
    .venv/bin/python -m etl.build
"""
import json
from datetime import datetime, timezone

from etl.adapters import seoul
from etl.config import SEOUL_GU, WEB_DATA_DIR
from etl.engine import axes, patterns, scoring
from etl.geometry import boundary
from etl.sources import seoul_api

SOURCES = [
    "서울 열린데이터광장 상권분석서비스 (CC BY)",
    "카카오 로컬 API (주소 좌표 변환)",
]


def _label(period: str) -> str:
    return f"{period[:4]}년 {period[4]}분기"


def _write(path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False,
                               separators=(",", ":")), encoding="utf-8")


def main() -> None:
    data = seoul.normalize()
    assets = scoring.load_domain()

    axis_df = axes.score(data)
    scored = scoring.base_score(axis_df, assets)
    pattern_df = patterns.detect(axis_df, data.industries)

    merged = (scored
              .merge(pattern_df, on=["area_code", "industry_code"], how="left")
              .merge(data.industries[["area_code", "industry_code", "store_count",
                                      "sales_per_store", "sales_trend"]],
                     on=["area_code", "industry_code"], how="left"))
    cuts = scoring.grade_cuts(scored)

    area_meta = data.areas.set_index("area_code")
    buckets: dict[str, dict] = {gu: {"areas": {}} for gu in SEOUL_GU}

    # 조용히 버리지 않는다 — Task 3의 CoverageError와 같은 원칙(스펙 10.3).
    # 여기서 continue로 넘기면 상권 하나가 화면에서 통째로 사라지는데
    # 아무 흔적도 남지 않는다.
    unknown_area = sorted(set(merged["area_code"].astype(str)) - set(area_meta.index))
    if unknown_area:
        raise ValueError(f"areas에 없는 상권코드 {len(unknown_area)}개: {unknown_area[:5]}")
    stray_gu = sorted({str(g) for g in area_meta["gu_code"]} - set(buckets))
    if stray_gu:
        raise ValueError(f"SEOUL_GU 밖 자치구코드: {stray_gu}")

    for row in merged.itertuples():
        code = str(row.area_code)
        gu = str(area_meta.at[code, "gu_code"])
        info = area_meta.loc[code]
        bucket = buckets[gu]["areas"].setdefault(code, {
            "name": str(info["area_name"]),
            # 등급은 같은 상권종류 안에서만 매겨진다. 화면이 "골목상권 기준"임을
            # 밝히지 않으면 골목 "상"을 강남역급 매출로 오해한다(스펙 10.3).
            "area_type": str(info["area_type"]),
            "dong_code": str(info["dong_code"]),
            "footfall": _num(info["footfall"]),
            "resident_pop": _num(info["resident_pop"]),
            "household": _num(info["household"]),   # 스펙 7.1 배후세대
            "worker_pop": _num(info["worker_pop"]),
            "industries": {},
        })
        bucket["industries"][str(row.industry_code)] = {
            "base": _num(row.base_score),
            "store_count": int(row.store_count or 0),
            "sales_per_store": _num(row.sales_per_store),
            "sales_trend": _num(row.sales_trend),
            "patterns": list(row.patterns or []),
            # "경고 없음"과 "확인 못 함"은 다른 말이다. 합쳐서 내보내면 화면에서
            # 구분이 사라진다 — 침몰상권은 실제로 1,101행이 미평가다(Task 6).
            "patterns_unknown": list(row.patterns_unknown or []),
            # 표본이 얇은 풀은 순위 점수가 잡음이다(10행 미만 풀 18개).
            "pool_size": int(row.pool_size),
            "axes": {
                "resident": _num(row.demand_raw_resident),
                "worker": _num(row.demand_raw_worker),
                "footfall": _num(row.demand_raw_footfall),
                "competition": _num(row.competition),
                "vitality": _num(row.vitality),
                "fit": _num(row.fit),
            },
        }

    for gu, payload in buckets.items():
        if payload["areas"]:
            _write(WEB_DATA_DIR / "score" / f"{gu}.json", payload)

    for gu, payload in boundary.build().items():
        _write(WEB_DATA_DIR / "boundary" / f"{gu}.json", payload)

    # 행정동 폴백(🟡) — 상권 경계 밖 주소를 위한 최소 데이터.
    dong = seoul_api.load("dong_sales")
    dong = dong[dong["STDR_YYQU_CD"].astype(str) == data.period]
    dong_buckets: dict[str, dict] = {}
    for row in dong.itertuples():
        dong_code = str(row.ADSTRD_CD).zfill(8)
        gu = dong_code[:5]
        if gu not in SEOUL_GU:
            continue
        entry = dong_buckets.setdefault(gu, {"dongs": {}})["dongs"].setdefault(
            dong_code, {"industries": {}})
        entry["industries"][str(row.SVC_INDUTY_CD)] = {
            "sales_total": _num(row.THSMON_SELNG_AMT),
        }
    for gu, payload in dong_buckets.items():
        _write(WEB_DATA_DIR / "dong" / f"{gu}.json", payload)

    names = (data.industries[["industry_code", "industry_name"]]
             .drop_duplicates().sort_values("industry_code"))
    _write(WEB_DATA_DIR / "meta.json", {
        "period": data.period,
        "period_label": _label(data.period),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "region": data.region,
        "boundary_mode": boundary.MODE,
        "provisional": assets.provisional,
        "grade_cuts": cuts,
        "industries": [{"code": str(c), "name": str(n),
                        "group": assets.groups.get(str(c), "")}
                       for c, n in names.itertuples(index=False)],
        "gu": SEOUL_GU,
        "sources": SOURCES,
        "floor_basis": "heuristic",
    })

    print(f"빌드 완료 — {_label(data.period)}, 자치구 {len(buckets)}개"
          + (" ⚠️ provisional 도메인 자산 사용 중" if assets.provisional else ""))


def _num(value):
    """NaN을 JSON null로. 없는 값을 0으로 바꾸지 않는다."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if f != f else round(f, 4)


if __name__ == "__main__":
    main()
