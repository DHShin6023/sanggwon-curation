"""서울 원본 → 공통 지표 형식. 서울 스키마 지식은 이 파일 안에만 존재한다.

필드명은 2026-08-08 OpenAPI 실호출로 확인한 값이다.
"""
import pandas as pd

from etl.adapters.schema import (AREA_COLUMNS, AREA_TYPES, INDUSTRY_COLUMNS,
                                 Normalized)
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
    area_type = area["TRDAR_SE_CD"].astype(str).str.strip().map(AREA_TYPES)
    unknown = sorted(area.loc[area_type.isna(), "TRDAR_SE_CD"].astype(str).unique())
    if unknown:
        raise ValueError(
            f"AREA_TYPES에 없는 상권구분 코드: {unknown}. 채점 풀을 정하지 못하므로 "
            "임의로 분류하지 않는다 — schema.AREA_TYPES를 갱신할 것"
        )

    areas = pd.DataFrame({
        "area_code": area[_AREA].astype(str),
        "area_name": area["TRDAR_CD_NM"].astype(str),
        "area_type": area_type,
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
            src[_AREA].astype(str))["_v"].sum(min_count=1).rename(target)
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
        ind["sales_total"].div(ind["store_count"].where(ind["store_count"] > 0)))

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
