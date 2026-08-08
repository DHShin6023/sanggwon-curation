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

## SHP 분기 판정

- [ ] **분기 A — 폴리곤 확보.** `data/raw/seoul_area_shp/` 에 `.shp`/`.dbf`/`.shx`/`.prj` 존재.
      → Task 3은 `_load_polygon()` 경로로 구현. `requirements-geo.txt` 설치 필요.
- [ ] **분기 B — 폴리곤 없음.** `TbgisTrdarRelm`의 중심점 + `RELM_AR`만 사용.
      → Task 3은 `_load_circle()` 경로로 구현. 등가반경 = √(면적/π).

판정일: ____
판정 근거: ____

**미확정 상태.** OA-15560 페이지의 SHP 첨부 유무를 신동환이 확인해야 한다.
API로는 해결되지 않음이 확정됐다 (`TbgisTrdarRelm` 11필드에 폴리곤 없음).
