# 데이터 스키마 실측 리포트

- 실측일: 2026-08-08
- 수집 경로: 서울 열린데이터광장 OpenAPI (`http://openapi.seoul.go.kr:8088`)
- 인증키: 일반 인증키 (2026-08-08 발급). **호출 횟수 제한 없음** — 1회 1,000행 제한만 있음

## 수집 결과

전량 수집 소요 **약 2분**, 캐시 22MB (`data/raw/*.parquet`).

| dataset | 서비스명 | 행수 | 필드수 | 분기 |
|---|---|---|---|---|
| `sales` | `VwsmTrdarSelngQq` | 42,615 | 55 | 20251, 20261 |
| `stores` | `VwsmTrdarStorQq` | 152,355 | 14 | 20251, 20261 |
| `footfall` | `VwsmTrdarFlpopQq` | 3,299 | 27 | 20251, 20261 |
| `resident` | `VwsmTrdarRepopQq` | 13,064 | 29 | 20242~20261 (필터 무시) |
| `worker` | `VwsmTrdarWrcPopltnQq` | 13,118 | 26 | 20242~20261 (필터 무시) |
| `change` | `VwsmTrdarIxQq` | 3,300 | 11 | 20251, 20261 |
| `dong_sales` | `VwsmAdstrdSelngW` | 33,429 | 53 | 20251, 20261 |
| `area` | `TbgisTrdarRelm` | 1,650 | 11 | (시점 없음) |

**최신 분기 = 20261.** 오늘(20263) 기준 2분기 전이며 게시 지연 범위 안이다.

## 확인된 필드

### area (`TbgisTrdarRelm`) — 11필드 전체
```
TRDAR_SE_CD, TRDAR_SE_CD_NM, TRDAR_CD, TRDAR_CD_NM,
XCNTS_VALUE, YDNTS_VALUE, SIGNGU_CD, SIGNGU_CD_NM,
ADSTRD_CD, ADSTRD_CD_NM, RELM_AR
```
- 중심점 `XCNTS_VALUE`/`YDNTS_VALUE` + 면적 `RELM_AR`. **폴리곤 없음**
- 자치구코드·행정동코드 내장 → 별도 매핑 불필요
- 좌표 예시: `201642 / 452260` → false easting 200000·northing 500000을 쓰는
  **EPSG:5181 추정** (Task 3에서 변환 결과로 확정)

### stores (`VwsmTrdarStorQq`)
```
STDR_YYQU_CD, TRDAR_SE_CD, TRDAR_SE_CD_NM, TRDAR_CD, TRDAR_CD_NM,
SVC_INDUTY_CD, SVC_INDUTY_CD_NM, SIMILR_INDUTY_STOR_CO, STOR_CO,
FRC_STOR_CO, OPBIZ_RT, OPBIZ_STOR_CO, CLSBIZ_RT, CLSBIZ_STOR_CO
```
`FRC_STOR_CO`(프랜차이즈 점포수)가 있어 스펙 7.1의 프랜차이즈 비중 지표가 가능하다.

### change (`VwsmTrdarIxQq`)
```
STDR_YYQU_CD, TRDAR_SE_CD, TRDAR_SE_CD_NM, TRDAR_CD, TRDAR_CD_NM,
TRDAR_CHNGE_IX, TRDAR_CHNGE_IX_NM, OPR_SALE_MT_AVRG, CLS_SALE_MT_AVRG,
SU_OPR_SALE_MT_AVRG, SU_CLS_SALE_MT_AVRG
```
`OPR_SALE_MT_AVRG`(운영 영업개월 평균) = 활력축 재료.

### resident (`VwsmTrdarRepopQq`) — 주요 필드
```
TOT_REPOP_CO, TOT_HSHLD_CO, APT_HSHLD_CO, NON_APT_HSHLD_CO, (연령·성별 분해 24종)
```
**`TOT_HSHLD_CO`(총 가구수) 존재** → 스펙 7.1 "배후세대" 지표 확보.

### sales / dong_sales (`VwsmTrdarSelngQq` / `VwsmAdstrdSelngW`)
```
THSMON_SELNG_AMT, THSMON_SELNG_CO,
MDWK_SELNG_AMT, WKEND_SELNG_AMT, (요일별 7종)
TMZON_{00_06,06_11,11_14,14_17,17_21,21_24}_SELNG_AMT
ML_SELNG_AMT, FML_SELNG_AMT,
AGRDE_{10,20,30,40,50}_SELNG_AMT, AGRDE_60_ABOVE_SELNG_AMT
(+ 위 전부의 _CO 건수 버전)
```
궁합축(요일·시간대·연령 구성) 재료가 전부 있다.

## 주의 — 표본 max로 최신 분기를 잡으면 안 된다

초기 구현은 `_call(service, 1, 1000, None)`의 첫 1,000행에서 `STDR_YYQU_CD` 최대값을
최신 분기로 삼았다. **API가 분기순으로 정렬해 주지 않아** 표본에 걸리는 분기가 데이터셋마다
달랐고, 실제로 `sales`가 **2022년 1분기**로, `dong_sales`가 2024년으로 잡혔다.
`stores`/`footfall`/`change`만 우연히 맞았다.

→ 오늘 분기부터 거꾸로 짚어 `list_total_count > 0`인 첫 분기를 찾는 방식
(`latest_period()`)으로 교체했고, `test_periods_are_latest_and_four_apart`가
「최신 + 4분기 전, 정확히 2개, 오늘로부터 3분기 이내」를 강제한다.

---

## SHP 분기 판정 — ✅ 분기 A 확정

- [x] **분기 A — 폴리곤 확보.** `data/raw/seoul_area_shp/seoul_area.{shp,dbf,shx,prj,cpg}`
      → Task 3은 폴리곤 경로(`point-in-polygon`)로 구현. `requirements-geo.txt` 설치 완료.
- [ ] ~~분기 B — 등가반경 원 근사~~ → 불필요

**판정일:** 2026-08-08
**출처:** [OA-15560](https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do)
파일내려받기 → `서울시상권분석서비스(영역-상권).zip` (2.07MB, 수정일 2023.10.23)

### 검증 결과

| 항목 | 결과 |
|---|---|
| 도형 | Polygon 1,561 + MultiPolygon 89 = **1,650개** |
| CRS | `.prj`에서 자동 인식 — **EPSG:5181** (Korea 2000 / Central Belt). 페이지 명시와 일치 |
| **상권코드 일치율** | **100.0%** — API `TbgisTrdarRelm` 1,650개와 완전 일치. 한쪽에만 있는 코드 0건 |
| 중심점 정합성 | 폴리곤 중심 vs API `XCNTS_VALUE`/`YDNTS_VALUE` 거리 **중앙값 0.4m** (95%tile 63m, 최대 295m — 오목한 형상에서 무게중심과 대표점이 벌어지는 정상 범위) |
| 인코딩 | UTF-8 (`.cpg`) |

파일 수정일이 2023년이라 「2026-07-03 표준단위구역 전환」으로 코드 체계가 어긋날
가능성을 우려했으나, **코드 일치율 100%로 문제없음이 확인됐다.**

### DBF 컬럼명 주의

Shapefile 규격상 DBF 컬럼명이 **10자로 잘린다.**

```
TRDAR_SE_C, TRDAR_SE_1, TRDAR_CD, TRDAR_CD_N, XCNTS_VALU,
YDNTS_VALU, SIGNGU_CD, SIGNGU_CD_, ADSTRD_CD, ADSTRD_CD_, RELM_AR
```

`TRDAR_CD`는 온전하지만 접두어 매칭(`startswith("TRDAR")`)으로 찾으면
`TRDAR_SE_C`가 먼저 잡힌다. **정확한 컬럼명으로 지정할 것.**
