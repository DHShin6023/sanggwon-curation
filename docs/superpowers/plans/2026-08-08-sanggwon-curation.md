# 상권 큐레이션 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주소·층수·업종을 입력하면 서울 상권 데이터로 적합도를 4단계 판정하고 근거와 대안 업종 1·2안을 제시하는 정적 웹서비스를 만든다.

**Architecture:** Python ETL이 서울 공공데이터를 어댑터로 정규화하고 상권×업종 단위 4축 점수·등급컷·패턴 플래그를 **사전 계산**해 자치구별 분할 JSON으로 떨군다. 브라우저는 그 JSON을 읽어 좌표→상권 매칭, 층수 계수 적용, 등급 판정, 대안 정렬만 수행한다(가벼운 산술). AI는 입구(업종 매핑)·출구(해설)에만 붙고 Cloudflare Workers 프록시 뒤에 숨으며, AI가 죽어도 템플릿 문장으로 서비스가 완결된다.

**Tech Stack:** Python 3.12 + pandas + pytest (ETL) / 빌드 스텝 없는 vanilla ES modules + `node --test` (웹) / Cloudflare Workers (프록시) / GitHub Pages (호스팅)

---

## Global Constraints

스펙 전체에 걸리는 제약이다. **모든 태스크의 요구사항에 이 절이 암묵적으로 포함된다.**

- **커버리지는 서울 단독.** 경기·타 광역시 코드를 미리 만들지 않는다. 단 어댑터 층 구조는 유지한다.
- **등급은 4단계: `상` / `중상` / `중하` / `하`.** 3단계로 줄이지 않는다. 문자열은 이 4개를 그대로 쓴다.
- **등급은 반드시 「동일 업종 안에서」 백분위로 매긴다.** 절대 점수로 등급을 매기지 않는다.
- **% 단위 성공 확률을 절대 출력하지 않는다.** 내부 점수(0~100)는 등급 산출용이며 화면에 %로 노출하지 않는다. 화면에 허용되는 유일한 백분위 표현은 `이 상권 <업종> 중 상위/하위 N%` 형태의 순위 표기다.
- **판정 자체에 LLM을 쓰지 않는다.** AI 호출 지점은 ①업종 자유입력→표준코드 매핑 ②판정 결과→해설 문장, 이 둘뿐이다. 각각 폴백(목록 선택 / 템플릿 문장)을 반드시 갖는다.
- **AI가 완전히 죽어도 판정은 정상 출력된다.** Task 11까지로 서비스가 기능적으로 완결되어야 하고, Task 12는 문장 품질만 개선한다.
- **층수는 5구간 고정:** `지하` / `1층` / `2층` / `3층이상` / `단독건물`. 코드 상수는 `B1`, `F1`, `F2`, `F3P`, `DETACHED`.
- **분석 정밀도 3표기:** `🟢 상권 단위 분석` / `🟡 행정동 단위 분석` / `🔴 분석 불가`. 상권 밖 주소에 인근 상권 데이터를 조용히 갖다 쓰는 것을 금지한다.
- **어떤 실패에서도 없는 데이터를 지어내지 않는다.** 결측은 결측으로 표기하고 해당 축을 판정에서 제외하거나 🔴로 떨어뜨린다.
- **층수 보정 계수는 도메인 휴리스틱이다.** 공공데이터에 층별 매출이 없다. 데이터 파일·코드 주석·화면 각주에 근거의 성격을 구분 표기한다.
- **데이터 기준 시점을 화면에 반드시 명시한다.** (예: `데이터 기준: 2026년 1분기`)
- **출처를 표기한다.** 서울 열린데이터광장은 CC BY이며 출처 표시가 의무다.
- **카카오 REST 키는 절대 프론트엔드 코드에 넣지 않는다.** 지오코딩은 Cloudflare Workers 프록시를 경유한다.
- **도메인 자산(업종그룹·가중치·층수계수·창업필터·KSIC매핑)은 코드가 아니라 `data/domain/*.json` 데이터 파일이다.** 튜닝 시 코드 수정·재배포 없이 교체 가능해야 한다.
- **잠정(provisional) 도메인 자산으로 공개 배포하지 않는다.** 시드 파일은 `"provisional": true`를 갖고, Task 13에서 신동환이 실제 값을 채운 뒤 `false`로 바꾼다.

---

## 파일 구조

```
sanggwon-curation/
├── etl/                              # Python — 사전 계산 파이프라인
│   ├── config.py                     # 경로 상수, 자치구 목록, 기준시점
│   ├── sources/seoul_api.py          # 서울 OpenAPI 수집 + 스키마 검증
│   ├── adapters/schema.py            # ★ 공통 지표 형식 (어댑터↔엔진 유일한 계약)
│   ├── adapters/seoul.py             # 서울 원본 → 공통 지표
│   ├── geometry/boundary.py          # 상권 경계: 폴리곤 or 등가반경 원 (분기 지점)
│   ├── engine/axes.py                # 4축 원점수
│   ├── engine/scoring.py             # 그룹 가중합 + 업종별 등급컷
│   ├── engine/patterns.py            # 패턴 감지 4종
│   ├── build.py                      # 파이프라인 엔트리포인트 → web/data/ 출력
│   └── tests/                        # pytest
├── data/
│   ├── raw/                          # API 응답 캐시 parquet + SHP (gitignore)
│   └── domain/                       # ★ 신동환 도메인 자산 (커밋됨)
│       ├── industry_groups.json
│       ├── axis_weights.json
│       ├── floor_coefficients.json
│       ├── startup_filter.json
│       └── ksic_map.json
├── web/                              # GitHub Pages 루트
│   ├── index.html
│   ├── css/style.css
│   ├── js/locate.js                  # 좌표 → 상권/행정동 매칭 + 정밀도 판정
│   ├── js/verdict.js                 # 층수 계수 적용 + 등급 판정 + 층수 경고
│   ├── js/alternatives.js            # 대안 업종 (필터 2겹)
│   ├── js/narrate.js                 # 템플릿 문장 + AI 해설 + 캐싱
│   ├── js/render.js                  # 화면 출력
│   ├── js/main.js                    # 입력 → 파이프라인 오케스트레이션
│   ├── tests/*.test.js               # node --test
│   └── data/                         # ★ ETL 산출물 (커밋됨)
│       ├── meta.json
│       ├── boundary/{구코드}.json
│       ├── score/{구코드}.json
│       └── dong/{구코드}.json
└── worker/src/index.js               # Cloudflare Workers 프록시 (카카오 + OpenRouter)
```

**책임 분리 원칙:** 무거운 계산(정규화·백분위·패턴)은 전부 Python ETL에 있고 브라우저는 곱셈 한 번과 배열 정렬만 한다. 유일하게 브라우저에만 있는 도메인 로직은 **층수 계수 적용**인데, 이는 사용자 입력에 의존해 사전 계산이 불가능하기 때문이다. 이 분리 덕분에 Python과 JS 사이에 중복 구현되는 로직이 없다.

---

## 실행 순서와 분기

```
Task 1 ─── 데이터 실물 확보 · 스키마 확인 ─── ★ 여기서 SHP 분기 확정
   │
   ├─ 분기 A (SHP 폴리곤 확보) ──┐
   └─ 분기 B (SHP 없음, 원 근사) ─┴─▶ Task 3에서 흡수, 이후 태스크는 동일
   │
Task 2 → 3 → 4 → 5 → 6 → 7        (ETL, Python)
   │
Task 8 → 9 → 10 → 11              (웹, AI 없이 서비스 완결)
   │
Task 12                            (AI 붙이기 — 품질 개선만)
   │
Task 13                            (검증 세트 대조 + 도메인 자산 확정)
```

**Task 1이 분기 지점이었고, 2026-08-08 SHP 실물 검증으로 분기 A(폴리곤)로 확정됐다.**
1,650개 폴리곤이 API 상권코드와 100% 일치함을 확인했다(`docs/data-schema-report.md`).
등가반경 원 근사 경로는 흐르는 데이터가 없어 계획에서 제거했다. Task 3 이후는 폴리곤 전용이다.

---

## Task 1: 프로젝트 뼈대 + 서울 OpenAPI 클라이언트 + 스키마 검증 (★ 분기 확정)

**Files:**
- Create: `etl/config.py`
- Create: `etl/sources/seoul_api.py`
- Create: `etl/tests/test_seoul_api.py`
- Create: `etl/requirements.txt`
- Create: `etl/requirements-geo.txt`
- Create: `docs/data-schema-report.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `etl.config.RAW_DIR: Path`, `etl.config.WEB_DATA_DIR: Path`, `etl.config.DOMAIN_DIR: Path`
  - `etl.config.SEOUL_GU: dict[str, str]` — 자치구코드 → 자치구명
  - `etl.sources.seoul_api.load(dataset, periods=None) -> pandas.DataFrame` — `dataset`은 `"sales"|"stores"|"footfall"|"resident"|"worker"|"area"|"change"|"dong_sales"`. 캐시가 있으면 캐시를, 없으면 API를 페이징 호출하고 `data/raw/{dataset}.parquet`에 저장한 뒤 반환
  - `etl.sources.seoul_api.SchemaError`, `etl.sources.seoul_api.SERVICES`, `etl.sources.seoul_api.REQUIRED_COLUMNS`
  - `docs/data-schema-report.md`의 **「SHP 분기 판정」** 절 — Task 3이 읽는다

### 데이터 수집 경로: 파일 다운로드가 아니라 OpenAPI

**2026-08-08 실측 확인.** 서울 열린데이터광장 OpenAPI로 필요한 8종을 전부 가져올 수 있다.
파일 다운로드는 세션 기반이라 자동화가 불가능하지만 **API는 인증키만 있으면 CI에서도 돈다.**

- 호스트: `http://openapi.seoul.go.kr:8088`
- 형식: `/{인증키}/json/{서비스명}/{시작행}/{끝행}/{필터...}`
- **1회 최대 1,000행.** `끝행 - 시작행 ≤ 1000`
- 샘플키 `sample`은 5행까지만 — 개발 중 스키마 확인에만 쓴다

| dataset | 서비스명 | 분기 필터 | 확인된 행수 |
|---|---|---|---|
| `sales` | `VwsmTrdarSelngQq` | ✅ | 전체 460,329 / 분기당 ~21,200 |
| `stores` | `VwsmTrdarStorQq` | ✅ | 전체 1,604,844 / 분기당 ~76,000 |
| `footfall` | `VwsmTrdarFlpopQq` | ✅ | 전체 34,633 / 분기당 ~1,650 |
| `resident` | `VwsmTrdarRepopQq` | ❌ **무시됨** | 전체 34,275 — 전량 받고 pandas에서 거른다 |
| `worker` | `VwsmTrdarWrcPopltnQq` | ❌ **무시됨** | 전체 34,386 — 동일 |
| `change` | `VwsmTrdarIxQq` | ✅ | 분기당 1,650 |
| `dong_sales` | `VwsmAdstrdSelngW` | ✅ | 분기당 ~16,700 |
| `area` | `TbgisTrdarRelm` | — (시점 없음) | 1,650 |

**필요 분기는 2개** — 최신 분기와 그 4분기 전. `sales_trend`(전년 동분기 대비 증감)를
계산하려면 둘 다 있어야 하고, 하나만 받으면 활력축이 통째로 결측이 된다.
**총 호출량 약 310회**로 하루치 쿼터 안에 들어간다.

### 사전 작업 — 신동환 수동 작업 (2건)

1. **API 인증키 발급** — <https://data.seoul.go.kr> 로그인 → Open API 인증키 신청.
   발급된 키를 `.env`에 `SEOUL_API_KEY=...` 로 넣는다 (`.gitignore` 대상).
2. **★ 서울 상권영역 SHP 확인** — [OA-15560](https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do)
   페이지에서 `SHP`/`공간영역`/`공간정보` 첨부가 있는지 본다.
   **API로는 해결되지 않는 유일한 항목이다** — `TbgisTrdarRelm`은 중심점(`XCNTS_VALUE`/
   `YDNTS_VALUE`)과 면적(`RELM_AR`)만 주고 폴리곤 필드가 없음을 실측으로 확인했다.
   있으면 받아서 `data/raw/seoul_area_shp/`에 `.shp/.dbf/.shx/.prj` 세트로 넣는다.

- [ ] **Step 1: 뼈대와 의존성 파일 생성**

```bash
cd ~/Desktop/ClaudeWork/sanggwon-curation
mkdir -p etl/sources etl/adapters etl/geometry etl/engine etl/tests
mkdir -p data/raw data/domain web/js web/tests web/css web/data worker/src scripts
touch etl/__init__.py etl/sources/__init__.py etl/adapters/__init__.py \
      etl/geometry/__init__.py etl/engine/__init__.py etl/tests/__init__.py
python3 -m venv .venv
```

`etl/requirements.txt`:
```
pandas==2.2.3
pyarrow==18.1.0
requests==2.32.3
pytest==8.3.4
```

`etl/requirements-geo.txt` (분기 A에서만 설치):
```
-r requirements.txt
geopandas==1.0.1
shapely==2.0.6
pyproj==3.7.0
```

`.gitignore`에 추가:
```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.env
```

```bash
.venv/bin/pip install -r etl/requirements.txt
```

- [ ] **Step 2: `etl/config.py` 작성**

```python
"""프로젝트 전역 경로·상수. 다른 모듈은 경로를 하드코딩하지 않고 여기서 가져온다."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
DOMAIN_DIR = ROOT / "data" / "domain"
WEB_DATA_DIR = ROOT / "web" / "data"

# 서울 25개 자치구. 서울시 상권 데이터의 자치구코드(행정표준코드 5자리) 기준.
SEOUL_GU = {
    "11110": "종로구", "11140": "중구",   "11170": "용산구", "11200": "성동구",
    "11215": "광진구", "11230": "동대문구", "11260": "중랑구", "11290": "성북구",
    "11305": "강북구", "11320": "도봉구", "11350": "노원구", "11380": "은평구",
    "11410": "서대문구", "11440": "마포구", "11470": "양천구", "11500": "강서구",
    "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
    "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구",
    "11740": "강동구",
}

# 층수 5구간 (스펙 6.1 고정)
FLOORS = ["B1", "F1", "F2", "F3P", "DETACHED"]
FLOOR_LABELS = {
    "B1": "지하", "F1": "1층", "F2": "2층",
    "F3P": "3층 이상", "DETACHED": "단독건물",
}

# 등급 4단계 (스펙 7.2 고정). 순서는 좋은 것부터.
GRADES = ["상", "중상", "중하", "하"]
```

- [ ] **Step 3: 인증키 확인**

```bash
echo "SEOUL_API_KEY=발급받은키" > .env
set -a && . ./.env && set +a
curl -s "http://openapi.seoul.go.kr:8088/${SEOUL_API_KEY}/json/TbgisTrdarRelm/1/5/" \
  | head -c 200
```
Expected: `"CODE":"INFO-000"`. `INFO-100`(인증키 오류)이나 `ERROR-3xx`가 나오면 키가 아직 승인 전이다.

- [ ] **Step 4: SHP 분기 판정을 리포트에 기록** *(2026-08-08 완료 — 분기 A)*

```bash
ls -la data/raw/seoul_area_shp/ 2>/dev/null || echo "SHP 없음"
```

`docs/data-schema-report.md` 끝에 아래 절을 추가하고 해당하는 쪽에 `[x]` 표시한다.

```markdown
## SHP 분기 판정

- [ ] **분기 A — 폴리곤 확보.** `data/raw/seoul_area_shp/` 에 `.shp`/`.dbf`/`.shx`/`.prj` 존재.
      → Task 3은 `_load_polygon()` 경로로 구현. `requirements-geo.txt` 설치 필요.
- [x] ~~분기 B — 폴리곤 없음. 등가반경 √(면적/π) 원 근사~~ → **불필요.** 분기 A 확정으로 제거

판정일: ____
판정 근거: ____
```

- [ ] **Step 5: 실패하는 테스트 작성**

`etl/tests/test_seoul_api.py`:
```python
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


def test_two_periods_present_for_trend():
    """sales_trend 계산에 최신 분기와 4분기 전이 모두 필요하다."""
    df = seoul_api.load("sales")
    assert df["STDR_YYQU_CD"].astype(str).nunique() >= 2
```

- [ ] **Step 6: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_seoul_api.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'etl.sources.seoul_api'`

- [ ] **Step 7: `etl/sources/seoul_api.py` 구현**

필드명은 2026-08-08 샘플키 호출로 **실측 확인한 값**이다. 추측이 아니다.

```python
"""서울 열린데이터광장 OpenAPI 수집기.

수집과 스키마 검증만 담당하고 가공은 하지 않는다 — 가공은 adapters/seoul.py의 책임.
받은 원본은 data/raw/{dataset}.parquet 에 캐시해 재호출을 피한다.
"""
import os
import time
from functools import lru_cache
from typing import Iterator

import pandas as pd
import requests

from etl.config import RAW_DIR

HOST = "http://openapi.seoul.go.kr:8088"
PAGE_SIZE = 1000          # API 하드 리밋: 끝행 - 시작행 <= 1000
NEEDED_PERIODS = 2        # 최신 분기 + 4분기 전


class SchemaError(RuntimeError):
    """API 응답에 기대한 필드가 없을 때. 스키마 변경을 조용히 넘기지 않기 위한 장치."""


SERVICES = {
    "sales": "VwsmTrdarSelngQq",
    "stores": "VwsmTrdarStorQq",
    "footfall": "VwsmTrdarFlpopQq",
    "resident": "VwsmTrdarRepopQq",
    "worker": "VwsmTrdarWrcPopltnQq",
    "change": "VwsmTrdarIxQq",
    "dong_sales": "VwsmAdstrdSelngW",
    "area": "TbgisTrdarRelm",
}

# 분기 필터(경로 끝에 STDR_YYQU_CD를 붙이는 방식)가 실제로 먹는지 여부.
# resident/worker는 필터를 줘도 전체 행수가 그대로여서 무시되는 것으로 확인됐다.
QUARTER_FILTER = {
    "sales": True, "stores": True, "footfall": True, "change": True,
    "dong_sales": True, "resident": False, "worker": False, "area": False,
}

REQUIRED_COLUMNS = {
    "sales": ["STDR_YYQU_CD", "TRDAR_CD", "SVC_INDUTY_CD", "SVC_INDUTY_CD_NM",
              "THSMON_SELNG_AMT", "MDWK_SELNG_AMT", "WKEND_SELNG_AMT",
              "TMZON_00_06_SELNG_AMT", "TMZON_21_24_SELNG_AMT",
              "AGRDE_10_SELNG_AMT", "AGRDE_60_ABOVE_SELNG_AMT"],
    "stores": ["STDR_YYQU_CD", "TRDAR_CD", "SVC_INDUTY_CD", "STOR_CO",
               "FRC_STOR_CO", "OPBIZ_RT", "CLSBIZ_RT"],
    "footfall": ["STDR_YYQU_CD", "TRDAR_CD", "TOT_FLPOP_CO"],
    "resident": ["STDR_YYQU_CD", "TRDAR_CD", "TOT_REPOP_CO", "TOT_HSHLD_CO"],
    "worker": ["STDR_YYQU_CD", "TRDAR_CD", "TOT_WRC_POPLTN_CO"],
    "change": ["STDR_YYQU_CD", "TRDAR_CD", "OPR_SALE_MT_AVRG", "TRDAR_CHNGE_IX"],
    "dong_sales": ["STDR_YYQU_CD", "ADSTRD_CD", "SVC_INDUTY_CD", "THSMON_SELNG_AMT"],
    "area": ["TRDAR_CD", "TRDAR_CD_NM", "XCNTS_VALUE", "YDNTS_VALUE",
             "SIGNGU_CD", "ADSTRD_CD", "RELM_AR"],
}


def page_ranges(total: int, size: int = PAGE_SIZE) -> Iterator[tuple[int, int]]:
    """1-based 폐구간 페이지. API는 끝행 - 시작행 <= 1000만 허용한다."""
    start = 1
    while start <= total:
        yield start, min(start + size - 1, total)
        start += size


def _key() -> str:
    key = os.environ.get("SEOUL_API_KEY")
    if not key:
        raise RuntimeError(
            "SEOUL_API_KEY 없음. data.seoul.go.kr 에서 인증키를 발급받아 .env 에 넣는다."
        )
    return key


def _call(service: str, start: int, end: int, period: str | None) -> dict:
    url = f"{HOST}/{_key()}/json/{service}/{start}/{end}/"
    if period:
        url += f"{period}/"
    for attempt in range(3):
        try:
            res = requests.get(url, timeout=60)
            res.raise_for_status()
            body = res.json()
        except (requests.RequestException, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
            continue
        if service not in body:
            raise SchemaError(f"{service} 호출 실패: {body.get('RESULT', body)}")
        return body[service]
    raise SchemaError(f"{service} 재시도 소진")


def _recent_periods(service: str) -> list[str]:
    """최신 분기와 그 4분기 전. 최신값은 API에서 직접 확인한다."""
    probe = _call(service, 1, 1000, None)
    latest = max(str(r["STDR_YYQU_CD"]) for r in probe["row"])
    year, quarter = int(latest[:4]), int(latest[4])
    total = year * 4 + (quarter - 1) - 4
    return [latest, f"{total // 4}{total % 4 + 1}"]


def _fetch(dataset: str) -> pd.DataFrame:
    service = SERVICES[dataset]
    periods = _recent_periods(service) if QUARTER_FILTER[dataset] else [None]
    rows: list[dict] = []

    for period in periods:
        head = _call(service, 1, 1, period)
        total = int(head["list_total_count"])
        for start, end in page_ranges(total):
            rows.extend(_call(service, start, end, period)["row"])
            time.sleep(0.1)   # 서버 예의

    return pd.DataFrame(rows)


@lru_cache(maxsize=None)
def load(dataset: str) -> pd.DataFrame:
    if dataset not in SERVICES:
        raise ValueError(f"알 수 없는 데이터셋: {dataset}. 가능: {sorted(SERVICES)}")

    cache = RAW_DIR / f"{dataset}.parquet"
    if cache.exists():
        df = pd.read_parquet(cache)
    else:
        df = _fetch(dataset)
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        df.to_parquet(cache, index=False)

    missing = [c for c in REQUIRED_COLUMNS[dataset] if c not in df.columns]
    if missing:
        raise SchemaError(
            f"{dataset}({SERVICES[dataset]}) 필수 필드 누락: {missing}\n"
            f"실제 필드: {list(df.columns)}"
        )

    # resident/worker는 분기 필터가 무시되므로 여기서 최신 2개 분기만 남긴다.
    if "STDR_YYQU_CD" in df.columns and not QUARTER_FILTER[dataset]:
        keep = sorted(df["STDR_YYQU_CD"].astype(str).unique())[-NEEDED_PERIODS * 4:]
        df = df[df["STDR_YYQU_CD"].astype(str).isin(keep)]

    return df.reset_index(drop=True)
```

- [ ] **Step 8: 수집 실행 및 테스트 통과 확인**

```bash
set -a && . ./.env && set +a
.venv/bin/python -c "
from etl.sources import seoul_api
for name in seoul_api.SERVICES:
    df = seoul_api.load(name)
    print(f'{name:12s} {len(df):>8,}행  {len(df.columns):>2}필드')
"
.venv/bin/python -m pytest etl/tests/test_seoul_api.py -v
```
Expected: 8 passed. 첫 실행은 API를 때리므로 수 분 걸리고, 이후로는 `data/raw/*.parquet` 캐시에서 즉시 읽는다. 다시 받으려면 캐시를 지운다.

`INFO-200`(데이터 없음)이 뜨면 해당 분기가 아직 게시되지 않은 것이다 — `_recent_periods`가 최신값을 API에서 직접 읽으므로 자동으로 맞춰진다.

- [ ] **Step 9: 커밋**

```bash
git add etl/ docs/data-schema-report.md .gitignore
git commit -m "feat(etl): 서울 OpenAPI 수집기 + 스키마 검증, SHP 분기 판정 기록"
```

---

## Task 2: 공통 지표 스키마 + 서울 어댑터

**Files:**
- Create: `etl/adapters/schema.py`
- Create: `etl/adapters/seoul.py`
- Create: `etl/tests/test_seoul_adapter.py`

**Interfaces:**
- Consumes: `etl.sources.seoul_api.load()`, `etl.config.SEOUL_GU`
- Produces:
  - `etl.adapters.schema.AREA_COLUMNS: list[str]` — 상권 단위 지표의 컬럼 계약
  - `etl.adapters.schema.INDUSTRY_COLUMNS: list[str]` — 상권×업종 단위 지표의 컬럼 계약
  - `etl.adapters.schema.Normalized` — 위 둘을 담는 컨테이너 (`areas: pd.DataFrame`, `industries: pd.DataFrame`, `period: str`, `region: str`)
  - `etl.adapters.seoul.normalize() -> Normalized`

  > **행 단위 dataclass(`AreaRow`/`IndustryRow`)는 만들지 않는다.** 초안에 남아 있던
  > 항목이나 엔진은 DataFrame 단위로 백분위·groupby 연산을 하므로 행 객체를 쓸 곳이 없다.
  > 계약은 컬럼 목록 상수로 표현하고 `.reindex(columns=...)`로 강제한다.

**이 태스크의 산출물이 어댑터와 엔진 사이의 유일한 계약이다.** 이후 어떤 엔진 코드도 `상권_코드` 같은 서울 원본 컬럼명을 알아서는 안 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`etl/tests/test_seoul_adapter.py`:
```python
import pandas as pd

from etl.adapters import seoul
from etl.adapters.schema import AREA_COLUMNS, INDUSTRY_COLUMNS


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
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_seoul_adapter.py -v
```
Expected: FAIL — `ModuleNotFoundError: etl.adapters.schema`

- [ ] **Step 3: `etl/adapters/schema.py` 구현**

```python
"""어댑터와 판정 엔진 사이의 유일한 계약.

이 파일을 바꾼다는 것은 계약을 바꾼다는 뜻이다. 어댑터(서울, 향후 경기 등)와
엔진 양쪽을 모두 검토해야 한다. 스펙 10.1 참조.
"""
from dataclasses import dataclass

import pandas as pd

# 상권 단위 지표 — 업종과 무관한 것들
AREA_COLUMNS = [
    "area_code",      # str  상권 코드
    "area_name",      # str  상권명
    "gu_code",        # str  자치구코드 5자리
    "dong_code",      # str  행정동코드 8자리
    "x",              # float 중심점 X (원본 투영좌표)
    "y",              # float 중심점 Y
    "area_size",      # float 영역면적 (m²)
    "resident_pop",   # float 상주인구
    "household",      # float 총 가구수 — 스펙 7.1 "배후세대"
    "worker_pop",     # float 직장인구
    "footfall",       # float 유동인구
]

# 상권 × 업종 단위 지표
INDUSTRY_COLUMNS = [
    "area_code",
    "industry_code",       # str  서울 CS코드
    "industry_name",       # str
    "store_count",         # int
    "sales_total",         # float 분기 추정매출 총액
    "sales_per_store",     # float ★ 스펙 7.1 핵심 파생지표
    "sales_trend",         # float 최근 4분기 매출 증감률 (-1.0 ~ )
    "store_delta",         # int   최근 4분기 점포수 증감
    "close_rate",          # float 폐업률
    "open_rate",           # float 개업률
    "avg_months",          # float 평균 영업개월
    # 궁합축 재료 — 비중 벡터 (행 합 = 1)
    "time_00_06", "time_06_11", "time_11_14",
    "time_14_17", "time_17_21", "time_21_24",
    "age_10", "age_20", "age_30", "age_40", "age_50", "age_60p",
    "weekday_ratio",       # float 주중 매출 비중 (주말 비중 = 1 - 이 값)
]

TIME_COLUMNS = [c for c in INDUSTRY_COLUMNS if c.startswith("time_")]
AGE_COLUMNS = [c for c in INDUSTRY_COLUMNS if c.startswith("age_")]


@dataclass(frozen=True)
class Normalized:
    """어댑터의 출력. 엔진은 이것만 받는다."""
    areas: pd.DataFrame        # AREA_COLUMNS
    industries: pd.DataFrame   # INDUSTRY_COLUMNS
    period: str                # "20261" 형식 (년4자리 + 분기1자리)
    region: str                # "seoul"
```

- [ ] **Step 4: `etl/adapters/seoul.py` 구현**

```python
"""서울 원본 → 공통 지표 형식. 서울 스키마 지식은 이 파일 안에만 존재한다.

필드명은 2026-08-08 OpenAPI 실호출로 확인한 값이다.
"""
import pandas as pd

from etl.adapters.schema import (AREA_COLUMNS, INDUSTRY_COLUMNS, Normalized)
from etl.sources import seoul_api

_PERIOD = "STDR_YYQU_CD"
_AREA = "TRDAR_CD"

_TIME_SRC = {
    "time_00_06": "TMZON_00_06_SELNG_AMT", "time_06_11": "TMZON_06_11_SELNG_AMT",
    "time_11_14": "TMZON_11_14_SELNG_AMT", "time_14_17": "TMZON_14_17_SELNG_AMT",
    "time_17_21": "TMZON_17_21_SELNG_AMT", "time_21_24": "TMZON_21_24_SELNG_AMT",
}
_AGE_SRC = {
    "age_10": "AGRDE_10_SELNG_AMT", "age_20": "AGRDE_20_SELNG_AMT",
    "age_30": "AGRDE_30_SELNG_AMT", "age_40": "AGRDE_40_SELNG_AMT",
    "age_50": "AGRDE_50_SELNG_AMT", "age_60p": "AGRDE_60_ABOVE_SELNG_AMT",
}


def _shift_quarters(period: str, back: int) -> str:
    year, q = int(period[:4]), int(period[4])
    total = year * 4 + (q - 1) - back
    return f"{total // 4}{total % 4 + 1}"


def _at(df: pd.DataFrame, period: str) -> pd.DataFrame:
    return df[df[_PERIOD].astype(str) == period]


def _num(series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def _to_share(df: pd.DataFrame, mapping: dict[str, str]) -> pd.DataFrame:
    """금액 필드들을 행 합 1의 비중 벡터로. 합이 0이면 균등 분배(정보 없음)."""
    out = pd.DataFrame(index=df.index)
    for target, source in mapping.items():
        out[target] = _num(df.get(source, 0)).fillna(0.0)
    total = out.sum(axis=1)
    return out.div(total.where(total > 0), axis=0).fillna(1.0 / len(mapping))


def normalize() -> Normalized:
    sales = seoul_api.load("sales")
    period = str(sales[_PERIOD].astype(str).max())
    prev = _shift_quarters(period, 4)

    cur, old = _at(sales, period).copy(), _at(sales, prev)
    stores = seoul_api.load("stores")
    stores_cur, stores_old = _at(stores, period), _at(stores, prev)

    # ── 상권 단위 ──
    area = seoul_api.load("area")
    areas = pd.DataFrame({
        "area_code": area[_AREA].astype(str),
        "area_name": area["TRDAR_CD_NM"].astype(str),
        "gu_code": area["SIGNGU_CD"].astype(str).str.zfill(5),
        "dong_code": area["ADSTRD_CD"].astype(str).str.zfill(8),
        "x": _num(area["XCNTS_VALUE"]),
        "y": _num(area["YDNTS_VALUE"]),
        "area_size": _num(area["RELM_AR"]),
    })

    for target, dataset, field in (
        ("resident_pop", "resident", "TOT_REPOP_CO"),
        ("household", "resident", "TOT_HSHLD_CO"),
        ("worker_pop", "worker", "TOT_WRC_POPLTN_CO"),
        ("footfall", "footfall", "TOT_FLPOP_CO"),
    ):
        src = seoul_api.load(dataset)
        src = _at(src, period)
        if src.empty:   # 상주인구는 반기 갱신이라 해당 분기가 없을 수 있다
            src = seoul_api.load(dataset)
            src = _at(src, str(src[_PERIOD].astype(str).max()))
        agg = src.assign(_v=_num(src[field])).groupby(
            src[_AREA].astype(str))["_v"].sum().rename(target)
        areas = areas.merge(agg, left_on="area_code", right_index=True, how="left")

    areas = areas.reindex(columns=AREA_COLUMNS)

    # ── 상권 × 업종 단위 ──
    ind = pd.DataFrame({
        "area_code": cur[_AREA].astype(str),
        "industry_code": cur["SVC_INDUTY_CD"].astype(str),
        "industry_name": cur["SVC_INDUTY_CD_NM"].astype(str),
        "sales_total": _num(cur["THSMON_SELNG_AMT"]).fillna(0.0),
    }, index=cur.index)

    def _pair(df: pd.DataFrame) -> pd.MultiIndex:
        return pd.MultiIndex.from_arrays(
            [df[_AREA].astype(str), df["SVC_INDUTY_CD"].astype(str)])

    keys = pd.MultiIndex.from_arrays([ind["area_code"], ind["industry_code"]])

    sc = pd.Series(_num(stores_cur["STOR_CO"]).values, index=_pair(stores_cur))
    ind["store_count"] = keys.map(sc).astype("float").fillna(0).astype(int)
    ind["sales_per_store"] = (
        ind["sales_total"].div(ind["store_count"].where(ind["store_count"] > 0)).fillna(0.0))

    old_sales = pd.Series(_num(old["THSMON_SELNG_AMT"]).values, index=_pair(old))
    old_sales = old_sales.groupby(level=[0, 1]).sum()
    prev_sales = keys.map(old_sales).astype("float")
    ind["sales_trend"] = (ind["sales_total"] / prev_sales - 1.0).where(prev_sales > 0)

    old_sc = pd.Series(_num(stores_old["STOR_CO"]).values, index=_pair(stores_old))
    ind["store_delta"] = (ind["store_count"] - keys.map(old_sc).astype("float")
                          ).fillna(0).astype(int)

    for target, field in (("close_rate", "CLSBIZ_RT"), ("open_rate", "OPBIZ_RT")):
        src = pd.Series(_num(stores_cur[field]).values, index=_pair(stores_cur))
        # 원본이 백분율(0~100)이므로 비율(0~1)로 맞춘다
        ind[target] = keys.map(src).astype("float") / 100.0

    change = _at(seoul_api.load("change"), period)
    months = pd.Series(_num(change["OPR_SALE_MT_AVRG"]).values,
                       index=change[_AREA].astype(str))
    ind["avg_months"] = ind["area_code"].map(months).astype("float")

    ind = pd.concat([ind, _to_share(cur, _TIME_SRC).set_axis(ind.index),
                     _to_share(cur, _AGE_SRC).set_axis(ind.index)], axis=1)

    weekday, weekend = _num(cur["MDWK_SELNG_AMT"]).fillna(0.0), _num(cur["WKEND_SELNG_AMT"]).fillna(0.0)
    both = weekday + weekend
    ind["weekday_ratio"] = weekday.div(both.where(both > 0)).fillna(0.5).values

    industries = ind.reindex(columns=INDUSTRY_COLUMNS).reset_index(drop=True)
    return Normalized(areas=areas, industries=industries, period=period, region="seoul")
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_seoul_adapter.py -v
```
Expected: 6 passed. 컬럼명 불일치로 실패하면 `_AREA_MAP`/`_TIME_SRC`/`_AGE_SRC`와 원본 컬럼 참조 문자열을 Task 1 리포트 실측값으로 교체한다.

- [ ] **Step 6: 커밋**

```bash
git add etl/adapters/ etl/tests/test_seoul_adapter.py
git commit -m "feat(etl): 공통 지표 계약 스키마 + 서울 어댑터"
```

---

## Task 3: 상권 경계 — 폴리곤/원 분기

**Files:**
- Create: `etl/geometry/boundary.py`
- Create: `etl/tests/test_boundary.py`

**Interfaces:**
- Consumes: `etl.sources.seoul_api.load("area")`, `etl.adapters.seoul.normalize()`
- Produces:
  - `etl.geometry.boundary.build() -> dict[str, dict]` — 자치구코드 → 브라우저에 그대로 내려갈 경계 JSON.
    반환 형태는 분기와 무관하게 아래 둘 중 하나이며, `mode` 필드로 구분한다.
    ```jsonc
    {"mode": "polygon", "areas": [{"code": "3110001", "name": "...",
      "bbox": [minLng, minLat, maxLng, maxLat],
      // GeoJSON MultiPolygon 좌표 구조: parts[i][0]=외곽링, parts[i][1:]=구멍
      "rings": [[ [[lng,lat],...],  [[lng,lat],...] ], [ [[lng,lat],...] ]]}]}
    ```

  > **구멍(interior ring)을 반드시 담는다.** 실측상 1,650개 중 40개 상권에 구멍
  > 41개가 있고 큰 것은 폴리곤 면적의 19%에 달한다. 외곽링만 내보내면 그 구멍
  > 안의 주소가 상권 내부로 오판정되어 🟢 상권 단위 분석을 거짓으로 표기한다.
  - `etl.geometry.boundary.MODE: str` — `"polygon"`

**★ 이 태스크가 Task 1의 분기를 흡수했고, 결과는 폴리곤이다.** 출력 JSON은 `"mode": "polygon"` 하나만 존재한다.

- [ ] **Step 1: 분기와 무관한 테스트 작성**

`etl/tests/test_boundary.py`:
```python
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
            lng, lat = area["rings"][0][0][0]
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


def _all_rings(area):
    """rings는 GeoJSON MultiPolygon 좌표 구조다: parts[i][0]=외곽, parts[i][1:]=구멍."""
    return [ring for part in area["rings"] for ring in part]


def test_rings_are_closed():
    """point-in-polygon은 닫힌 링을 전제한다."""
    for payload in boundary.build().values():
        for area in payload["areas"]:
            for ring in _all_rings(area):
                assert len(ring) >= 4
                assert ring[0] == ring[-1], f"{area['code']} 링이 닫히지 않음"


def test_bbox_contains_rings():
    """bbox 프리필터가 실제 링을 감싸야 한다. 어긋나면 매칭이 조용히 실패한다."""
    for payload in boundary.build().values():
        for area in payload["areas"]:
            min_lng, min_lat, max_lng, max_lat = area["bbox"]
            for ring in _all_rings(area):
                for lng, lat in ring:
                    assert min_lng <= lng <= max_lng and min_lat <= lat <= max_lat


def test_holes_are_preserved():
    """구멍을 버리면 그 안의 주소가 상권 내부로 오판정된다.
    실측: 1,650개 중 40개 상권에 구멍 41개, 최대 폴리곤 면적의 19%."""
    with_holes = [a for p in boundary.build().values() for a in p["areas"]
                  if any(len(part) > 1 for part in a["rings"])]
    assert len(with_holes) == 40, f"구멍 있는 상권 {len(with_holes)}개 — 40개여야 한다"


def test_no_area_silently_dropped():
    """코드 불일치로 상권이 조용히 사라지면 안 된다 (스펙: 누락을 드러낸다)."""
    total = sum(len(p["areas"]) for p in boundary.build().values())
    assert total == 1650
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_boundary.py -v
```
Expected: FAIL — `ModuleNotFoundError: etl.geometry.boundary`

- [ ] **Step 3: 좌표계 실측 (두 분기 공통, 먼저 수행)**

원본 좌표계를 추측하면 상권이 통째로 엉뚱한 곳에 찍힌다. 후보를 넣어보고 서울 안에 떨어지는 것을 고른다.

서울 상권 좌표는 `XCNTS_VALUE≈201642`, `YDNTS_VALUE≈452260` 형태로 실측됐다.
false easting 200000 / northing 500000을 쓰는 **EPSG:5181(중부원점 2000)로 추정**되나
추정으로 두지 않고 변환 결과가 서울 안에 떨어지는지로 확정한다.

```bash
.venv/bin/pip install pyproj==3.7.0
.venv/bin/python - <<'PY'
from pyproj import Transformer
from etl.sources import seoul_api
row = seoul_api.load("area").iloc[0]
x, y = float(row["XCNTS_VALUE"]), float(row["YDNTS_VALUE"])
print("원본:", x, y, "/", row["TRDAR_CD_NM"])
for epsg in (5181, 5179, 5186, 5174, 4326):
    try:
        lng, lat = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326",
                                        always_xy=True).transform(x, y)
    except Exception as exc:
        print(f"EPSG:{epsg} 변환 실패 {exc}"); continue
    ok = "  ✅ 서울" if 126.7 < lng < 127.3 and 37.4 < lat < 37.7 else ""
    print(f"EPSG:{epsg} -> {lng:.6f}, {lat:.6f}{ok}")
PY
```

✅가 붙은 EPSG 코드를 `docs/data-schema-report.md`에 기록하고 다음 Step의 `SOURCE_CRS`에 넣는다.

- [ ] **Step 4: `etl/geometry/boundary.py` 구현**

> **분기 A(폴리곤) 확정** — 2026-08-08 SHP 실물 검증 완료(`docs/data-schema-report.md`).
> 등가반경 원 근사 분기는 사문화되어 계획에서 제거했다.

```bash
.venv/bin/pip install -r etl/requirements-geo.txt
```

```python
"""상권 경계 생성. 원본이 폴리곤(SHP)이므로 point-in-polygon 매칭용 링을 내보낸다.

실측(2026-08-08): 1,650개 도형(Polygon 1,561 + MultiPolygon 89), CRS는 .prj에서
EPSG:5181로 자동 인식됨. API의 상권코드와 100% 일치.
"""
import geopandas as gpd

from etl.config import RAW_DIR, SEOUL_GU
from etl.adapters import seoul

MODE = "polygon"
SOURCE_CRS = "EPSG:5181"    # .prj가 없을 때만 쓰는 폴백. 실물에는 .prj가 있다
SIMPLIFY_TOLERANCE_M = 5.0  # 5m — 상권 매칭 정확도에 영향 없고 용량은 크게 준다

# ⚠️ Shapefile의 DBF는 컬럼명을 10자로 자른다(TRDAR_SE_CD → TRDAR_SE_C).
#    접두어로 찾으면 TRDAR_SE_C가 먼저 잡히므로 정확한 이름으로 지정한다.
CODE_COLUMN = "TRDAR_CD"


def build() -> dict[str, dict]:
    shp = next((RAW_DIR / "seoul_area_shp").glob("*.shp"))
    gdf = gpd.read_file(shp)
    if gdf.crs is None:
        gdf = gdf.set_crs(SOURCE_CRS)
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
    return buckets
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_boundary.py -v
```
Expected: 8 passed

- [ ] **Step 6: 커밋**

```bash
git add etl/geometry/ etl/tests/test_boundary.py etl/requirements-geo.txt docs/data-schema-report.md
git commit -m "feat(etl): 상권 경계 폴리곤 생성 + 자치구 분할"
```

---

## Task 4: 4축 점수 산출

**Files:**
- Create: `etl/engine/axes.py`
- Create: `etl/tests/test_axes.py`

**Interfaces:**
- Consumes: `etl.adapters.schema.Normalized`, `AGE_COLUMNS`, `TIME_COLUMNS`
- Produces:
  - `etl.engine.axes.score(data: Normalized) -> pd.DataFrame` — 컬럼:
    `area_code, industry_code, demand_raw_resident, demand_raw_worker, demand_raw_footfall, competition, vitality, fit`
    - `demand_raw_*` 3개는 **각각 0~100 백분위**이며 합성하지 않는다. 업종그룹 가중치가 Task 5에서 이 셋을 섞는다 (스펙 7.1 "업종마다 중요한 인구가 다르다").
    - `competition`, `vitality`, `fit`은 0~100 백분위. 클수록 좋다.
  - `etl.engine.axes.percentile(series: pd.Series) -> pd.Series` — 0~100, 결측은 결측 유지

- [ ] **Step 1: 실패하는 테스트 작성**

`etl/tests/test_axes.py`:
```python
import numpy as np
import pandas as pd
import pytest

from etl.adapters.schema import AGE_COLUMNS, INDUSTRY_COLUMNS, TIME_COLUMNS, Normalized
from etl.engine import axes


def _fixture() -> Normalized:
    """4개 상권 × 2개 업종의 최소 픽스처. 값은 순위가 명확하도록 넣는다."""
    area_rows = []
    for i, code in enumerate(["A", "B", "C", "D"]):
        area_rows.append({
            "area_code": code, "area_name": f"상권{code}", "gu_code": "11440",
            "dong_code": "11440510", "x": 0.0, "y": 0.0, "area_size": 10000.0,
            "resident_pop": 100 * (i + 1),
            "household": 40 * (i + 1),
            "worker_pop": 100 * (4 - i),
            "footfall": 1000 * (i + 1),
        })
    ind_rows = []
    for i, code in enumerate(["A", "B", "C", "D"]):
        for ind in ["CS100001", "CS200001"]:
            row = {c: 0.0 for c in INDUSTRY_COLUMNS}
            row.update({
                "area_code": code, "industry_code": ind, "industry_name": ind,
                "store_count": i + 1,
                "sales_total": 1_000_000.0 * (i + 1),
                "sales_per_store": 1_000_000.0,       # 동일 → 순위 무차별
                "sales_trend": 0.1 * i,
                "store_delta": i, "close_rate": 0.1 * (3 - i), "open_rate": 0.1,
                "avg_months": 12.0 * (i + 1), "weekday_ratio": 0.5,
            })
            for c in TIME_COLUMNS:
                row[c] = 1.0 / len(TIME_COLUMNS)
            for c in AGE_COLUMNS:
                row[c] = 1.0 / len(AGE_COLUMNS)
            ind_rows.append(row)
    return Normalized(
        areas=pd.DataFrame(area_rows),
        industries=pd.DataFrame(ind_rows)[INDUSTRY_COLUMNS],
        period="20261", region="seoul",
    )


def test_percentile_spans_zero_to_hundred():
    out = axes.percentile(pd.Series([1, 2, 3, 4]))
    assert out.min() == pytest.approx(0.0)
    assert out.max() == pytest.approx(100.0)


def test_percentile_preserves_missing():
    out = axes.percentile(pd.Series([1.0, np.nan, 3.0]))
    assert out.isna().sum() == 1


def test_demand_axes_are_not_merged():
    """수요축은 3개 원점수로 남아야 한다. 미리 합치면 업종별 가중이 불가능해진다."""
    out = axes.score(_fixture())
    for col in ("demand_raw_resident", "demand_raw_worker", "demand_raw_footfall"):
        assert col in out.columns
    assert "demand" not in out.columns


def test_all_axes_bounded():
    out = axes.score(_fixture())
    cols = ["demand_raw_resident", "demand_raw_worker", "demand_raw_footfall",
            "competition", "vitality", "fit"]
    values = out[cols].to_numpy(dtype=float)
    assert np.nanmin(values) >= 0.0 and np.nanmax(values) <= 100.0


def test_competition_rewards_higher_sales_per_store():
    """점포당매출이 높을수록 경쟁축 점수가 높아야 한다 (스펙 7.1)."""
    data = _fixture()
    data.industries.loc[data.industries["area_code"] == "A", "sales_per_store"] = 9_000_000.0
    data.industries.loc[data.industries["area_code"] == "D", "sales_per_store"] = 100_000.0
    out = axes.score(data).set_index(["area_code", "industry_code"])
    assert out.at[("A", "CS100001"), "competition"] > out.at[("D", "CS100001"), "competition"]


def test_vitality_penalises_high_close_rate():
    data = _fixture()
    out = axes.score(data).set_index(["area_code", "industry_code"])
    # 픽스처에서 close_rate는 A가 가장 높고 D가 가장 낮다
    assert out.at[("D", "CS100001"), "vitality"] > out.at[("A", "CS100001"), "vitality"]


def test_fit_is_percentile_of_profile_similarity():
    """상권 소비 프로필과 업종 전국 프로필이 어긋날수록 궁합이 낮아야 한다."""
    data = _fixture()
    ind = data.industries
    # A상권 CS100001만 심야 편중으로 비틀어 놓는다
    mask = (ind["area_code"] == "A") & (ind["industry_code"] == "CS100001")
    for c in TIME_COLUMNS:
        ind.loc[mask, c] = 0.0
    ind.loc[mask, "time_21_24"] = 1.0
    out = axes.score(data).set_index(["area_code", "industry_code"])
    others = [out.at[(a, "CS100001"), "fit"] for a in ("B", "C", "D")]
    assert out.at[("A", "CS100001"), "fit"] <= min(others)


def test_row_count_preserved():
    data = _fixture()
    assert len(axes.score(data)) == len(data.industries)
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_axes.py -v
```
Expected: FAIL — `ModuleNotFoundError: etl.engine.axes`

- [ ] **Step 3: `etl/engine/axes.py` 구현**

```python
"""4축 원점수 산출. 스펙 7.1.

전 축을 「전체 상권 대비 백분위(0~100, 클수록 좋음)」로 통일한다.
단위가 다른 지표(명, 원, 개월, %)를 그대로 더할 수 없기 때문이다.

수요축만은 3개 인구를 합치지 않고 따로 내보낸다. 업종마다 중요한 인구가
다르므로(카페=유동, 세탁편의점=배후세대, 국밥집=직장) 합성은 업종그룹
가중치를 아는 scoring.py의 몫이다.
"""
import numpy as np
import pandas as pd

from etl.adapters.schema import AGE_COLUMNS, TIME_COLUMNS, Normalized

OUTPUT_COLUMNS = [
    "area_code", "industry_code",
    "demand_raw_resident", "demand_raw_worker", "demand_raw_footfall",
    "competition", "vitality", "fit",
]


def percentile(series: pd.Series) -> pd.Series:
    """0~100 백분위. 결측은 결측으로 남긴다 — 없는 값을 평균으로 채우지 않는다."""
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().sum() <= 1:
        return pd.Series(np.where(numeric.notna(), 50.0, np.nan), index=series.index)
    return numeric.rank(pct=True, na_option="keep") * 100.0


def _cosine(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    na = np.linalg.norm(a, axis=1)
    nb = np.linalg.norm(b, axis=1)
    denom = na * nb
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(denom > 0, (a * b).sum(axis=1) / denom, np.nan)


def score(data: Normalized) -> pd.DataFrame:
    ind = data.industries.copy()
    areas = data.areas.set_index("area_code")

    # ── ① 수요: 3개 인구를 각각 백분위. 합성하지 않는다 ──
    demand = pd.DataFrame(index=areas.index)
    for target, source in (("demand_raw_resident", "resident_pop"),
                           ("demand_raw_worker", "worker_pop"),
                           ("demand_raw_footfall", "footfall")):
        demand[target] = percentile(areas[source])
    out = ind[["area_code", "industry_code"]].copy()
    out = out.join(demand, on="area_code")

    # ── ② 경쟁: 점포당매출(↑) + 배후 대비 점포밀도(↓) ──
    by_industry = ind.groupby("industry_code", group_keys=False)
    sales_rank = by_industry["sales_per_store"].apply(percentile)

    backing = areas["resident_pop"].fillna(0) + areas["worker_pop"].fillna(0)
    density = ind["store_count"] / ind["area_code"].map(backing).replace(0, np.nan)
    density_rank = 100.0 - ind.assign(_d=density).groupby(
        "industry_code", group_keys=False)["_d"].apply(percentile)
    out["competition"] = (sales_rank * 0.6 + density_rank * 0.4)

    # ── ③ 활력: 매출추세(↑) + 폐업률(↓) + 평균영업개월(↑) + 점포증감(↓) ──
    trend_rank = by_industry["sales_trend"].apply(percentile)
    close_rank = 100.0 - by_industry["close_rate"].apply(percentile)
    months_rank = percentile(ind["avg_months"])
    delta_rank = 100.0 - by_industry["store_delta"].apply(percentile)
    vitality = pd.concat([trend_rank * 0.35, close_rank * 0.30,
                          months_rank * 0.20, delta_rank * 0.15], axis=1)
    # 결측 축은 빼고 남은 가중치로 재정규화한다 — 없는 값을 0점으로 취급하지 않는다
    weights = pd.DataFrame({c: (0.35, 0.30, 0.20, 0.15)[i]
                            for i, c in enumerate(vitality.columns)},
                           index=vitality.index).where(vitality.notna())
    out["vitality"] = vitality.sum(axis=1, min_count=1) / weights.sum(axis=1)

    # ── ④ 궁합: 상권 소비 프로필 vs 업종의 서울 전체 프로필 코사인 유사도 ──
    profile_cols = TIME_COLUMNS + AGE_COLUMNS
    weighted = ind[profile_cols].mul(ind["sales_total"], axis=0)

    area_profile = weighted.groupby(ind["area_code"]).sum()
    area_profile = area_profile.div(area_profile.sum(axis=1).replace(0, np.nan), axis=0)

    ind_profile = weighted.groupby(ind["industry_code"]).sum()
    ind_profile = ind_profile.div(ind_profile.sum(axis=1).replace(0, np.nan), axis=0)

    sim = _cosine(
        area_profile.reindex(ind["area_code"]).to_numpy(dtype=float),
        ind_profile.reindex(ind["industry_code"]).to_numpy(dtype=float),
    )
    out["fit"] = ind.assign(_s=sim).groupby(
        "industry_code", group_keys=False)["_s"].apply(percentile)

    return out.reindex(columns=OUTPUT_COLUMNS).reset_index(drop=True)
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_axes.py -v
```
Expected: 8 passed

- [ ] **Step 5: 커밋**

```bash
git add etl/engine/axes.py etl/tests/test_axes.py
git commit -m "feat(engine): 4축 원점수 산출 (수요축은 3개 인구 분리 유지)"
```

---

## Task 5: 도메인 자산 + 가중합 + 업종별 등급컷

**Files:**
- Create: `data/domain/industry_groups.json`
- Create: `data/domain/axis_weights.json`
- Create: `data/domain/floor_coefficients.json`
- Create: `etl/engine/scoring.py`
- Create: `etl/tests/test_scoring.py`
- Create: `scripts/seed_domain.py`

**Interfaces:**
- Consumes: `etl.engine.axes.score()` 출력, `etl.config.DOMAIN_DIR`, `etl.config.GRADES`
- Produces:
  - `etl.engine.scoring.load_domain() -> DomainAssets` — `groups: dict[str,str]`, `weights: dict[str,dict]`, `floors: dict[str,dict]`, `provisional: bool`
  - `etl.engine.scoring.base_score(axis_df, assets) -> pd.DataFrame` — `+ base_score` 컬럼 (0~100, **층수 미적용**)
  - `etl.engine.scoring.grade_cuts(scored) -> dict[str, list[float]]` — 업종코드 → `[상컷, 중상컷, 중하컷]` (base_score 기준 75/50/25 분위)
  - `etl.engine.scoring.grade_of(score: float, cuts: list[float]) -> str`

**핵심 설계 — 층수를 왜 여기서 곱하지 않는가:** 층수는 사용자 입력이라 사전 계산이 불가능하다. 따라서 ETL은 **층수 미적용 base_score와 업종별 등급컷**만 만들고, 브라우저가 `base_score × 층수계수`를 컷에 대보는 구조로 간다(Task 9). 등급컷이 층수 미적용 분포 기준이므로 "2층 카페"는 같은 자리의 "1층 카페"보다 반드시 낮은 등급이 나오며, 이는 스펙 7.5의 의도와 정확히 일치한다.

- [ ] **Step 1: 시드 생성 스크립트 작성**

실제 값은 신동환이 Task 13에서 채운다. 그때까지 파이프라인이 돌아가야 하므로 **잠정 시드**를 만든다.

`scripts/seed_domain.py`:
```python
"""도메인 자산 잠정 시드 생성.

⚠️ 여기서 나오는 값은 전부 placeholder이며 판정 품질에 아무 의미가 없다.
provisional=true 인 동안에는 절대 공개 배포하지 않는다.
실제 값 작성 주체는 신동환(도메인 전문가)이다 — 스펙 7.4.
"""
import json
import sys

sys.path.insert(0, ".")
from etl.adapters import seoul          # noqa: E402
from etl.config import DOMAIN_DIR, FLOORS  # noqa: E402

GROUP_IDS = ["유동의존형", "배후의존형", "직장의존형", "목적방문형",
             "생활서비스형", "야간업종형"]

def main() -> None:
    DOMAIN_DIR.mkdir(parents=True, exist_ok=True)
    ind = seoul.normalize().industries
    codes = sorted(ind[["industry_code", "industry_name"]]
                   .drop_duplicates().itertuples(index=False), key=lambda r: r[0])

    (DOMAIN_DIR / "industry_groups.json").write_text(json.dumps({
        "provisional": True,
        "_note": "모든 업종을 유동의존형에 몰아넣은 잠정값. 신동환이 6~8개 그룹으로 배정할 것.",
        "groups": GROUP_IDS,
        "assignment": {c: {"name": n, "group": "유동의존형"} for c, n in codes},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (DOMAIN_DIR / "axis_weights.json").write_text(json.dumps({
        "provisional": True,
        "_note": "전 그룹 동일 가중 잠정값. 그룹별 차등이 이 서비스의 핵심 자산이다.",
        "weights": {g: {
            "resident": 0.15, "worker": 0.10, "footfall": 0.15,
            "competition": 0.25, "vitality": 0.20, "fit": 0.15,
        } for g in GROUP_IDS},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (DOMAIN_DIR / "floor_coefficients.json").write_text(json.dumps({
        "provisional": True,
        "basis": "heuristic",
        "_note": ("공공데이터에 층별 매출이 존재하지 않는다. 이 계수는 데이터 산출값이 "
                  "아니라 도메인 휴리스틱이며 화면에 그 성격을 표기한다 — 스펙 7.5."),
        "warn_below": 0.75,
        "coefficients": {g: {f: 1.0 for f in FLOORS} for g in GROUP_IDS},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"시드 생성 완료: 업종 {len(codes)}개, 그룹 {len(GROUP_IDS)}개")


if __name__ == "__main__":
    main()
```

```bash
.venv/bin/python scripts/seed_domain.py
```

- [ ] **Step 2: 실패하는 테스트 작성**

`etl/tests/test_scoring.py`:
```python
import pandas as pd
import pytest

from etl.config import FLOORS, GRADES
from etl.engine import scoring


def _axis_df() -> pd.DataFrame:
    return pd.DataFrame({
        "area_code": ["A", "B", "C", "D"] * 2,
        "industry_code": ["CS1"] * 4 + ["CS2"] * 4,
        "demand_raw_resident": [10, 40, 70, 100] * 2,
        "demand_raw_worker": [100, 70, 40, 10] * 2,
        "demand_raw_footfall": [10, 40, 70, 100] * 2,
        "competition": [20, 40, 60, 80] * 2,
        "vitality": [20, 40, 60, 80] * 2,
        "fit": [20, 40, 60, 80] * 2,
    })


def _assets():
    return scoring.DomainAssets(
        groups={"CS1": "유동의존형", "CS2": "배후의존형"},
        weights={
            "유동의존형": {"resident": 0.0, "worker": 0.0, "footfall": 0.4,
                        "competition": 0.3, "vitality": 0.2, "fit": 0.1},
            "배후의존형": {"resident": 0.4, "worker": 0.0, "footfall": 0.0,
                        "competition": 0.3, "vitality": 0.2, "fit": 0.1},
        },
        floors={"유동의존형": {f: 1.0 for f in FLOORS},
                "배후의존형": {f: 1.0 for f in FLOORS}},
        provisional=True,
    )


def test_load_domain_reads_all_three_files():
    assets = scoring.load_domain()
    assert assets.groups and assets.weights and assets.floors
    assert isinstance(assets.provisional, bool)


def test_every_industry_has_a_group():
    assets = scoring.load_domain()
    assert all(g in assets.weights for g in assets.groups.values())


def test_floor_table_covers_all_five_floors():
    assets = scoring.load_domain()
    for group, table in assets.floors.items():
        assert set(table) == set(FLOORS), f"{group} 층수 구간 불완전"


def test_weights_sum_to_one():
    for group, w in scoring.load_domain().weights.items():
        assert sum(w.values()) == pytest.approx(1.0, abs=1e-6), group


def test_base_score_uses_group_specific_demand():
    """같은 축 값이어도 그룹이 다르면 점수가 달라야 한다 — 이게 안 되면 서비스가 무의미하다."""
    out = scoring.base_score(_axis_df(), _assets()).set_index(["area_code", "industry_code"])
    assert out.at[("A", "CS1"), "base_score"] != out.at[("A", "CS2"), "base_score"]


def test_base_score_bounded():
    out = scoring.base_score(_axis_df(), _assets())
    assert out["base_score"].between(0, 100).all()


def test_grade_cuts_are_per_industry():
    scored = scoring.base_score(_axis_df(), _assets())
    cuts = scoring.grade_cuts(scored)
    assert set(cuts) == {"CS1", "CS2"}
    assert all(len(v) == 3 for v in cuts.values())
    assert all(v[0] >= v[1] >= v[2] for v in cuts.values())


def test_grade_of_returns_four_levels():
    cuts = [75.0, 50.0, 25.0]
    assert scoring.grade_of(90.0, cuts) == "상"
    assert scoring.grade_of(60.0, cuts) == "중상"
    assert scoring.grade_of(30.0, cuts) == "중하"
    assert scoring.grade_of(10.0, cuts) == "하"
    assert set(GRADES) == {"상", "중상", "중하", "하"}


def test_missing_axis_does_not_zero_the_score():
    """결측 축은 0점 취급이 아니라 가중치 재정규화로 처리한다."""
    df = _axis_df()
    df.loc[0, "fit"] = None
    out = scoring.base_score(df, _assets())
    assert out.loc[0, "base_score"] > 0
```

- [ ] **Step 3: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_scoring.py -v
```
Expected: FAIL — `ModuleNotFoundError: etl.engine.scoring`

- [ ] **Step 4: `etl/engine/scoring.py` 구현**

```python
"""업종그룹 가중합 + 업종별 등급컷. 스펙 7.2 / 7.4.

층수 계수는 여기서 곱하지 않는다. 사용자 입력이라 사전계산이 불가능하고,
브라우저(web/js/verdict.js)가 base_score에 곱해 등급컷과 대조한다.
"""
import json
from dataclasses import dataclass

import numpy as np
import pandas as pd

from etl.config import DOMAIN_DIR, GRADES

AXIS_KEYS = {
    "resident": "demand_raw_resident",
    "worker": "demand_raw_worker",
    "footfall": "demand_raw_footfall",
    "competition": "competition",
    "vitality": "vitality",
    "fit": "fit",
}


@dataclass(frozen=True)
class DomainAssets:
    groups: dict[str, str]              # 업종코드 → 그룹명
    weights: dict[str, dict[str, float]]  # 그룹명 → {축키: 가중치}
    floors: dict[str, dict[str, float]]   # 그룹명 → {층수코드: 계수}
    provisional: bool


def load_domain() -> DomainAssets:
    def read(name: str) -> dict:
        return json.loads((DOMAIN_DIR / name).read_text(encoding="utf-8"))

    g, w, f = read("industry_groups.json"), read("axis_weights.json"), read("floor_coefficients.json")
    return DomainAssets(
        groups={code: item["group"] for code, item in g["assignment"].items()},
        weights=w["weights"],
        floors=f["coefficients"],
        provisional=any(x.get("provisional", False) for x in (g, w, f)),
    )


def base_score(axis_df: pd.DataFrame, assets: DomainAssets) -> pd.DataFrame:
    """층수 미적용 가중합 (0~100). 결측 축은 가중치에서 빼고 재정규화한다."""
    out = axis_df.copy()
    group = out["industry_code"].map(assets.groups)

    total = pd.Series(0.0, index=out.index)
    weight_sum = pd.Series(0.0, index=out.index)

    for key, column in AXIS_KEYS.items():
        w = group.map(lambda g: assets.weights.get(g, {}).get(key, 0.0)).astype(float)
        value = pd.to_numeric(out[column], errors="coerce")
        present = value.notna()
        total += (value.fillna(0.0) * w).where(present, 0.0)
        weight_sum += w.where(present, 0.0)

    out["base_score"] = (total / weight_sum.replace(0, np.nan)).clip(0, 100)
    return out


def grade_cuts(scored: pd.DataFrame) -> dict[str, list[float]]:
    """업종별 75/50/25 분위. 스펙 7.2 — 등급은 반드시 동일 업종 안에서 매긴다."""
    cuts: dict[str, list[float]] = {}
    for code, group in scored.groupby("industry_code"):
        s = group["base_score"].dropna()
        if s.empty:
            continue
        cuts[str(code)] = [round(float(s.quantile(q)), 4) for q in (0.75, 0.50, 0.25)]
    return cuts


def grade_of(score: float, cuts: list[float]) -> str:
    """cuts = [상컷, 중상컷, 중하컷]"""
    if score is None or (isinstance(score, float) and np.isnan(score)):
        raise ValueError("점수 없이 등급을 매기지 않는다")
    for boundary, grade in zip(cuts, GRADES):
        if score >= boundary:
            return grade
    return GRADES[-1]
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_scoring.py -v
```
Expected: 9 passed

- [ ] **Step 6: 커밋**

```bash
git add data/domain/ etl/engine/scoring.py etl/tests/test_scoring.py scripts/seed_domain.py
git commit -m "feat(engine): 업종그룹 가중합 + 업종별 등급컷, 도메인 자산 잠정 시드"
```

---

## Task 6: 패턴 감지

**Files:**
- Create: `etl/engine/patterns.py`
- Create: `etl/tests/test_patterns.py`

**Interfaces:**
- Consumes: `etl.engine.axes.score()` 출력 + `Normalized.industries` (원지표)
- Produces:
  - `etl.engine.patterns.detect(axis_df, industries) -> pd.DataFrame` — `area_code, industry_code, patterns: list[str]`
  - `etl.engine.patterns.PATTERNS: tuple[str, ...]` = `("함정상권", "침몰상권", "포화", "블루오션")`

패턴은 점수와 **독립된 레이어**다(스펙 7.3). 등급 계산에 섞지 않는다 — 평균에 묻히면 안 되는 정보이기 때문이다. `블루오션`은 Task 10 대안 추천의 신호로 그대로 재사용된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`etl/tests/test_patterns.py`:
```python
import pandas as pd

from etl.adapters.schema import INDUSTRY_COLUMNS
from etl.engine import patterns


def _frames(**overrides):
    axis = pd.DataFrame({
        "area_code": ["A"], "industry_code": ["CS1"],
        "demand_raw_resident": [50.0], "demand_raw_worker": [50.0],
        "demand_raw_footfall": [50.0], "competition": [50.0],
        "vitality": [50.0], "fit": [50.0],
    })
    row = {c: 0.0 for c in INDUSTRY_COLUMNS}
    row.update({"area_code": "A", "industry_code": "CS1", "industry_name": "테스트",
                "store_count": 10, "sales_total": 1e8, "sales_per_store": 1e7,
                "sales_trend": 0.0, "store_delta": 0, "close_rate": 0.05,
                "open_rate": 0.05, "avg_months": 36.0})
    for key, value in overrides.items():
        if key in axis.columns:
            axis[key] = value
        else:
            row[key] = value
    return axis, pd.DataFrame([row])[INDUSTRY_COLUMNS]


def _detect(**overrides) -> list[str]:
    axis, ind = _frames(**overrides)
    return patterns.detect(axis, ind).loc[0, "patterns"]


def test_pattern_names_are_fixed():
    assert patterns.PATTERNS == ("함정상권", "침몰상권", "포화", "블루오션")


def test_trap_area_detected():
    """유동 상위 + 점포당매출 하위 → 함정 상권"""
    assert "함정상권" in _detect(demand_raw_footfall=95.0, competition=10.0)


def test_trap_area_not_detected_when_sales_healthy():
    assert "함정상권" not in _detect(demand_raw_footfall=95.0, competition=80.0)


def test_sinking_area_detected():
    """매출 하락 + 폐업률 상승 + 점포수 증가 → 침몰 상권"""
    assert "침몰상권" in _detect(sales_trend=-0.15, close_rate=0.20, store_delta=3)


def test_sinking_needs_all_three_conditions():
    assert "침몰상권" not in _detect(sales_trend=-0.15, close_rate=0.20, store_delta=-2)


def test_saturation_detected():
    assert "포화" in _detect(competition=3.0)


def test_blue_ocean_detected():
    """배후 충분 + 경쟁 하위 → 블루오션 (대안 추천의 핵심 신호)"""
    assert "블루오션" in _detect(demand_raw_resident=90.0, competition=85.0, store_count=1)


def test_normal_area_has_no_pattern():
    assert _detect() == []


def test_output_row_count_matches_input():
    axis, ind = _frames()
    assert len(patterns.detect(axis, ind)) == len(axis)
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_patterns.py -v
```
Expected: FAIL — `ModuleNotFoundError: etl.engine.patterns`

- [ ] **Step 3: `etl/engine/patterns.py` 구현**

```python
"""패턴 감지. 스펙 7.3.

점수 평균에 묻히면 안 되는 조합 신호를 별도 레이어로 잡는다.
등급 계산에는 관여하지 않는다.
"""
import numpy as np
import pandas as pd

PATTERNS = ("함정상권", "침몰상권", "포화", "블루오션")

# 임계값. 백분위(0~100) 기준이며 조정 시 스펙 7.3 표와 함께 검토한다.
FOOTFALL_HIGH = 80.0        # 유동 상위
COMPETITION_LOW = 30.0      # 점포당매출·밀도 하위
SATURATION_TOP = 5.0        # 점포밀도 상위 5% → competition 하위 5%
BACKING_HIGH = 70.0         # 배후 충분
COMPETITION_HIGH = 70.0     # 경쟁 여유
BLUE_OCEAN_MAX_STORES = 5   # 이미 점포가 많으면 블루오션이 아니다
SALES_DROP = -0.05          # 매출 -5% 이하
CLOSE_RATE_HIGH = 0.10      # 폐업률 10% 이상


def detect(axis_df: pd.DataFrame, industries: pd.DataFrame) -> pd.DataFrame:
    merged = axis_df.merge(
        industries[["area_code", "industry_code", "store_count",
                    "sales_trend", "close_rate", "store_delta"]],
        on=["area_code", "industry_code"], how="left",
    )

    footfall = pd.to_numeric(merged["demand_raw_footfall"], errors="coerce")
    resident = pd.to_numeric(merged["demand_raw_resident"], errors="coerce")
    worker = pd.to_numeric(merged["demand_raw_worker"], errors="coerce")
    comp = pd.to_numeric(merged["competition"], errors="coerce")
    trend = pd.to_numeric(merged["sales_trend"], errors="coerce")
    close = pd.to_numeric(merged["close_rate"], errors="coerce")
    delta = pd.to_numeric(merged["store_delta"], errors="coerce")
    stores = pd.to_numeric(merged["store_count"], errors="coerce")

    backing = pd.concat([resident, worker], axis=1).max(axis=1)

    flags = pd.DataFrame({
        "함정상권": (footfall >= FOOTFALL_HIGH) & (comp <= COMPETITION_LOW),
        "침몰상권": (trend <= SALES_DROP) & (close >= CLOSE_RATE_HIGH) & (delta > 0),
        "포화": comp <= SATURATION_TOP,
        "블루오션": ((backing >= BACKING_HIGH) & (comp >= COMPETITION_HIGH)
                  & (stores <= BLUE_OCEAN_MAX_STORES)),
    }).fillna(False)

    merged["patterns"] = [
        [name for name in PATTERNS if row[name]] for _, row in flags.iterrows()
    ]
    return merged[["area_code", "industry_code", "patterns"]]
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
.venv/bin/python -m pytest etl/tests/ -v
```
Expected: 전체 통과 (Task 1~6 누적 32 passed)

- [ ] **Step 5: 커밋**

```bash
git add etl/engine/patterns.py etl/tests/test_patterns.py
git commit -m "feat(engine): 패턴 감지 4종 (점수와 독립 레이어)"
```

---

## Task 7: 빌드 파이프라인 + 출력 JSON + 신선도 검사 워크플로

**Files:**
- Create: `etl/build.py`
- Create: `etl/tests/test_build.py`
- Create: `.github/workflows/data-freshness.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 2~6 전부
- Produces (`web/data/` 하위, 브라우저가 fetch하는 최종 계약):
  - `meta.json` — `{"period", "period_label", "generated_at", "region", "provisional", "grade_cuts", "industries": [{code, name, group}], "gu": {코드: 이름}, "sources": [...]}`
  - `boundary/{구코드}.json` — Task 3 출력 그대로
  - `score/{구코드}.json` — `{"areas": {상권코드: {"name", "dong_code", "footfall", "resident_pop", "worker_pop", "industries": {업종코드: {"base": float, "store_count": int, "sales_per_store": float, "sales_trend": float|null, "patterns": [str], "axes": {...}}}}}}`
  - `dong/{구코드}.json` — 행정동 폴백용 동일 구조 (🟡 표기용)
  - `etl.build.main() -> None`

- [ ] **Step 1: 실패하는 테스트 작성**

`etl/tests/test_build.py`:
```python
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
    assert {"name", "industries"}.issubset(area)
    entry = next(iter(area["industries"].values()))
    assert {"base", "store_count", "patterns"}.issubset(entry)
    assert isinstance(entry["patterns"], list)


def test_no_percentage_success_field_anywhere():
    """스펙 5.2 — % 성공확률은 데이터에조차 존재해선 안 된다."""
    for path in WEB_DATA_DIR.rglob("*.json"):
        text = path.read_text(encoding="utf-8")
        for banned in ("success_rate", "success_probability", "성공확률", "성공_확률"):
            assert banned not in text, f"{path.name}에 금지 필드 {banned}"


def test_each_gu_file_under_size_budget():
    for path in WEB_DATA_DIR.rglob("*.json"):
        assert path.stat().st_size < 3_000_000, f"{path} 과대 ({path.stat().st_size}B)"
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
.venv/bin/python -m pytest etl/tests/test_build.py -v
```
Expected: FAIL — `ModuleNotFoundError: etl.build`

- [ ] **Step 3: `etl/build.py` 구현**

```python
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

    for row in merged.itertuples():
        code = str(row.area_code)
        if code not in area_meta.index:
            continue
        gu = str(area_meta.at[code, "gu_code"])
        if gu not in buckets:
            continue
        info = area_meta.loc[code]
        bucket = buckets[gu]["areas"].setdefault(code, {
            "name": str(info["area_name"]),
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
```

- [ ] **Step 4: 행정동 폴백 출력 추가**

`main()`의 자치구 루프 뒤에 삽입한다. 상권 밖 주소(🟡)를 위한 최소 데이터다.

```python
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
```

파일 상단에 `from etl.sources import seoul_api`를 추가한다.

- [ ] **Step 5: 빌드 실행 및 테스트 통과 확인**

```bash
.venv/bin/python -m etl.build
.venv/bin/python -m pytest etl/tests/test_build.py -v
du -sh web/data/
```
Expected: 6 passed. `web/data/` 총합이 30MB를 넘으면 GitHub Pages에서 느려진다 — 넘으면 `score` 파일에서 `axes` 하위 항목을 소수점 1자리로 줄인다.

- [ ] **Step 6: 분기 갱신 워크플로 작성**

수집이 OpenAPI 경로라 **CI에서 전 과정을 자동화할 수 있다.** 분기마다 알아서 돌고
산출물이 바뀌면 커밋한다. 도메인 자산이 아직 잠정이면 배포되지 않도록 막는다.

`.github/workflows/quarterly-etl.yml`:
```yaml
name: quarterly-etl

on:
  schedule:
    - cron: "0 18 5 2,5,8,11 *"   # 분기 갱신 직후(KST 새벽 3시)
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r etl/requirements.txt

      - name: 수집 + 빌드
        env:
          SEOUL_API_KEY: ${{ secrets.SEOUL_API_KEY }}
        run: python -m etl.build

      - run: python -m pytest etl/tests/ -v

      - name: 잠정 도메인 자산이면 배포 차단
        run: |
          python3 - <<'PY'
          import json, sys
          meta = json.load(open("web/data/meta.json", encoding="utf-8"))
          if meta.get("provisional"):
              print("::error::잠정 도메인 자산 — 공개 전 실제 값이 필요하다")
              sys.exit(1)
          print(f"데이터 기준: {meta['period_label']}")
          PY

      - name: 변경분 커밋
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add web/data/
          git diff --staged --quiet || git commit -m "chore(data): 분기 갱신"
          git push
```

`SEOUL_API_KEY`는 저장소 Settings → Secrets and variables → Actions 에 등록한다.
**SHP는 CI에서 받을 수 없으므로**, 분기 A(폴리곤)로 가는 경우 SHP는 저장소에 커밋해 두거나
경계 생성만 로컬에서 돌린다. 상권 경계는 분기마다 바뀌지 않으므로 실무상 문제되지 않는다.

- [ ] **Step 7: README 작성 및 커밋**

`README.md`:
```markdown
# 상권 큐레이션

주소·층수·업종을 입력하면 그 조합의 적합도를 4단계로 판정하고, 그 자리에 더 맞는
업종을 1안·2안으로 제시하는 웹서비스. 서울 단독.

**이 서비스는 결정해주지 않는다. 현장에 나가기 전에 후보를 걸러준다.**

## 데이터 갱신 (분기 1회)

분기마다 GitHub Actions가 자동 실행한다. 수동으로 돌리려면:

1. `.env` 에 `SEOUL_API_KEY` 설정 (data.seoul.go.kr 에서 발급)
2. `set -a && . ./.env && set +a`
3. `.venv/bin/python -m etl.build` — API 캐시를 새로 받으려면 `data/raw/*.parquet` 삭제
4. `web/data/` 변경분을 커밋

## 테스트

```bash
.venv/bin/python -m pytest etl/tests/ -v   # ETL
node --test web/tests/                     # 웹
```

## 출처

서울 열린데이터광장 상권분석서비스 (CC BY) / 카카오 로컬 API
```

```bash
git add etl/build.py etl/tests/test_build.py .github/ README.md web/data/
git commit -m "feat(etl): 빌드 파이프라인 + 자치구 분할 JSON 출력 + 신선도 검사"
```

---

## Task 8: 웹 — 좌표→상권 매칭 + 정밀도 표기

**Files:**
- Create: `web/js/locate.js`
- Create: `web/tests/locate.test.js`

**Interfaces:**
- Consumes: `web/data/boundary/{gu}.json`, `web/data/score/{gu}.json`, `web/data/dong/{gu}.json`
- Produces:
  - `pointInPolygon([lng, lat], ring) -> boolean`
  - `distanceMeters([lng1, lat1], [lng2, lat2]) -> number`
  - `matchArea({lng, lat}, boundary) -> {code, name} | null` — 폴리곤 전용
  - `resolvePrecision({area, dongData, dongCode}) -> {level: "area"|"dong"|"none", badge, label}`
    - `badge`는 `"🟢"|"🟡"|"🔴"`, `label`은 `"상권 단위 분석"|"행정동 단위 분석"|"분석 불가"`

**폴리곤 전용.** Task 3이 분기 A로 확정돼 `mode`는 항상 `"polygon"`이다. 원 근사 경로는 실제로 흐르는 데이터가 없으므로 구현하지 않는다 — 다만 `mode`가 `"polygon"`이 아니면 조용히 빈 결과를 내는 대신 즉시 던져서, 나중에 포맷이 바뀌면 여기서 터지게 한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/locate.test.js`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon, distanceMeters, matchArea, resolvePrecision } from "../js/locate.js";

const SQUARE = [[126.9, 37.5], [127.0, 37.5], [127.0, 37.6], [126.9, 37.6], [126.9, 37.5]];

test("pointInPolygon: 내부 판정", () => {
  assert.equal(pointInPolygon([126.95, 37.55], SQUARE), true);
});

test("pointInPolygon: 외부 판정", () => {
  assert.equal(pointInPolygon([127.5, 37.55], SQUARE), false);
});

test("distanceMeters: 서울시청↔광화문은 대략 1km 미만", () => {
  const d = distanceMeters([126.9780, 37.5665], [126.9769, 37.5759]);
  assert.ok(d > 900 && d < 1200, `실제 ${d}m`);
});

test("matchArea: polygon 모드", () => {
  const boundary = { mode: "polygon", areas: [
    { code: "A1", name: "테스트상권", bbox: [126.9, 37.5, 127.0, 37.6], rings: [[SQUARE]] },
  ]};
  assert.equal(matchArea({ lng: 126.95, lat: 37.55 }, boundary).code, "A1");
  assert.equal(matchArea({ lng: 128.0, lat: 37.55 }, boundary), null);
});

test("matchArea: 구멍 안의 점은 상권 밖이다", () => {
  const outer = [[126.90, 37.50], [127.10, 37.50], [127.10, 37.70], [126.90, 37.70], [126.90, 37.50]];
  const hole  = [[126.95, 37.55], [127.05, 37.55], [127.05, 37.65], [126.95, 37.65], [126.95, 37.55]];
  const boundary = { mode: "polygon", areas: [
    { code: "H1", name: "구멍상권", bbox: [126.90, 37.50, 127.10, 37.70], rings: [[outer, hole]] },
  ]};
  assert.equal(matchArea({ lng: 126.92, lat: 37.52 }, boundary).code, "H1");  // 외곽 안, 구멍 밖
  assert.equal(matchArea({ lng: 127.00, lat: 37.60 }, boundary), null);        // 구멍 안
});

test("matchArea: polygon 외 모드는 조용히 넘기지 않고 던진다", () => {
  const boundary = { mode: "circle", areas: [] };
  assert.throws(() => matchArea({ lng: 126.95, lat: 37.55 }, boundary), /polygon/);
});

test("matchArea: 겹칠 때 더 가까운 중심을 고른다", () => {
  const near = [[126.90, 37.50], [127.10, 37.50], [127.10, 37.70], [126.90, 37.70], [126.90, 37.50]];
  const far  = [[126.70, 37.40], [127.30, 37.40], [127.30, 37.75], [126.70, 37.75], [126.70, 37.40]];
  const boundary = { mode: "polygon", areas: [
    { code: "FAR",   name: "넓은상권", bbox: [126.70, 37.40, 127.30, 37.75], rings: [[far]] },
    { code: "CLOSE", name: "좁은상권", bbox: [126.90, 37.50, 127.10, 37.70], rings: [[near]] },
  ]};
  assert.equal(matchArea({ lng: 126.95, lat: 37.55 }, boundary).code, "CLOSE");
});

test("resolvePrecision: 상권 안이면 🟢", () => {
  const r = resolvePrecision({ area: { code: "A1" }, dongData: null, dongCode: null });
  assert.deepEqual([r.level, r.badge], ["area", "🟢"]);
});

test("resolvePrecision: 상권 밖 + 행정동 데이터 있으면 🟡", () => {
  const r = resolvePrecision({
    area: null, dongCode: "11440510",
    dongData: { dongs: { "11440510": { industries: {} } } },
  });
  assert.deepEqual([r.level, r.badge], ["dong", "🟡"]);
});

test("resolvePrecision: 아무 데이터도 없으면 🔴", () => {
  const r = resolvePrecision({ area: null, dongCode: "11440510", dongData: { dongs: {} } });
  assert.deepEqual([r.level, r.badge], ["none", "🔴"]);
});

test("resolvePrecision: 상권 밖일 때 인근 상권으로 몰래 대체하지 않는다", () => {
  const r = resolvePrecision({ area: null, dongCode: null, dongData: null });
  assert.equal(r.level, "none");
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
node --test web/tests/locate.test.js
```
Expected: FAIL — `Cannot find module '../js/locate.js'`

- [ ] **Step 3: `web/js/locate.js` 구현**

```javascript
// 좌표 → 상권 매칭과 분석 정밀도 판정. 스펙 10.3.
//
// 상권 밖 주소에 인근 상권 데이터를 조용히 갖다 쓰는 것은 거짓말이다.
// "모른다"고 말할 수 있어야 신뢰를 얻는다 — 이 파일이 그 원칙을 집행한다.

const EARTH_RADIUS_M = 6371000;

export function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Ray casting. 경계선 위의 점은 내부로 친다.
export function pointInPolygon([lng, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function inBbox([lng, lat], [minLng, minLat, maxLng, maxLat]) {
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}

// 여러 상권에 걸치면 중심이 가장 가까운 쪽을 택한다.
export function matchArea({ lng, lat }, boundary) {
  if (!boundary || !Array.isArray(boundary.areas)) return null;
  const point = [lng, lat];
  let best = null;
  let bestDistance = Infinity;

  for (const area of boundary.areas) {
    let hit = false;
    let center;

    if (boundary.mode === "polygon") {
      if (area.bbox && !inBbox(point, area.bbox)) continue;
      // part[0]=외곽링, part[1:]=구멍. 외곽 안에 있어도 구멍 안이면 밖이다.
      hit = area.rings.some(([outer, ...holes]) =>
        pointInPolygon(point, outer) && !holes.some((h) => pointInPolygon(point, h)));
      center = area.rings[0][0][0];
    } else {
      const d = distanceMeters(point, area.center);
      hit = d <= area.radius_m;
      center = area.center;
    }
    if (!hit) continue;

    const d = distanceMeters(point, center);
    if (d < bestDistance) {
      bestDistance = d;
      best = { code: area.code, name: area.name };
    }
  }
  return best;
}

const PRECISION = {
  area: { badge: "🟢", label: "상권 단위 분석" },
  dong: { badge: "🟡", label: "행정동 단위 분석" },
  none: { badge: "🔴", label: "분석 불가" },
};

export function resolvePrecision({ area, dongData, dongCode }) {
  if (area) return { level: "area", ...PRECISION.area };
  if (dongCode && dongData?.dongs?.[dongCode]) {
    return { level: "dong", ...PRECISION.dong, note: "해상도가 낮습니다" };
  }
  return { level: "none", ...PRECISION.none };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
node --test web/tests/locate.test.js
```
Expected: 10 pass

- [ ] **Step 5: 커밋**

```bash
git add web/js/locate.js web/tests/locate.test.js
git commit -m "feat(web): 좌표-상권 매칭 + 분석 정밀도 3표기"
```

---

## Task 9: 웹 — 층수 보정 + 등급 판정

**Files:**
- Create: `web/js/verdict.js`
- Create: `web/tests/verdict.test.js`

**Interfaces:**
- Consumes: `meta.json`의 `grade_cuts`, `score/{gu}.json`의 `industries[code]`, `data/domain/floor_coefficients.json`
- Produces:
  - `FLOORS`, `FLOOR_LABELS`, `GRADES` — 상수 (ETL과 동일한 값)
  - `applyFloor(base, coefficient) -> number`
  - `gradeOf(score, cuts) -> "상"|"중상"|"중하"|"하"`
  - `rankLabel(score, cuts) -> string` — `"상위 12%"` 형태. **성공 확률이 아니라 순위 표기다**
  - `floorWarning({group, floor, floorTable, warnBelow}) -> {severity, message} | null`
  - `judge({entry, cuts, group, floor, floorTable, warnBelow}) -> {grade, score, rank, warning, patterns, axes}`

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/verdict.test.js`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { FLOORS, GRADES, applyFloor, gradeOf, rankLabel, floorWarning, judge }
  from "../js/verdict.js";

const CUTS = [75, 50, 25];
const FLOOR_TABLE = { 유동의존형: { B1: 0.4, F1: 1.0, F2: 0.5, F3P: 0.35, DETACHED: 0.95 },
                      배후의존형: { B1: 0.8, F1: 1.0, F2: 0.95, F3P: 0.85, DETACHED: 1.0 } };

test("층수 구간은 5개로 고정", () => {
  assert.deepEqual(FLOORS, ["B1", "F1", "F2", "F3P", "DETACHED"]);
});

test("등급은 4단계로 고정", () => {
  assert.deepEqual(GRADES, ["상", "중상", "중하", "하"]);
});

test("gradeOf: 경계값이 상위 등급에 속한다", () => {
  assert.equal(gradeOf(75, CUTS), "상");
  assert.equal(gradeOf(74.99, CUTS), "중상");
  assert.equal(gradeOf(50, CUTS), "중상");
  assert.equal(gradeOf(25, CUTS), "중하");
  assert.equal(gradeOf(24.99, CUTS), "하");
});

test("applyFloor: 계수를 곱하고 0~100으로 자른다", () => {
  assert.equal(applyFloor(80, 0.5), 40);
  assert.equal(applyFloor(80, 2.0), 100);
});

test("2층 카페는 같은 자리 1층 카페보다 등급이 낮거나 같다", () => {
  const entry = { base: 80, store_count: 10, patterns: [], axes: {} };
  const args = { entry, cuts: CUTS, group: "유동의존형", floorTable: FLOOR_TABLE, warnBelow: 0.75 };
  const f1 = judge({ ...args, floor: "F1" });
  const f2 = judge({ ...args, floor: "F2" });
  assert.ok(f2.score < f1.score);
  assert.ok(GRADES.indexOf(f2.grade) >= GRADES.indexOf(f1.grade));
});

test("5개 층수 전체에서 판정이 나온다", () => {
  const entry = { base: 60, store_count: 5, patterns: [], axes: {} };
  for (const floor of FLOORS) {
    const r = judge({ entry, cuts: CUTS, group: "유동의존형", floor,
                      floorTable: FLOOR_TABLE, warnBelow: 0.75 });
    assert.ok(GRADES.includes(r.grade), `${floor} 등급 없음`);
  }
});

test("floorWarning: 계수가 임계 미만이면 경고", () => {
  const w = floorWarning({ group: "유동의존형", floor: "F2",
                           floorTable: FLOOR_TABLE, warnBelow: 0.75 });
  assert.ok(w && w.message.length > 0);
});

test("floorWarning: 궁합이 나쁘지 않으면 경고 없음", () => {
  assert.equal(floorWarning({ group: "배후의존형", floor: "F2",
                              floorTable: FLOOR_TABLE, warnBelow: 0.75 }), null);
});

test("등급 하락과 별도로 경고가 따로 나온다 (스펙 7.5 이중 처리)", () => {
  const r = judge({ entry: { base: 90, store_count: 10, patterns: [], axes: {} },
                    cuts: CUTS, group: "유동의존형", floor: "F3P",
                    floorTable: FLOOR_TABLE, warnBelow: 0.75 });
  assert.ok(r.warning, "경고가 있어야 한다");
  assert.ok(r.score < 90, "등급에도 반영되어야 한다");
});

test("rankLabel: %는 순위 표기일 뿐 성공확률이 아니다", () => {
  const label = rankLabel(90, CUTS);
  assert.match(label, /상위|하위/);
  assert.doesNotMatch(label, /성공|확률/);
});

test("base가 없으면 판정하지 않는다", () => {
  assert.throws(() => judge({ entry: { base: null }, cuts: CUTS, group: "유동의존형",
                              floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75 }));
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
node --test web/tests/verdict.test.js
```
Expected: FAIL — `Cannot find module '../js/verdict.js'`

- [ ] **Step 3: `web/js/verdict.js` 구현**

```javascript
// 층수 보정 + 등급 판정. 스펙 7.2 / 7.5.
//
// ETL이 만든 base(층수 미적용 가중합)에 층수 계수를 곱해 등급컷과 대조한다.
// 층수는 사용자 입력이라 사전 계산할 수 없어 이 한 조각만 브라우저에 남는다.
//
// ⚠️ 층수 계수는 공공데이터 산출값이 아니라 도메인 휴리스틱이다.
//    공공데이터에 층별 매출이 존재하지 않는다 — 화면에 그 성격을 표기한다.

export const FLOORS = ["B1", "F1", "F2", "F3P", "DETACHED"];
export const FLOOR_LABELS = {
  B1: "지하", F1: "1층", F2: "2층", F3P: "3층 이상", DETACHED: "단독건물",
};
export const GRADES = ["상", "중상", "중하", "하"];
export const GRADE_MEANING = {
  상: "적극 추천", 중상: "해볼 만함, 단 조건부",
  중하: "권하지 않음, 하려면 대비 필요", 하: "말립니다",
};

export function applyFloor(base, coefficient) {
  return Math.max(0, Math.min(100, base * coefficient));
}

export function gradeOf(score, cuts) {
  for (let i = 0; i < cuts.length; i += 1) {
    if (score >= cuts[i]) return GRADES[i];
  }
  return GRADES[GRADES.length - 1];
}

// 순위 표기. 성공 확률이 아니다 — 스펙 5.2에서 % 확률은 금지되어 있다.
export function rankLabel(score, cuts) {
  const [top, mid, low] = cuts;
  if (score >= top) return "상위 25% 이내";
  if (score >= mid) return "상위 50% 이내";
  if (score >= low) return "하위 50%";
  return "하위 25%";
}

export function floorWarning({ group, floor, floorTable, warnBelow }) {
  const coefficient = floorTable?.[group]?.[floor];
  if (coefficient === undefined || coefficient >= warnBelow) return null;
  return {
    severity: coefficient < warnBelow * 0.7 ? "critical" : "caution",
    coefficient,
    message:
      `${FLOOR_LABELS[floor]} 위치는 이 업종(${group})과 궁합이 좋지 않습니다. ` +
      `유동인구가 많더라도 상당 부분이 체감되지 않습니다.`,
    basis: "heuristic",
  };
}

export function judge({ entry, cuts, group, floor, floorTable, warnBelow }) {
  if (entry?.base === null || entry?.base === undefined) {
    throw new Error("base 점수 없이 판정하지 않는다");
  }
  const coefficient = floorTable?.[group]?.[floor] ?? 1.0;
  const score = applyFloor(entry.base, coefficient);
  return {
    score,
    grade: gradeOf(score, cuts),
    meaning: GRADE_MEANING[gradeOf(score, cuts)],
    rank: rankLabel(score, cuts),
    warning: floorWarning({ group, floor, floorTable, warnBelow }),
    patterns: entry.patterns ?? [],
    axes: entry.axes ?? {},
    storeCount: entry.store_count ?? null,
    salesPerStore: entry.sales_per_store ?? null,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
node --test web/tests/verdict.test.js
```
Expected: 11 pass

- [ ] **Step 5: 커밋**

```bash
git add web/js/verdict.js web/tests/verdict.test.js
git commit -m "feat(web): 층수 보정 + 4단계 등급 판정 (등급반영 + 별도경고 이중처리)"
```

---

## Task 10: 웹 — 대안 업종 추천 (필터 두 겹)

**Files:**
- Create: `web/js/alternatives.js`
- Create: `web/tests/alternatives.test.js`
- Create: `data/domain/startup_filter.json`
- Modify: `scripts/seed_domain.py`

**Interfaces:**
- Consumes: Task 9의 `judge()`, `score/{gu}.json`의 `area.industries` 전체, `startup_filter.json`
- Produces:
  - `filterOpenable(codes, startupFilter) -> string[]` — 필터 ①
  - `filterByFloor(codes, {groups, floor, floorTable, minCoefficient}) -> string[]` — 필터 ②
  - `recommend({area, meta, assets, floor, askedCode}) -> [{code, name, grade, score, reason}, ...]` — 최대 2건

**핵심:** 별도 로직이 아니라 **같은 엔진을 한 번 더 돌리는 것**이다(스펙 8.1). `judge()`를 상권 내 전 업종에 대해 호출하고 필터 두 겹을 통과한 것 중 상위 2개를 뽑는다.

- [ ] **Step 1: 창업 필터 시드 추가**

`scripts/seed_domain.py`의 `main()` 끝에 추가:
```python
    (DOMAIN_DIR / "startup_filter.json").write_text(json.dumps({
        "provisional": True,
        "_note": ("일반 예비창업자가 실제로 열 수 있는 업종만 남기는 필터. "
                  "이게 없으면 대안 추천에 병원·약국이 튀어나온다 — 스펙 8.2. "
                  "작성 주체는 신동환."),
        "excluded": [],
        "_excluded_examples": ["의원", "치과의원", "한의원", "약국",
                               "일반병원", "산부인과", "동물병원"],
        "min_coefficient": 0.6,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
```

```bash
.venv/bin/python scripts/seed_domain.py
```

- [ ] **Step 2: 실패하는 테스트 작성**

`web/tests/alternatives.test.js`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { filterOpenable, filterByFloor, recommend } from "../js/alternatives.js";

const GROUPS = { CAFE: "유동의존형", LAUNDRY: "배후의존형",
                 CLINIC: "목적방문형", BANCHAN: "배후의존형" };
const FLOOR_TABLE = {
  유동의존형: { B1: 0.4, F1: 1.0, F2: 0.5, F3P: 0.35, DETACHED: 0.95 },
  배후의존형: { B1: 0.8, F1: 1.0, F2: 0.95, F3P: 0.85, DETACHED: 1.0 },
  목적방문형: { B1: 0.9, F1: 1.0, F2: 0.95, F3P: 0.9, DETACHED: 1.0 },
};
const META = {
  grade_cuts: { CAFE: [75, 50, 25], LAUNDRY: [75, 50, 25],
                CLINIC: [75, 50, 25], BANCHAN: [75, 50, 25] },
  industries: [
    { code: "CAFE", name: "커피-음료", group: "유동의존형" },
    { code: "LAUNDRY", name: "세탁편의점", group: "배후의존형" },
    { code: "CLINIC", name: "의원", group: "목적방문형" },
    { code: "BANCHAN", name: "반찬가게", group: "배후의존형" },
  ],
};
const AREA = { name: "테스트상권", industries: {
  CAFE:    { base: 30, store_count: 47, patterns: [], axes: {} },
  LAUNDRY: { base: 85, store_count: 3,  patterns: ["블루오션"], axes: {} },
  CLINIC:  { base: 95, store_count: 1,  patterns: ["블루오션"], axes: {} },
  BANCHAN: { base: 70, store_count: 4,  patterns: [], axes: {} },
}};
const ASSETS = { groups: GROUPS, floorTable: FLOOR_TABLE, warnBelow: 0.75,
                 startupFilter: { excluded: ["CLINIC"], min_coefficient: 0.6 } };

test("필터①: 자격·자본 장벽 업종을 걸러낸다", () => {
  const out = filterOpenable(["CAFE", "CLINIC", "LAUNDRY"], ASSETS.startupFilter);
  assert.ok(!out.includes("CLINIC"));
  assert.deepEqual(out, ["CAFE", "LAUNDRY"]);
});

test("필터②: 2층 물건에 1층 필수급 업종을 남기지 않는다", () => {
  const out = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: GROUPS, floor: "F2", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.ok(!out.includes("CAFE"), "2층 카페는 계수 0.5로 탈락해야 한다");
  assert.ok(out.includes("LAUNDRY"));
});

test("필터②: 1층이면 유동의존형도 남는다", () => {
  const out = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: GROUPS, floor: "F1", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.deepEqual(out.sort(), ["CAFE", "LAUNDRY"]);
});

test("recommend: 최대 2건을 점수순으로 반환", () => {
  const out = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.equal(out.length, 2);
  assert.ok(out[0].score >= out[1].score);
});

test("recommend: 물어본 업종은 대안에서 제외한다", () => {
  const out = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.ok(!out.some((r) => r.code === "CAFE"));
});

test("recommend: 자격장벽 업종이 최고점이어도 추천하지 않는다", () => {
  const out = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.ok(!out.some((r) => r.code === "CLINIC"), "의원은 그림의 떡이다");
});

test("recommend: 2층이면 유동의존형을 추천하지 않는다", () => {
  const out = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F2", askedCode: "LAUNDRY" });
  assert.ok(!out.some((r) => GROUPS[r.code] === "유동의존형"));
});

test("recommend: 근거는 물어본 업종과의 대비로 서술한다", () => {
  const out = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.match(out[0].reason, /커피-음료/, "물어본 업종이 근거에 등장해야 한다");
});

test("recommend: 후보가 없으면 빈 배열", () => {
  const out = recommend({ area: { industries: { CAFE: AREA.industries.CAFE } },
                          meta: META, assets: ASSETS, floor: "F1", askedCode: "CAFE" });
  assert.deepEqual(out, []);
});
```

- [ ] **Step 3: 테스트 실패 확인**

```bash
node --test web/tests/alternatives.test.js
```
Expected: FAIL — `Cannot find module '../js/alternatives.js'`

- [ ] **Step 4: `web/js/alternatives.js` 구현**

```javascript
// 대안 업종 추천. 스펙 8.
//
// 추가 데이터도 추가 로직도 없다 — 이미 만든 판정 엔진을 상권 내 전 업종에
// 한 번 더 돌리고 필터 두 겹을 통과한 상위 2개를 뽑는 것뿐이다.

import { judge } from "./verdict.js";

// 필터 ① 「열 수 있는 업종」 — 자격증·수억 자본이 필요한 업종을 걸러낸다.
// 이게 없으면 데이터상 최고점인 병원·약국이 상위에 올라온다.
export function filterOpenable(codes, startupFilter) {
  const excluded = new Set(startupFilter?.excluded ?? []);
  return codes.filter((code) => !excluded.has(code));
}

// 필터 ② 「그 층에서 되는 업종」 — 2층 물건에 세탁편의점을 추천하면 헛다리다.
export function filterByFloor(codes, { groups, floor, floorTable, minCoefficient }) {
  return codes.filter((code) => {
    const coefficient = floorTable?.[groups[code]]?.[floor];
    return coefficient === undefined || coefficient >= minCoefficient;
  });
}

function buildReason({ candidate, asked, area }) {
  const mine = area.industries[candidate.code];
  const theirs = asked ? area.industries[asked.code] : null;
  const parts = [];

  if (theirs && theirs.store_count != null && mine.store_count != null) {
    parts.push(
      `물으신 ${asked.name}은 경쟁점 ${theirs.store_count}곳인데 ` +
      `${candidate.name}은 ${mine.store_count}곳입니다.`
    );
  }
  if (mine.patterns?.includes("블루오션")) {
    parts.push("배후 수요 대비 공급이 명백히 부족합니다.");
  }
  if (mine.sales_per_store && theirs?.sales_per_store &&
      mine.sales_per_store > theirs.sales_per_store) {
    const ratio = (mine.sales_per_store / theirs.sales_per_store).toFixed(1);
    parts.push(`점포당 추정매출도 약 ${ratio}배 높습니다.`);
  }
  return parts.join(" ") || `${candidate.name}의 적합도가 더 높게 나왔습니다.`;
}

export function recommend({ area, meta, assets, floor, askedCode, limit = 2 }) {
  const names = new Map(meta.industries.map((i) => [i.code, i.name]));
  const asked = askedCode
    ? { code: askedCode, name: names.get(askedCode) ?? askedCode }
    : null;

  let codes = Object.keys(area.industries ?? {}).filter((c) => c !== askedCode);
  codes = filterOpenable(codes, assets.startupFilter);
  codes = filterByFloor(codes, {
    groups: assets.groups,
    floor,
    floorTable: assets.floorTable,
    minCoefficient: assets.startupFilter?.min_coefficient ?? 0.6,
  });

  const scored = [];
  for (const code of codes) {
    const cuts = meta.grade_cuts[code];
    const entry = area.industries[code];
    if (!cuts || entry?.base == null) continue;
    const result = judge({
      entry, cuts, group: assets.groups[code], floor,
      floorTable: assets.floorTable, warnBelow: assets.warnBelow,
    });
    scored.push({ code, name: names.get(code) ?? code, ...result });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((candidate) => ({
    code: candidate.code,
    name: candidate.name,
    grade: candidate.grade,
    score: candidate.score,
    // 스펙 8.3 — "이 업종이 좋습니다"가 아니라 "물어본 것보다 왜 나은가"
    reason: buildReason({ candidate, asked, area }),
  }));
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
node --test web/tests/
```
Expected: locate 10 + verdict 11 + alternatives 9 = 30 pass

- [ ] **Step 6: 커밋**

```bash
git add web/js/alternatives.js web/tests/alternatives.test.js data/domain/startup_filter.json scripts/seed_domain.py
git commit -m "feat(web): 대안 업종 추천 + 필터 두 겹 (창업가능 / 층수적합)"
```

---

## Task 11: 웹 — 화면 + 템플릿 해설 (AI 없이 서비스 완결)

**Files:**
- Create: `web/index.html`
- Create: `web/css/style.css`
- Create: `web/js/narrate.js`
- Create: `web/js/render.js`
- Create: `web/js/main.js`
- Create: `web/tests/narrate.test.js`

**Interfaces:**
- Consumes: Task 8~10 전부
- Produces:
  - `narrate.templateNarration(result) -> {headline, factors: [{kind, text}], floorNote, patternNotes}` — `kind`는 `"positive"|"negative"|"caution"`
  - `render.renderResult(root, payload) -> void`
  - `main.analyze({address, industryCode, floor}) -> payload`

**이 태스크가 끝나면 서비스는 기능적으로 완결된다.** Task 12의 AI는 문장 품질만 올린다 — 스펙 10.2 "AI가 완전히 죽어도 판정은 정상 출력된다"를 구조로 강제하기 위해 순서를 이렇게 잡았다.

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/narrate.test.js`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { templateNarration } from "../js/narrate.js";

const BASE = {
  industryName: "커피-음료", areaName: "서교동", floor: "F2",
  grade: "중하", rank: "하위 50%", score: 30,
  storeCount: 47, salesPerStore: 12000000,
  axes: { footfall: 92, competition: 18, vitality: 40, fit: 55, resident: 60, worker: 30 },
  patterns: ["함정상권"],
  warning: { severity: "critical", message: "2층 위치는 궁합이 좋지 않습니다.", basis: "heuristic" },
};

test("등급과 의미가 헤드라인에 들어간다", () => {
  const n = templateNarration(BASE);
  assert.match(n.headline, /중하/);
});

test("긍정·부정 요인이 구분되어 나온다", () => {
  const n = templateNarration(BASE);
  const kinds = new Set(n.factors.map((f) => f.kind));
  assert.ok(kinds.has("positive"));
  assert.ok(kinds.has("negative"));
});

test("높은 유동인구는 긍정 요인으로 잡힌다", () => {
  const n = templateNarration(BASE);
  assert.ok(n.factors.some((f) => f.kind === "positive" && /유동/.test(f.text)));
});

test("층수 경고는 요인과 분리된 별도 항목이다", () => {
  const n = templateNarration(BASE);
  assert.ok(n.floorNote);
  assert.ok(!n.factors.some((f) => /2층/.test(f.text)));
});

test("층수 경고에 휴리스틱 근거임이 표기된다", () => {
  assert.match(templateNarration(BASE).floorNote.basisNote, /데이터|현장|경험|추정/);
});

test("패턴 설명이 따로 붙는다", () => {
  const n = templateNarration(BASE);
  assert.equal(n.patternNotes.length, 1);
  assert.match(n.patternNotes[0].text, /통행량|소비/);
});

test("어떤 출력에도 % 성공확률이 없다", () => {
  const text = JSON.stringify(templateNarration(BASE));
  assert.doesNotMatch(text, /성공\s*확률|성공률/);
});

test("경고가 없으면 floorNote도 없다", () => {
  const n = templateNarration({ ...BASE, warning: null });
  assert.equal(n.floorNote, null);
});

test("패턴이 없으면 patternNotes는 빈 배열", () => {
  assert.deepEqual(templateNarration({ ...BASE, patterns: [] }).patternNotes, []);
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
node --test web/tests/narrate.test.js
```
Expected: FAIL — `Cannot find module '../js/narrate.js'`

- [ ] **Step 3: `web/js/narrate.js` 구현 (템플릿 경로만)**

```javascript
// 판정 결과 → 문장. AI 없이도 완결되는 템플릿 경로.
// Task 12에서 AI 해설이 추가되지만 이 함수는 항상 폴백으로 살아 있다.

import { FLOOR_LABELS, GRADE_MEANING } from "./verdict.js";

const PATTERN_TEXT = {
  함정상권: "통행량은 많은데 소비로 이어지지 않는 패턴입니다. " +
            "테이크아웃 위주 저단가 구조라면 해볼 만하고, 좌석 회전을 기대하는 모델이면 말립니다.",
  침몰상권: "매출은 줄고 폐업은 느는데 점포수는 오히려 늘고 있습니다. 가장 나쁜 조합입니다.",
  포화: "점포 밀도가 최상위권입니다. 신규 진입 여지가 거의 없습니다.",
  블루오션: "배후 수요 대비 공급이 부족합니다. 이 상권에서 드문 신호입니다.",
};

const HIGH = 70;
const LOW = 30;

function money(won) {
  if (!won) return null;
  const eok = won / 100000000;
  if (eok >= 1) return `${eok.toFixed(1)}억원`;
  return `${Math.round(won / 10000).toLocaleString()}만원`;
}

export function templateNarration(result) {
  const { axes = {}, industryName, areaName, grade } = result;
  const factors = [];

  const push = (kind, text) => text && factors.push({ kind, text });

  if (axes.footfall >= HIGH) push("positive", `유동인구가 상위권입니다 (상위 ${Math.round(100 - axes.footfall)}%)`);
  if (axes.footfall <= LOW) push("negative", "유동인구가 하위권입니다");
  if (axes.resident >= HIGH) push("positive", "배후 거주인구가 두텁습니다");
  if (axes.worker >= HIGH) push("positive", "직장인구가 많은 자리입니다");

  if (axes.competition <= LOW) {
    push("negative",
      `경쟁이 심합니다. ${industryName}이 이미 ${result.storeCount}개이고 ` +
      `점포당 추정매출은 ${money(result.salesPerStore) ?? "하위권"}입니다`);
  } else if (axes.competition >= HIGH) {
    push("positive", `경쟁 대비 점포당 매출이 양호합니다 (${money(result.salesPerStore) ?? "상위권"})`);
  }

  if (axes.vitality <= LOW) push("caution", "최근 매출 추세와 폐업률이 좋지 않습니다");
  if (axes.vitality >= HIGH) push("positive", "매출 추세와 영업 지속성이 안정적입니다");
  if (axes.fit <= LOW) push("caution", "이 상권의 소비 시간대·연령 구성이 해당 업종과 잘 맞지 않습니다");
  if (axes.fit >= HIGH) push("positive", "상권의 소비 성격이 해당 업종과 잘 맞습니다");

  const floorNote = result.warning
    ? {
        severity: result.warning.severity,
        text: result.warning.message,
        basisNote:
          "※ 층수 판단은 공개 데이터가 아니라 현장 경험에 근거한 추정입니다. " +
          "공공데이터에는 층별 매출이 존재하지 않습니다.",
      }
    : null;

  return {
    headline: `${areaName} · ${FLOOR_LABELS[result.floor]} · ${industryName} — ${grade}, ${GRADE_MEANING[grade]}`,
    factors,
    floorNote,
    patternNotes: (result.patterns ?? [])
      .filter((p) => PATTERN_TEXT[p])
      .map((p) => ({ name: p, text: PATTERN_TEXT[p] })),
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
node --test web/tests/narrate.test.js
```
Expected: 9 pass

- [ ] **Step 5: `web/index.html` 작성**

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>상권 큐레이션</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<main>
  <header>
    <h1>상권 큐레이션</h1>
    <p class="tagline">이 서비스는 결정해주지 않습니다. 현장에 나가기 전에 후보를 걸러줍니다.</p>
  </header>

  <form id="query">
    <label>물건지 주소
      <input name="address" required placeholder="예) 서울 마포구 양화로 45">
    </label>
    <label>오픈하려는 업종
      <input name="industry" required placeholder="예) 카페, 국밥집, 무인세탁">
    </label>
    <label>층수
      <select name="floor" required>
        <option value="B1">지하</option>
        <option value="F1" selected>1층</option>
        <option value="F2">2층</option>
        <option value="F3P">3층 이상</option>
        <option value="DETACHED">단독건물</option>
      </select>
    </label>
    <button type="submit">분석하기</button>
  </form>

  <section id="result" hidden></section>

  <footer>
    <p id="data-period"></p>
    <p class="disclaimer">
      이 분석은 공개 데이터 기반의 사전 스크리닝입니다.
      임대 조건, 자리의 가시성, 건물 상태 등은 반드시 현장에서 직접 확인하십시오.
    </p>
    <p id="sources" class="sources"></p>
  </footer>
</main>
<script type="module" src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 6: `web/js/render.js` 와 `web/js/main.js` 작성**

`web/js/render.js`:
```javascript
const KIND_MARK = { positive: "✓", negative: "✗", caution: "⚠" };

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

export function renderResult(root, payload) {
  root.replaceChildren();
  root.hidden = false;

  const { precision, narration, verdict, alternatives, areaName, floorLabel, industryName } = payload;

  const head = el("div", "verdict-head");
  head.append(
    el("p", "precision", `${precision.badge} ${precision.label}`),
    el("p", "context", `${areaName} · ${floorLabel} · ${industryName}`),
  );

  if (precision.level === "none") {
    head.append(el("p", "grade none", "분석 불가"));
    head.append(el("p", "note", "이 주소는 제공 데이터 범위 밖입니다. 판정을 만들어내지 않습니다."));
    root.append(head);
    return;
  }

  head.append(
    el("p", `grade grade-${verdict.grade}`, `${verdict.grade} · ${verdict.meaning}`),
    el("p", "rank", `이 상권 ${industryName} 중 ${verdict.rank}`),
  );
  root.append(head);

  const factors = el("ul", "factors");
  for (const f of narration.factors) {
    factors.append(el("li", `factor ${f.kind}`, `${KIND_MARK[f.kind]} ${f.text}`));
  }
  root.append(factors);

  if (narration.floorNote) {
    const box = el("div", `floor-note ${narration.floorNote.severity}`);
    box.append(el("h3", null, "층수 경고"), el("p", null, narration.floorNote.text),
               el("p", "basis", narration.floorNote.basisNote));
    root.append(box);
  }

  for (const p of narration.patternNotes) {
    const box = el("div", "pattern-note");
    box.append(el("h3", null, `감지된 패턴 · ${p.name}`), el("p", null, p.text));
    root.append(box);
  }

  if (alternatives.length) {
    const section = el("section", "alternatives");
    section.append(el("h2", null, "이 자리에 더 맞는 업종"));
    alternatives.forEach((alt, i) => {
      const card = el("div", "alt-card");
      card.append(el("h3", null, `${i + 1}안 · ${alt.name}`), el("p", null, alt.reason));
      section.append(card);
    });
    root.append(section);
  }
}
```

`web/js/main.js`:
```javascript
import { matchArea, resolvePrecision } from "./locate.js";
import { judge, FLOOR_LABELS } from "./verdict.js";
import { recommend } from "./alternatives.js";
import { templateNarration } from "./narrate.js";
import { renderResult } from "./render.js";

const PROXY = "https://sanggwon-proxy.<계정>.workers.dev";  // Task 12에서 실제 주소로 교체

const cache = new Map();
const loadJson = async (path) => {
  if (!cache.has(path)) cache.set(path, fetch(path).then((r) => (r.ok ? r.json() : null)));
  return cache.get(path);
};

const meta = await loadJson("data/meta.json");
document.getElementById("data-period").textContent = `데이터 기준: ${meta.period_label}`;
document.getElementById("sources").textContent = `출처: ${meta.sources.join(" / ")}`;

const assets = {
  groups: Object.fromEntries(meta.industries.map((i) => [i.code, i.group])),
  floorTable: (await loadJson("../data/domain/floor_coefficients.json")).coefficients,
  warnBelow: (await loadJson("../data/domain/floor_coefficients.json")).warn_below,
  startupFilter: await loadJson("../data/domain/startup_filter.json"),
};

// 업종 매핑: Task 12까지는 이름 부분일치 폴백만 쓴다 (스펙 10.2 입구 폴백).
function mapIndustry(text) {
  const q = text.trim();
  return meta.industries.find((i) => i.name.includes(q) || q.includes(i.name)) ?? null;
}

async function geocode(address) {
  const res = await fetch(`${PROXY}/geocode?q=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error("주소를 찾지 못했습니다. 도로명 또는 지번으로 다시 입력해 주세요.");
  return res.json();   // { lng, lat, gu_code, dong_code }
}

async function analyze({ address, industryText, floor }) {
  const industry = mapIndustry(industryText);
  if (!industry) throw new Error("업종을 인식하지 못했습니다. 목록에서 선택해 주세요.");

  const { lng, lat, gu_code: gu, dong_code: dongCode } = await geocode(address);
  const [boundary, scores, dongData] = await Promise.all([
    loadJson(`data/boundary/${gu}.json`),
    loadJson(`data/score/${gu}.json`),
    loadJson(`data/dong/${gu}.json`),
  ]);

  const matched = boundary ? matchArea({ lng, lat }, boundary) : null;
  const precision = resolvePrecision({ area: matched, dongData, dongCode });
  const base = { precision, industryName: industry.name,
                 floorLabel: FLOOR_LABELS[floor], areaName: matched?.name ?? "해당 지역",
                 alternatives: [] };
  if (precision.level !== "area") return base;

  const area = scores.areas[matched.code];
  const entry = area?.industries?.[industry.code];
  if (!entry || entry.base == null) {
    return { ...base, precision: { level: "none", badge: "🔴", label: "분석 불가" } };
  }

  const verdict = judge({
    entry, cuts: meta.grade_cuts[industry.code], group: assets.groups[industry.code],
    floor, floorTable: assets.floorTable, warnBelow: assets.warnBelow,
  });
  const narration = templateNarration({
    ...verdict, industryName: industry.name, areaName: area.name, floor,
  });
  const alternatives = recommend({ area, meta, assets, floor, askedCode: industry.code });

  return { ...base, areaName: area.name, verdict, narration, alternatives };
}

document.getElementById("query").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const root = document.getElementById("result");
  try {
    renderResult(root, await analyze({
      address: form.get("address"),
      industryText: form.get("industry"),
      floor: form.get("floor"),
    }));
  } catch (error) {
    root.hidden = false;
    root.textContent = error.message;
  }
});
```

- [ ] **Step 7: `web/css/style.css` 작성 (최소)**

```css
:root { --fg:#1a1a1a; --muted:#6b6b6b; --line:#e5e5e5; --bg:#fff;
        --pos:#1a7f37; --neg:#c1121f; --warn:#b45309; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
       color:var(--fg); background:var(--bg); }
main { max-width:680px; margin:0 auto; padding:2rem 1.25rem 4rem; }
h1 { font-size:1.5rem; margin:0 0 .25rem; }
.tagline { color:var(--muted); font-size:.9rem; margin:0 0 2rem; }
form { display:grid; gap:1rem; margin-bottom:2rem; }
label { display:grid; gap:.35rem; font-size:.9rem; font-weight:600; }
input, select { padding:.7rem; border:1px solid var(--line); border-radius:8px; font-size:1rem; }
button { padding:.85rem; border:0; border-radius:8px; background:var(--fg); color:#fff;
         font-size:1rem; font-weight:600; cursor:pointer; }
.precision { font-size:.85rem; color:var(--muted); margin:0; }
.context { font-size:.95rem; margin:.25rem 0 1rem; }
.grade { font-size:1.6rem; font-weight:700; margin:.5rem 0; }
.rank { color:var(--muted); margin:0 0 1.5rem; }
.factors { list-style:none; padding:0; display:grid; gap:.5rem; }
.factor.positive { color:var(--pos); }
.factor.negative { color:var(--neg); }
.factor.caution  { color:var(--warn); }
.floor-note, .pattern-note { margin:1.5rem 0; padding:1rem; border-left:3px solid var(--warn);
                             background:#fffbeb; border-radius:0 8px 8px 0; }
.floor-note.critical { border-color:var(--neg); background:#fef2f2; }
.floor-note h3, .pattern-note h3 { margin:0 0 .5rem; font-size:.9rem; }
.basis { font-size:.8rem; color:var(--muted); }
.alternatives { margin-top:2.5rem; border-top:1px solid var(--line); padding-top:1.5rem; }
.alt-card { margin-bottom:1.25rem; }
.alt-card h3 { margin:0 0 .35rem; font-size:1rem; }
footer { margin-top:3rem; border-top:1px solid var(--line); padding-top:1rem;
         font-size:.8rem; color:var(--muted); }
```

- [ ] **Step 8: 로컬 확인**

```bash
node --test web/tests/
cd web && python3 -m http.server 8080
```
브라우저에서 `http://localhost:8080` 을 연다. Task 12 이전이므로 지오코딩(프록시)이 없어 주소 입력은 실패한다 — **콘솔에 프록시 fetch 실패만 뜨고 페이지가 정상 렌더되면 통과다.**

- [ ] **Step 9: 커밋**

```bash
git add web/
git commit -m "feat(web): 화면 + 템플릿 해설 — AI 없이 서비스 기능 완결"
```

---

## Task 12: Cloudflare Workers 프록시 + AI 입구·출구

**Files:**
- Create: `worker/src/index.js`
- Create: `worker/wrangler.toml`
- Create: `worker/README.md`
- Modify: `web/js/main.js` (AI 업종 매핑 연결)
- Modify: `web/js/narrate.js` (AI 해설 + 캐싱 추가)
- Create: `web/tests/narrate-ai.test.js`

**Interfaces:**
- Consumes: Task 11의 `templateNarration()`
- Produces:
  - Worker 엔드포인트 3개:
    - `GET /geocode?q=` → `{lng, lat, gu_code, dong_code}` (카카오 로컬)
    - `POST /map-industry` `{text, candidates}` → `{code}` 또는 `{code: null}`
    - `POST /narrate` `{payload}` → `{text}`
  - `narrate.aiNarration(result, {endpoint, timeoutMs}) -> Promise<string|null>`
  - `narrate.cacheKey(result) -> string`

**AI 실패는 조용히 삼킨다.** 어느 호출이 실패해도 Task 11의 템플릿 경로로 떨어지고 사용자에게 오류를 노출하지 않는다(스펙 11).

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/narrate-ai.test.js`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { aiNarration, cacheKey } from "../js/narrate.js";

const RESULT = { industryName: "커피-음료", areaName: "서교동", floor: "F2",
                 grade: "중하", axes: { footfall: 92, competition: 18 }, patterns: [] };

test("cacheKey: 같은 입력은 같은 키", () => {
  assert.equal(cacheKey(RESULT), cacheKey({ ...RESULT }));
});

test("cacheKey: 층수가 다르면 다른 키", () => {
  assert.notEqual(cacheKey(RESULT), cacheKey({ ...RESULT, floor: "F1" }));
});

test("aiNarration: 네트워크 실패 시 null (예외를 던지지 않는다)", async () => {
  const out = await aiNarration(RESULT, {
    endpoint: "http://127.0.0.1:1/narrate", timeoutMs: 200,
  });
  assert.equal(out, null);
});

test("aiNarration: 타임아웃이 걸린다", async () => {
  const started = Date.now();
  await aiNarration(RESULT, { endpoint: "http://10.255.255.1/narrate", timeoutMs: 300 });
  assert.ok(Date.now() - started < 2000, "타임아웃이 동작해야 한다");
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
node --test web/tests/narrate-ai.test.js
```
Expected: FAIL — `aiNarration is not exported`

- [ ] **Step 3: `web/js/narrate.js` 에 AI 경로 추가**

파일 끝에 덧붙인다. `templateNarration()`은 손대지 않는다.

```javascript
// ── AI 해설 (출구). 실패하면 조용히 null을 반환하고 호출부가 템플릿으로 떨어진다. ──
// OpenRouter 무료 티어는 50 RPD로 공개 서비스에 턱없이 부족하다(스펙 9.2.3).
// 따라서 캐싱은 선택이 아니라 필수다. 같은 (상권·업종·층수·등급)은 문장이 같아도 된다.

export function cacheKey(result) {
  return [result.areaName, result.industryName, result.floor, result.grade,
          (result.patterns ?? []).join("|")].join("::");
}

const memory = new Map();

export async function aiNarration(result, { endpoint, timeoutMs = 4000 } = {}) {
  const key = cacheKey(result);
  if (memory.has(key)) return memory.get(key);

  const stored = globalThis.localStorage?.getItem(`narr:${key}`);
  if (stored) { memory.set(key, stored); return stored; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: result }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const { text } = await res.json();
    if (!text) return null;
    memory.set(key, text);
    globalThis.localStorage?.setItem(`narr:${key}`, text);
    return text;
  } catch {
    return null;   // 네트워크·타임아웃·파싱 실패 전부 여기로. 사용자에게 노출하지 않는다.
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
node --test web/tests/narrate-ai.test.js
```
Expected: 4 pass

- [ ] **Step 5: `worker/src/index.js` 구현**

```javascript
// 카카오·OpenRouter 키 은닉용 얇은 프록시. 판정 로직은 여기 없다.
//
// 카카오 REST 키는 도메인 화이트리스트 대상이 아니라 프론트에 두면 그대로 털린다.
// 이 Worker가 유일한 호출 지점이다 — 스펙 9.2.3.

const ALLOWED_ORIGINS = ["https://dhshin6023.github.io", "http://localhost:8080"];

const cors = (origin) => ({
  "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
});

const json = (body, origin, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...cors(origin) },
  });

async function geocode(query, env, origin) {
  const url = new URL("https://dapi.kakao.com/v2/local/search/address.json");
  url.searchParams.set("query", query);
  let res = await fetch(url, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` } });
  let doc = res.ok ? (await res.json()).documents?.[0] : null;

  if (!doc) {   // 도로명·지번 실패 시 키워드 검색으로 한 번 더
    const kw = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
    kw.searchParams.set("query", query);
    res = await fetch(kw, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` } });
    doc = res.ok ? (await res.json()).documents?.[0] : null;
  }
  if (!doc) return json({ error: "주소를 찾지 못했습니다" }, origin, 404);

  const region = doc.address ?? doc.road_address ?? doc;
  return json({
    lng: Number(doc.x), lat: Number(doc.y),
    gu_code: String(region.b_code ?? "").slice(0, 5),
    dong_code: String(region.b_code ?? "").slice(0, 8),
    address: doc.address_name ?? query,
  }, origin);
}

async function askModel(env, system, user, maxTokens) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENROUTER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.MODEL ?? "google/gemini-2.0-flash-exp:free",
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
}

// 입구: 자유 입력 업종 → 표준 코드. 확신이 없으면 null을 반환하고 프론트가 목록 선택으로 폴백한다.
async function mapIndustry(body, env, origin) {
  const list = (body.candidates ?? []).map((c) => `${c.code}:${c.name}`).join("\n");
  const text = await askModel(env,
    "너는 업종 분류기다. 주어진 목록에서 가장 가까운 코드 하나만 출력한다. " +
    "확실하지 않으면 정확히 NONE 이라고만 출력한다. 다른 말은 하지 않는다.",
    `입력: ${body.text}\n\n목록:\n${list}`, 16);
  const code = text && text !== "NONE"
    ? (body.candidates ?? []).find((c) => text.includes(c.code))?.code ?? null
    : null;
  return json({ code }, origin);
}

// 출구: 판정 결과 → 해설. 판정을 바꾸지 못하게 프롬프트로 봉한다.
async function narrate(body, env, origin) {
  const text = await askModel(env,
    "너는 상권분석 결과를 설명하는 조력자다. 다음 규칙을 반드시 지킨다.\n" +
    "1. 주어진 등급과 수치를 바꾸거나 재해석하지 않는다.\n" +
    "2. 성공 확률을 %로 말하지 않는다.\n" +
    "3. 주어진 데이터에 없는 사실을 지어내지 않는다.\n" +
    "4. 3~5문장, 존댓말, 창업 선배가 말하듯 담백하게.",
    JSON.stringify(body.payload), 400);
  return json({ text }, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") ?? "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    const { pathname, searchParams } = new URL(request.url);
    try {
      if (pathname === "/geocode") return await geocode(searchParams.get("q") ?? "", env, origin);
      if (pathname === "/map-industry") return await mapIndustry(await request.json(), env, origin);
      if (pathname === "/narrate") return await narrate(await request.json(), env, origin);
      return json({ error: "not found" }, origin, 404);
    } catch (error) {
      return json({ error: String(error) }, origin, 500);
    }
  },
};
```

`worker/wrangler.toml`:
```toml
name = "sanggwon-proxy"
main = "src/index.js"
compatibility_date = "2026-08-01"
```

`worker/README.md`:
```markdown
# sanggwon-proxy

카카오·OpenRouter 키 은닉용 프록시. 판정 로직 없음.

## 배포

```bash
npx wrangler login
npx wrangler secret put KAKAO_REST_KEY
npx wrangler secret put OPENROUTER_KEY
npx wrangler deploy
```

키는 절대 `wrangler.toml` 이나 코드에 넣지 않는다. `secret put` 만 사용한다.
배포 후 출력되는 `*.workers.dev` 주소를 `web/js/main.js` 의 `PROXY` 상수에 넣는다.
```

- [ ] **Step 6: `web/js/main.js` 에 AI 입구·출구 연결**

`mapIndustry`를 async로 바꾸고 AI를 먼저 시도한다:
```javascript
async function mapIndustry(text) {
  const q = text.trim();
  const local = meta.industries.find((i) => i.name.includes(q) || q.includes(i.name));
  if (local) return local;
  try {
    const res = await fetch(`${PROXY}/map-industry`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: q, candidates: meta.industries }),
    });
    const { code } = await res.json();
    return meta.industries.find((i) => i.code === code) ?? null;
  } catch {
    return null;   // 목록 선택 폴백은 호출부가 처리한다
  }
}
```

`analyze()`의 반환 직전에 AI 해설을 덧붙인다:
```javascript
  const aiText = await aiNarration(
    { ...verdict, industryName: industry.name, areaName: area.name, floor },
    { endpoint: `${PROXY}/narrate` },
  );
  return { ...base, areaName: area.name, verdict,
           narration: { ...narration, aiText }, alternatives };
```

`render.js`에서 `narration.aiText`가 있으면 요인 목록 위에 문단으로 출력한다. 없으면 아무것도 하지 않는다.

임포트 두 줄을 수정:
```javascript
import { templateNarration, aiNarration } from "./narrate.js";
```

- [ ] **Step 7: 배포 및 통합 확인**

```bash
cd worker && npx wrangler deploy
```
출력된 주소를 `web/js/main.js`의 `PROXY`에 넣는다. 그다음:

```bash
node --test web/tests/          # 34 pass
cd web && python3 -m http.server 8080
```

브라우저에서 실주소로 확인할 것:
1. 정상 주소 → 등급·근거·대안이 나온다
2. 개발자도구 Network 탭에서 `/narrate` 를 **차단**했을 때 → 여전히 등급과 근거가 나온다 (템플릿 폴백)
3. 상권 밖 주소 → 🟡 또는 🔴 이 뜨고 인근 상권 데이터로 조용히 대체되지 않는다

- [ ] **Step 8: 커밋**

```bash
git add worker/ web/js/main.js web/js/narrate.js web/js/render.js web/tests/narrate-ai.test.js
git commit -m "feat(worker): 카카오·OpenRouter 프록시 + AI 입구/출구 + 해설 캐싱"
```

---

## Task 13: 검증 세트 대조 + 도메인 자산 확정

**Files:**
- Create: `docs/validation-set.md`
- Create: `etl/tests/test_validation_set.py`
- Modify: `data/domain/industry_groups.json`
- Modify: `data/domain/axis_weights.json`
- Modify: `data/domain/floor_coefficients.json`
- Modify: `data/domain/startup_filter.json`

**Interfaces:**
- Consumes: 전체 파이프라인
- Produces: `provisional: false` 인 도메인 자산 4종 + 검증 결과 기록

**이것이 최종 품질 게이트다**(스펙 12). 여기까지는 코드가 도는지를 봤고, 여기서는 **판정이 쓸모 있는지**를 본다. 이 태스크의 작업 주체는 신동환이며 코드는 대조를 돕는 역할만 한다.

- [ ] **Step 1: 업종 그룹 배정 (신동환)**

`data/domain/industry_groups.json`의 `assignment`에서 각 업종의 `"group"`을 실제 값으로 바꾼다. 100개 전부 배정하고 누락을 남기지 않는다. 끝나면 `"provisional": false`.

```bash
.venv/bin/python - <<'PY'
import json
from etl.config import DOMAIN_DIR
d = json.loads((DOMAIN_DIR / "industry_groups.json").read_text(encoding="utf-8"))
from collections import Counter
c = Counter(v["group"] for v in d["assignment"].values())
print(f"총 {len(d['assignment'])}개 업종")
for g, n in c.most_common():
    print(f"  {g}: {n}")
print("⚠️ 한 그룹에 몰려 있으면 아직 배정 전이다")
PY
```

- [ ] **Step 2: 4축 가중치 확정 (신동환)**

`axis_weights.json`에서 그룹별로 6개 키(`resident`/`worker`/`footfall`/`competition`/`vitality`/`fit`)의 합이 정확히 1.0이 되도록 채운다. 유동의존형은 `footfall`을, 배후의존형은 `resident`를 높이는 식이다. `"provisional": false`.

- [ ] **Step 3: 층수 계수 확정 (신동환)**

`floor_coefficients.json`에서 그룹 × 5구간 계수를 채운다. `1.0`이 기준, `0.4`면 그 자리에서 그 업종은 반토막이라는 뜻이다. `warn_below`(기본 0.75) 미만이면 경고가 뜬다. `"basis": "heuristic"` 은 그대로 둔다 — 근거의 성격을 지우지 않는다.

- [ ] **Step 4: 창업 필터 확정 (신동환)**

`startup_filter.json`의 `excluded` 배열에 자격증·고액자본 업종 코드를 채운다.

- [ ] **Step 5: 자산 정합성 테스트 작성**

`etl/tests/test_validation_set.py`:
```python
import json

import pytest

from etl.adapters import seoul
from etl.config import DOMAIN_DIR, FLOORS
from etl.engine import scoring


def _read(name: str) -> dict:
    return json.loads((DOMAIN_DIR / name).read_text(encoding="utf-8"))


def test_no_industry_left_unassigned():
    assets = scoring.load_domain()
    codes = set(seoul.normalize().industries["industry_code"].astype(str))
    missing = codes - set(assets.groups)
    assert not missing, f"그룹 미배정 업종 {len(missing)}개: {sorted(missing)[:10]}"


def test_weights_sum_to_one_exactly():
    for group, w in _read("axis_weights.json")["weights"].items():
        assert sum(w.values()) == pytest.approx(1.0, abs=1e-9), f"{group} 합={sum(w.values())}"


def test_floor_table_complete_and_positive():
    for group, table in _read("floor_coefficients.json")["coefficients"].items():
        assert set(table) == set(FLOORS), f"{group} 층수 누락"
        assert all(0 < v <= 1.5 for v in table.values()), f"{group} 계수 범위 이탈"


def test_floor_basis_still_declared_as_heuristic():
    """근거의 성격을 지우지 않는다 — 스펙 7.5."""
    assert _read("floor_coefficients.json")["basis"] == "heuristic"


def test_groups_are_differentiated():
    """전 그룹이 같은 가중치면 업종 그룹 구조가 무의미해진다."""
    weights = _read("axis_weights.json")["weights"]
    distinct = {tuple(sorted(w.items())) for w in weights.values()}
    assert len(distinct) > 1, "모든 그룹의 가중치가 동일하다 — 아직 잠정값이다"


def test_nothing_provisional_remains():
    for name in ("industry_groups.json", "axis_weights.json",
                 "floor_coefficients.json", "startup_filter.json"):
        assert _read(name).get("provisional") is False, f"{name} 아직 잠정값"
```

- [ ] **Step 6: 재빌드 후 테스트 실행**

```bash
.venv/bin/python -m etl.build
.venv/bin/python -m pytest etl/tests/ -v
```
Expected: 전체 통과. `test_nothing_provisional_remains`가 실패하면 Step 1~4가 아직 안 끝난 것이다.

- [ ] **Step 7: 검증 세트 대조 (신동환 — 최종 품질 게이트)**

`docs/validation-set.md`를 만들고 **본인이 실제로 아는 상권 10~20곳**에 대해 판정을 돌린 뒤 현장 감각과 대조한다.

```markdown
# 검증 세트 대조

목적: 판정이 코드로 도는지가 아니라 **쓸모가 있는지**를 확인한다.
기준: 현장 감각과 등급이 2단계 이상 어긋나면 실패로 간주하고 가중치를 재조정한다.

| # | 주소 | 층 | 업종 | 내 감각 | 판정 | 차이 | 메모 |
|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |

## 대조 결과

- 일치(0단계): __건
- 1단계 차이: __건
- 2단계 이상 차이: __건  ← 이게 3건 이상이면 가중치를 다시 본다

## 조정 이력

| 날짜 | 바꾼 것 | 이유 | 재대조 결과 |
|---|---|---|---|
```

**2단계 이상 어긋난 케이스가 3건 이상이면** 원인이 가중치인지 층수 계수인지 그룹 배정인지 특정하고 해당 파일만 고친 뒤 재빌드·재대조한다. 코드는 건드리지 않는다 — 도메인 자산이 데이터 파일인 이유가 이것이다.

- [ ] **Step 8: 공개 준비 확인**

```bash
.venv/bin/python -m pytest etl/tests/ -v && node --test web/tests/
grep -rn '"provisional": true' data/domain/ && echo "❌ 잠정값 남음" || echo "✅ 도메인 자산 확정"
```

- [ ] **Step 9: 커밋**

```bash
git add data/domain/ docs/validation-set.md etl/tests/test_validation_set.py web/data/
git commit -m "feat: 도메인 자산 확정 + 검증 세트 대조 완료"
```

---

## 신동환 선행 작업 (코드 착수와 무관하게 병렬 진행 가능)

| # | 항목 | 막는 태스크 |
|---|---|---|
| — | **서울 OpenAPI 인증키 발급** (data.seoul.go.kr 로그인 → 인증키 신청) → `.env` | **Task 1** ⚠️ 가장 시급 |
| ④ | 서울 상권영역 **SHP 확인** — 폴리곤 여부 확정. API로는 해결 불가(중심점만 제공) | **Task 1 (분기 판정)** |
| ⑤ | 카카오 개발자 콘솔 — 기존 앱에 도메인 추가로 쿼터 공유 가능한지 | Task 12 |
| ⑦ | 사용 데이터셋별 공공누리 유형 확인 | 공개 배포 전 |
| ⑧ | 도메인 자산 4종 작성 | **Task 13** (Task 1~12는 시드로 진행 가능) |

**⑥ 소진공 API 코드 자릿수 모순**은 이 계획에서 제외했다. 서울 단독 런칭에서는 소진공 데이터도 KSIC 매핑표도 사용하지 않기 때문이다 — 경기 확장 시점에 다시 꺼낸다.

---

## 자체 검토

**스펙 커버리지 대조**

| 스펙 절 | 대응 |
|---|---|
| 5.1 서울 단독, 4축, 4단계, 패턴, 대안, 정밀도 | Task 4·5·6·8·9·10 |
| 5.2 제외 항목 | Global Constraints + `test_no_percentage_success_field_anywhere` |
| 6.1 입력 3개 | Task 11 `index.html` |
| 6.2 출력 구조 | Task 11 `render.js` |
| 7.1 4축 / 점포당매출 | Task 4 |
| 7.2 등급·동일업종 백분위 | Task 5 `grade_cuts` |
| 7.3 패턴 4종 | Task 6 |
| 7.4 업종 그룹 가중치 | Task 5 + Task 13 |
| 7.5 층수 이중처리·휴리스틱 표기 | Task 9 `judge`/`floorWarning` + Task 11 `basisNote` |
| 8.1~8.3 대안 추천 | Task 10 |
| 9.2.1 SHP 분기 | Task 1 Step 4 → Task 3 |
| 9.2.3 키 은닉·캐싱 | Task 12 |
| 9.2.4 기준시점 표기 | Task 7 `meta.period_label` + Task 11 footer |
| 10.1 어댑터 층 | Task 2 (`test_normalize_has_no_source_column_names`가 계약을 강제) |
| 10.2 AI 두 곳·폴백 | Task 11(폴백 먼저) → Task 12 |
| 10.3 정밀도 3표기 | Task 8 `resolvePrecision` |
| 11 에러 처리 | Task 8·11·12 |
| 12 테스트 전략 | 각 태스크 + Task 13 |

**미커버 항목:** 스펙 9.2.2의 KSIC 매핑표는 서울 단독 런칭에서 쓰이지 않아 의도적으로 제외했다(경기 확장 시 필요). 스펙 11의 "좌표가 서울 밖" 처리는 Task 8의 `🔴 분석 불가` 경로에 흡수된다.

**타입 일관성:** `base_score`(Python) ↔ `entry.base`(JS)는 Task 7 `_write`에서 `"base"` 키로 변환되며 `test_score_file_shape`가 검증한다. `FLOORS`/`GRADES` 상수는 `etl/config.py`와 `web/js/verdict.js`에 각각 선언되고 양쪽 테스트에서 값을 고정 검사한다.
