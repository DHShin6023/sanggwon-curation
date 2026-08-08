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
    """축 점수 + 원지표 조합으로 4종 패턴을 판정한다.

    competition은 경쟁축 필수 결정(Task 5)에 따라 365/21,188행이 NaN이다.
    비교 연산(<=, >=)은 NaN에 대해 False를 반환하므로 flags 자체가 이미
    "모름"을 "패턴 아님"으로 조용히 바꾸지 않는다 — 다만 마지막 fillna(False)는
    비교 결과가 NaN(pandas nullable dtype 등)으로 새어나오는 경우를 대비한
    방어이며, 결측 축에서 패턴을 지어내는 목적이 아니다.
    """
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
