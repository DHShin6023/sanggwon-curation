"""어댑터와 판정 엔진 사이의 유일한 계약.

이 파일을 바꾼다는 것은 계약을 바꾼다는 뜻이다. 어댑터(서울, 향후 경기 등)와
엔진 양쪽을 모두 검토해야 한다. 스펙 10.1 참조.
"""
from dataclasses import dataclass

import pandas as pd

# 백분위 채점 풀. 상권 종류가 다르면 같은 잣대로 잴 수 없다.
#
# 실측(2026-08-08): 한 풀로 묶으면 골목상권 물건지의 업종내 백분위 중앙값이
# 40.4점으로 눌리고 상위 25% 진입률이 17.1%에 그친다(기대 25%). 타겟인 예비
# 창업자가 보는 물건은 대부분 골목상권이라, 어딜 찍어도 "중하"가 나와 후보를
# 걸러주지 못한다. 업종별 백분위를 쓰는 이유(스펙 7.2)와 같은 논리 — 창업자가
# 바꿀 수 없는 구조적 조건은 비교 대상에서 빼고 같은 조건끼리 겨룬다.
#
# 관광특구는 6곳뿐이라 단독 풀로 두면 (업종 × 풀) 그룹 중앙값이 4행까지 떨어져
# 백분위가 잡음이 된다 → 발달상권과 함께 "광역"으로 묶는다.
AREA_TYPES = {
    "A": "alley",    # 골목상권 1,090곳
    "R": "market",   # 전통시장 305곳 — 시장 안 점포는 골목 점포와 경제구조가 다르다
    "D": "metro",    # 발달상권 249곳
    "U": "metro",    # 관광특구 6곳
}

# 상권 단위 지표 — 업종과 무관한 것들
AREA_COLUMNS = [
    "area_code",      # str  상권 코드
    "area_name",      # str  상권명
    "area_type",      # str  AREA_TYPES의 값 — 백분위 채점 풀의 키
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
