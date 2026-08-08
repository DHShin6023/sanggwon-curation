"""서울 열린데이터광장 OpenAPI 수집기.

수집과 스키마 검증만 담당하고 가공은 하지 않는다 — 가공은 adapters/seoul.py의 책임.
받은 원본은 data/raw/{dataset}.parquet 에 캐시해 재호출을 피한다.

API 명세 (2026-08-08 실호출 확인):
  http://openapi.seoul.go.kr:8088/{인증키}/json/{서비스명}/{시작행}/{끝행}/{분기코드}/
  1회 최대 1,000행. 호출 횟수 제한은 없음(실시간 지하철 API만 1일 1,000회 제한).
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
    "area": ["TRDAR_CD", "TRDAR_CD_NM", "TRDAR_SE_CD", "XCNTS_VALUE",
             "YDNTS_VALUE", "SIGNGU_CD", "ADSTRD_CD", "RELM_AR"],
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


def _call(service: str, start: int, end: int, period: str | None,
          tolerant: bool = False) -> dict | None:
    """tolerant=True면 데이터 없음(INFO-200 등)에 예외 대신 None을 준다."""
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
            if tolerant:
                return None
            raise SchemaError(f"{service} 호출 실패: {body.get('RESULT', body)}")
        return body[service]
    raise SchemaError(f"{service} 재시도 소진")


def current_quarter() -> str:
    """오늘이 속한 분기 코드 (예: 20263)."""
    from datetime import date

    today = date.today()
    return f"{today.year}{(today.month - 1) // 3 + 1}"


def shift_quarters(period: str, back: int) -> str:
    year, quarter = int(period[:4]), int(period[4])
    total = year * 4 + (quarter - 1) - back
    return f"{total // 4}{total % 4 + 1}"


def quarter_distance(later: str, earlier: str) -> int:
    def index(p: str) -> int:
        return int(p[:4]) * 4 + int(p[4]) - 1
    return index(later) - index(earlier)


MAX_LOOKBACK_QUARTERS = 12   # 3년


def latest_period(service: str) -> str:
    """게시된 최신 분기.

    응답 표본에서 max를 뽑으면 안 된다 — API가 분기순으로 정렬해 주지 않아서
    첫 1,000행에 어떤 분기가 걸리느냐에 따라 엉뚱한 값이 나온다(실제로 sales가
    2022년으로 잡혔다). 오늘 분기부터 거꾸로 짚어 데이터가 있는 첫 분기를 찾는다.
    """
    probe = current_quarter()
    for _ in range(MAX_LOOKBACK_QUARTERS):
        body = _call(service, 1, 1, probe, tolerant=True)
        if body and int(body.get("list_total_count", 0)) > 0:
            return probe
        probe = shift_quarters(probe, 1)
    raise SchemaError(
        f"{service}: 최근 {MAX_LOOKBACK_QUARTERS}분기 안에 데이터가 없다"
    )


def _recent_periods(service: str) -> list[str]:
    """최신 분기와 그 4분기 전 (sales_trend 계산에 둘 다 필요)."""
    latest = latest_period(service)
    return [latest, shift_quarters(latest, 4)]


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

    # resident/worker는 분기 필터가 무시되므로 여기서 최신 분기들만 남긴다.
    if "STDR_YYQU_CD" in df.columns and not QUARTER_FILTER[dataset]:
        keep = sorted(df["STDR_YYQU_CD"].astype(str).unique())[-NEEDED_PERIODS * 4:]
        df = df[df["STDR_YYQU_CD"].astype(str).isin(keep)]

    return df.reset_index(drop=True)
