"""상권 경계 생성. 원본이 폴리곤(SHP)이므로 point-in-polygon 매칭용 링을 내보낸다.

실측(2026-08-08): 1,650개 도형(Polygon 1,561 + MultiPolygon 89), CRS는 .prj에서
EPSG:5181로 자동 인식됨. API의 상권코드와 100% 일치.

단순화 허용오차 실측(2026-08-08, EPSG:5181 투영좌표에서 측정):
  tol=0.0m(무단순화): 총 5.673MB, 자치구 최대 0.666MB, 점 이탈 0%
  tol=1.0m:           총 1.742MB, 자치구 최대 0.116MB, 점 이탈 0.16%
  tol=5.0m(브리프 원안): 총 1.169MB, 자치구 최대 0.066MB, 점 이탈 0.80%
무단순화만으로도 자치구당 2MB 상한을 이미 만족한다(최대 0.666MB). 5.0m은 점 이탈률이
1.0m의 5배인데 용량 절감 이득은 크지 않아(1.169MB vs 1.742MB, 둘 다 상한 대비 여유)
과한 허용오차로 판단, 1.0m로 낮췄다. 상세 수치는 docs/data-schema-report.md 참조.
(2026-08-08 리뷰에서 바이트 단위까지 독립 재현·인정됨 — 이 판단은 유지)

구멍(interior ring) 실측(2026-08-08 리뷰 발견): 1,650개 중 40개 상권에 구멍 41개,
가장 큰 것은 폴리곤 면적의 19.06%(상권코드 3110808). 외곽링만 내보내면 그 구멍
안의 주소가 point-in-polygon에서 "상권 내부"로 오판정되어 스펙 10.3(제품 정직성)을
위반한다. → rings는 GeoJSON MultiPolygon 좌표 구조로 낸다: part[0]=외곽링,
part[1:]=구멍. 소비 측(web/js/locate.js)은 "외곽 안 그리고 모든 구멍 밖"으로
판정해야 한다(Task 8, 아직 미구현).
"""
import geopandas as gpd

from etl.config import RAW_DIR, SEOUL_GU
from etl.adapters import seoul

MODE = "polygon"
SOURCE_CRS = "EPSG:5181"    # .prj가 없을 때만 쓰는 폴백. 실물에는 .prj가 있다
SIMPLIFY_TOLERANCE_M = 1.0  # 1m — 실측으로 5m 대비 점 이탈률을 5분의 1로 낮춤(위 주석 참조)

# ⚠️ Shapefile의 DBF는 컬럼명을 10자로 자른다(TRDAR_SE_CD → TRDAR_SE_C).
#    접두어로 찾으면 TRDAR_SE_C가 먼저 잡히므로 정확한 이름으로 지정한다.
CODE_COLUMN = "TRDAR_CD"


class CoverageError(RuntimeError):
    """상권 코드가 어댑터 또는 SEOUL_GU와 어긋나 조용히 버려질 뻔했을 때.

    스펙(10.3): 매칭 실패·누락은 조용히 채우지 말고 드러낸다. 3줄 위 CODE_COLUMN
    검사가 KeyError를 던지는 것과 같은 원칙 — seoul_api.SchemaError와 동일 계열.
    """


def build() -> dict[str, dict]:
    shp = next((RAW_DIR / "seoul_area_shp").glob("*.shp"))
    gdf = gpd.read_file(shp)
    if gdf.crs is None:
        gdf = gdf.set_crs(SOURCE_CRS)
    # 단순화는 투영좌표(EPSG:5181, 단위 m)에서 수행한 뒤 WGS84로 변환한다.
    # WGS84(도 단위)에서 미터 단위 허용오차를 주면 좌표가 지구 반바퀴만큼 뭉개진다.
    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True)
    gdf = gdf.to_crs("EPSG:4326")

    if CODE_COLUMN not in gdf.columns:
        raise KeyError(f"{CODE_COLUMN} 없음. 실제 컬럼: {list(gdf.columns)}")
    gdf["area_code"] = gdf[CODE_COLUMN].astype(str)

    meta = seoul.normalize().areas.set_index("area_code")
    buckets: dict[str, dict] = {}
    dropped: list[tuple[str, str]] = []   # 조용히 버리지 않는다 — 스펙: 누락을 드러낸다

    for _, row in gdf.iterrows():
        code = row["area_code"]
        if code not in meta.index:
            dropped.append((code, "어댑터에 없는 상권코드"))
            continue
        gu = str(meta.at[code, "gu_code"])
        if gu not in SEOUL_GU:
            dropped.append((code, f"SEOUL_GU 밖 자치구코드 {gu}"))
            continue
        geom = row.geometry
        polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
        # GeoJSON MultiPolygon 좌표 구조. part[0]=외곽링, part[1:]=구멍.
        # 구멍을 버리면 그 안의 주소가 상권 내부로 오판정된다 — 스펙 10.3 위반.
        rings = [
            [[[round(x, 6), round(y, 6)] for x, y in ring.coords]
             for ring in (p.exterior, *p.interiors)]
            for p in polys
        ]
        minx, miny, maxx, maxy = geom.bounds
        buckets.setdefault(gu, {"mode": MODE, "areas": []})["areas"].append({
            "code": code,
            "name": str(meta.at[code, "area_name"]),
            "bbox": [round(minx, 6), round(miny, 6), round(maxx, 6), round(maxy, 6)],
            "rings": rings,
        })

    if dropped:
        detail = "; ".join(f"{code}({reason})" for code, reason in dropped)
        raise CoverageError(
            f"상권 {len(dropped)}개가 자치구 버킷에서 조용히 빠질 뻔했다: {detail}"
        )

    return buckets
