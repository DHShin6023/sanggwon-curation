"""패턴 감지. 스펙 7.3.

점수 평균에 묻히면 안 되는 조합 신호를 별도 레이어로 잡는다.
등급 계산에는 관여하지 않는다.
"""
import pandas as pd

PATTERNS = ("함정상권", "침몰상권", "포화", "블루오션")

# 임계값. 조정 시 스펙 7.3 표와 함께 검토한다.
#
# ⚠️ competition은 백분위가 아니다. 두 백분위의 0.6/0.4 가중합이라 분포가
# 가운데로 몰린다(평균 49.8, 표준편차 20.9). 실제 5분위 값은 15.98이므로
# `competition <= 5`는 5%가 아니라 0.50%를 고른다 — 초안이 이 착각으로 포화를
# 10배 미탐했다(스펙 대상 1,136행 중 105행만 잡힘). 「상위 N%」를 뜻하는
# 임계값은 반드시 원 지표의 백분위 컬럼(sales_per_store_pct, density_pct)에
# 걸고, competition에는 "여유롭다" 같은 방향성 판단만 건다.
FOOTFALL_HIGH = 80.0        # 유동 상위 (demand_raw_footfall 백분위)
SALES_PER_STORE_LOW = 30.0  # 점포당매출 하위 (sales_per_store_pct 백분위)
SATURATION_TOP = 95.0       # 점포밀도 상위 5% (density_pct 백분위) — 스펙 7.3
BACKING_HIGH = 70.0         # 배후 충분 (인구 백분위)
COMPETITION_HIGH = 70.0     # 경쟁 여유 — 합성 경쟁축의 방향성 판단(백분위 아님)
BLUE_OCEAN_MAX_STORES = 5   # 이미 점포가 많으면 블루오션이 아니다
SALES_DROP = -0.05          # 매출 -5% 이하
CLOSE_RATE_HIGH = 0.10      # 폐업률 10% 이상

# 패턴별 입력. 하나라도 결측이면 "패턴 없음"이 아니라 "미평가"다.
PATTERN_INPUTS = {
    "함정상권": ("demand_raw_footfall", "sales_per_store_pct"),
    "침몰상권": ("sales_trend", "close_rate", "store_delta"),
    "포화": ("density_pct",),
    "블루오션": ("demand_raw_resident", "demand_raw_worker",
              "competition", "store_count"),
}


def detect(axis_df: pd.DataFrame, industries: pd.DataFrame) -> pd.DataFrame:
    """4종 패턴을 판정한다. 반환은 `patterns`(감지됨)와 `patterns_unknown`
    (입력이 없어 판정 못 함) 둘로 나뉜다.

    둘을 합치지 않는 이유: 비교 연산은 NaN에 False를 주므로 입력이 없으면
    조용히 "패턴 없음"이 된다. 화면에서 "경고 없음"과 "확인 못 함"은 전혀 다른
    말인데 그대로 두면 구분이 사라진다. 실측으로 침몰상권이 이 함정에 걸려
    있었다 — sales_trend 결측 1,101행 중 1,076행은 등급이 정상 부여되어,
    사용자는 "최악 조합 아님"으로 읽지만 실제로는 세 조건 중 하나를 평가조차
    못 한 상태였다.
    """
    merged = axis_df.merge(
        industries[["area_code", "industry_code", "store_count",
                    "sales_trend", "close_rate", "store_delta"]],
        on=["area_code", "industry_code"], how="left",
    )

    num = {c: pd.to_numeric(merged[c], errors="coerce")
           for cols in PATTERN_INPUTS.values() for c in cols}
    # 배후는 두 인구 중 큰 쪽 — 하나만 있어도 판정할 수 있다
    backing = pd.concat([num["demand_raw_resident"], num["demand_raw_worker"]],
                        axis=1).max(axis=1)

    flags = pd.DataFrame({
        # 스펙 7.3: 통행량은 많은데 점포당매출이 낮다 = 통행이 소비로 안 이어짐.
        # 밀도를 섞은 합성 경쟁축을 쓰면 다른 상권이 잡힌다(실측 대칭차 890행).
        "함정상권": ((num["demand_raw_footfall"] >= FOOTFALL_HIGH)
                  & (num["sales_per_store_pct"] <= SALES_PER_STORE_LOW)),
        "침몰상권": ((num["sales_trend"] <= SALES_DROP)
                  & (num["close_rate"] >= CLOSE_RATE_HIGH)
                  & (num["store_delta"] > 0)),
        "포화": num["density_pct"] >= SATURATION_TOP,
        "블루오션": ((backing >= BACKING_HIGH)
                  & (num["competition"] >= COMPETITION_HIGH)
                  & (num["store_count"] <= BLUE_OCEAN_MAX_STORES)),
    })

    unknown = pd.DataFrame({
        "함정상권": num["demand_raw_footfall"].isna() | num["sales_per_store_pct"].isna(),
        "침몰상권": (num["sales_trend"].isna() | num["close_rate"].isna()
                  | num["store_delta"].isna()),
        "포화": num["density_pct"].isna(),
        "블루오션": (backing.isna() | num["competition"].isna()
                  | num["store_count"].isna()),
    })
    # 판정 못 한 패턴은 감지 목록에서 뺀다 — False가 "아님"으로 읽히면 안 된다
    flags = flags & ~unknown

    def names(frame: pd.DataFrame) -> list[list[str]]:
        arr = frame[list(PATTERNS)].to_numpy(dtype=bool)
        return [[n for n, on in zip(PATTERNS, row) if on] for row in arr]

    merged["patterns"] = names(flags)
    merged["patterns_unknown"] = names(unknown)
    return merged[["area_code", "industry_code", "patterns", "patterns_unknown"]]
