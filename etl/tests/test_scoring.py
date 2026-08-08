import numpy as np
import pandas as pd
import pytest

from etl.config import FLOORS, GRADES
from etl.engine import scoring


def _axis_df() -> pd.DataFrame:
    return pd.DataFrame({
        "area_code": ["A", "B", "C", "D"] * 2,
        "industry_code": ["CS1"] * 4 + ["CS2"] * 4,
        "area_type": ["alley", "alley", "metro", "metro"] * 2,
        "demand_raw_resident": [10, 40, 70, 100] * 2,
        "demand_raw_worker": [100, 70, 40, 10] * 2,
        # 세 수요축은 서로 다른 패턴이어야 한다. 값이 겹치면 축을 잘못 배선해도
        # 테스트가 통과하고, resident와 같으면 그룹별 가중치 테스트 자체가
        # 수학적으로 성립하지 않는다.
        "demand_raw_footfall": [100, 10, 70, 40] * 2,
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
        floor_warn_below=0.75,
        floor_min_coefficient=0.6,
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


def test_unmapped_industry_raises():
    """분류표에 없는 업종코드를 통과시키면 그 업종이 서울 전역에서 조용히
    '판정 불가'가 되고, 경쟁 데이터 결측과 구분되지 않는다."""
    df = _axis_df()
    df.loc[0, "industry_code"] = "ZZZ"
    with pytest.raises(ValueError, match="ZZZ"):
        scoring.base_score(df, _assets())


def test_grade_of_rejects_non_float64_nan():
    """isinstance(x, float)는 np.float32 NaN에 False다 — 그냥 두면 없는 점수에서
    '하' 등급이 지어져 나온다."""
    for bad in (np.float32("nan"), np.float64("nan"), None, pd.NA):
        with pytest.raises(ValueError):
            scoring.grade_of(bad, [75.0, 50.0, 25.0])


def test_missing_competition_withholds_the_grade():
    """경쟁축이 없으면 등급을 내지 않는다 (2026-08-08 결정).

    나머지 3축으로 등급을 내면 사용자는 경쟁 정보 없이 나온 판정임을 모른다.
    창업 판단에서 경쟁 강도는 뺄 수 없는 축이라, 없으면 🔴 분석 불가로 보낸다.
    """
    df = _axis_df()
    df.loc[0, "competition"] = float("nan")
    out = scoring.base_score(df, _assets())
    assert pd.isna(out.loc[0, "base_score"]), "경쟁축 없이 등급이 나왔다"
    # 대조군: 다른 축이 빠지는 건 재정규화로 흡수한다
    df2 = _axis_df()
    df2.loc[0, "vitality"] = float("nan")
    assert not pd.isna(scoring.base_score(df2, _assets()).loc[0, "base_score"])


def test_grades_are_even_across_pools():
    """골목상권 물건지가 등급에서 눌리면 안 된다 — 서비스가 후보를 못 걸러낸다.

    업종 단위 컷 하나로 모든 상권종류를 끊는 설계의 전제(6축이 이미 풀 내부
    백분위이므로 풀마다 0~100을 고르게 채운다)를 실데이터로 확인한다.
    한 풀로 매기던 시절 골목상권의 백분위 중앙값은 40.4점이었다.
    """
    from etl.adapters import seoul
    from etl.engine import axes

    # 실제 업종코드를 전부 덮는 자산이 필요하므로 seed_domain.py가 만든 것을 쓴다
    scored = scoring.base_score(axes.score(seoul.normalize()), scoring.load_domain())
    cuts = scoring.grade_cuts(scored)
    scored = scored.dropna(subset=["base_score"])
    scored["grade"] = [
        scoring.grade_of(s, cuts[c]) if c in cuts else None
        for s, c in zip(scored["base_score"], scored["industry_code"])
    ]
    share = scored.groupby("area_type")["grade"].value_counts(normalize=True).unstack()
    # 실측(수정 후): 네 등급 모두 세 풀에서 24~26%. 밴드를 20~30%로 좁게 잡아야
    # 축 하나가 풀 밖 기준으로 매겨지는 회귀를 잡는다 — 15~35%였다면 18.9%까지
    # 무너진 상태도 통과했을 것이다.
    for pool in share.index:
        for grade in GRADES:
            got = share.loc[pool, grade]
            assert 0.20 <= got <= 0.30, f"{pool} 풀의 '{grade}' 비율 {got:.1%} — 25% 근처여야 한다"


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
