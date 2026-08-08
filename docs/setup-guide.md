# 착수 준비 — 신동환 작업 2건

Task 1을 막고 있는 것은 이제 **딱 2개**다. CSV 15개 다운로드는 필요 없어졌다.

> **왜 바뀌었나 (2026-08-08)**
> 서울 열린데이터광장 **OpenAPI로 필요한 8종을 전부 가져올 수 있음을 실측 확인**했다.
> 파일 다운로드만 세션 기반이라 자동화가 막혀 있었을 뿐, API 경로는 인증키만 있으면
> CI에서도 돈다. 총 호출량은 약 310회로 하루치 쿼터 안에 들어간다.

---

## ① 서울 OpenAPI 인증키 발급 ⚠️ 가장 시급

1. <https://data.seoul.go.kr> 접속 → 회원가입 / 로그인
2. 상단 메뉴에서 **`Open API`** → **`인증키 신청`**
   (또는 [Open API 소개](https://data.seoul.go.kr/together/guide/useGuide.do) 페이지의 안내 링크)
3. 신청서에 활용 목적을 적는다 — 예시:
   > 서울시 상권분석 데이터를 활용한 예비창업자용 출점지 적합도 분석 웹서비스 개발
4. 발급된 인증키를 아래처럼 `.env`에 넣는다

```bash
cd ~/Desktop/ClaudeWork/sanggwon-curation
echo "SEOUL_API_KEY=여기에_발급받은_키" > .env
```

`.env`는 `.gitignore` 대상이라 저장소에 올라가지 않는다.

### 키가 되는지 즉시 확인

```bash
set -a && . ./.env && set +a
curl -s "http://openapi.seoul.go.kr:8088/${SEOUL_API_KEY}/json/TbgisTrdarRelm/1/5/" | head -c 200
```

- `"CODE":"INFO-000"` → ✅ 통과
- `INFO-100` (인증키 오류) → 키가 잘못됐거나 아직 승인 전
- `ERROR-3xx` → 키 형식 문제

---

## ② 서울 상권영역 SHP 확인

**API로는 해결되지 않는 유일한 항목이다.** `TbgisTrdarRelm`(영역-상권) API를 실제로 호출해
확인한 결과, 제공 필드는 이것뿐이다:

```
TRDAR_CD, TRDAR_CD_NM, XCNTS_VALUE, YDNTS_VALUE,
SIGNGU_CD, SIGNGU_CD_NM, ADSTRD_CD, ADSTRD_CD_NM, RELM_AR
```

중심점(`XCNTS_VALUE`/`YDNTS_VALUE`)과 면적(`RELM_AR`)만 있고 **폴리곤 필드가 없다.**
(자치구코드·행정동코드가 들어 있는 건 좋은 소식 — 어댑터가 필요로 하던 값이다.)

### 확인 절차

1. [OA-15560 영역-상권 페이지](https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do) 접속
2. 첨부파일 목록에서 **`SHP`**, **`공간영역`**, **`공간정보`**, **`shape`** 가 붙은 항목을 찾는다
   (보통 `.zip`)
3. **있으면:** 받아서 압축을 풀고 `.shp` / `.dbf` / `.shx` / `.prj` **네 파일이 세트로**
   있는지 확인한 뒤 폴더째 `data/raw/seoul_area_shp/` 로 옮긴다
   (`.shp` 하나만 있으면 지리정보로 못 읽는다)
4. **없으면:** 없다고 알려주면 된다

### 왜 중요한가

이게 상권 매칭 로직의 형태를 결정한다.

| | 매칭 방식 | 정확도 |
|---|---|---|
| SHP 있음 | 실제 다각형 안팎 판정 (point-in-polygon) | 정확 |
| SHP 없음 | `반지름 = √(면적÷π)` 원 근사 | 도로를 따라 길쭉한 골목상권에서 경계 부근 오분류 |

계획에 두 경로가 모두 들어 있어서 **어느 쪽이든 진행에는 지장이 없다.**
다만 어느 쪽인지는 알아야 Task 3을 쓸 수 있다.

---

## 끝나면

```bash
cd ~/Desktop/ClaudeWork/sanggwon-curation
set -a && . ./.env && set +a
curl -s "http://openapi.seoul.go.kr:8088/${SEOUL_API_KEY}/json/TbgisTrdarRelm/1/5/" | head -c 120
ls -la data/raw/seoul_area_shp/ 2>/dev/null || echo "SHP 없음 → 원 근사 분기"
```

이 두 줄의 출력을 보여주면 바로 Task 1에 들어간다.

---

## 확인된 API 명세 (2026-08-08 실측)

- 호스트: `http://openapi.seoul.go.kr:8088`
- 형식: `/{인증키}/json/{서비스명}/{시작행}/{끝행}/{분기코드}/`
- **1회 최대 1,000행** (`끝행 - 시작행 ≤ 1000`)
- 샘플키 `sample` 은 5행까지 — 스키마 확인용

| 용도 | 서비스명 | 분기 필터 | 분기당 행수 |
|---|---|---|---|
| 추정매출-상권 | `VwsmTrdarSelngQq` | ✅ | ~21,200 |
| 점포-상권 | `VwsmTrdarStorQq` | ✅ | ~76,000 |
| 길단위인구-상권 | `VwsmTrdarFlpopQq` | ✅ | ~1,650 |
| 상주인구-상권 | `VwsmTrdarRepopQq` | ❌ 무시됨 | 전체 34,275 |
| 직장인구-상권 | `VwsmTrdarWrcPopltnQq` | ❌ 무시됨 | 전체 34,386 |
| 상권변화지표 | `VwsmTrdarIxQq` | ✅ | 1,650 |
| 추정매출-행정동 | `VwsmAdstrdSelngW` | ✅ | ~16,700 |
| 영역-상권 | `TbgisTrdarRelm` | — | 1,650 |

**필요 분기는 2개** (최신 + 4분기 전). `sales_trend`(전년 동분기 대비 증감) 계산에
둘 다 필요하고, 하나만 받으면 활력축이 통째로 빈다.

---

## 나중에 (지금 안 해도 됨)

- **⑤ 카카오 개발자 콘솔** — <https://developers.kakao.com> → 내 애플리케이션 →
  기존 `matzip-curation` 앱 → 플랫폼 > Web 에 도메인 추가로 무료 쿼터를 공유하는지 확인.
  Task 12(프록시)에서 필요하다.
- **⑦ 공공누리 유형** — 서울 열린데이터광장은 CC BY로 확인됨. 공개 배포 전 재확인.
