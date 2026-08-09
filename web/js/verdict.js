// 층수 보정 + 등급 판정. 스펙 7.2 / 7.5.
//
// ETL이 만든 base(층수 미적용 가중합)에 층수 계수를 곱해 등급컷과 대조한다.
// 층수는 사용자 입력이라 사전 계산할 수 없어 이 한 조각만 브라우저에 남는다.
//
// ⚠️ 층수 계수는 공공데이터 산출값이 아니라 도메인 휴리스틱이다.
//    공공데이터에 층별 매출이 존재하지 않는다 — 화면에 그 성격을 표기한다.
//
// ⚠️ 2026-08-09: 신동환 확정 계수가 들어오면서 이 파일이 **실제로 동작하기
//    시작했다.** 예전 주석은 "6개 그룹 전부 1.0이라 applyFloor는 항등함수이고
//    floorWarning은 절대 발동하지 않는다"였는데 셋 다 지금은 거짓이다:
//    7개 그룹, 계수 0.5~1.0, warn_below(0.75) 미만 조합이 8개라 경고가 뜬다.
//    (1층만 7개 그룹 전부 1.0인데, 이건 잠정값이라서가 아니라 1층이 상대값의
//    기준점이기 때문이다.)
//
//    `provisional: true`는 여전히 유효하다 — 값이 정해진 것과 실제와 맞는지
//    확인된 것은 다르고, 화면 배너가 그 사실을 밝힌다. 검증은 런칭 후
//    실사용으로 한다(Task 13 폐기, 2026-08-09).

export const FLOORS = ["B1", "F1", "F2", "F3P", "DETACHED"];
export const FLOOR_LABELS = {
  B1: "지하", F1: "1층", F2: "2층", F3P: "3층 이상", DETACHED: "단독건물",
};
export const GRADES = ["상", "중상", "중하", "하"];
// 등급은 **자리와 업종의 궁합을 서술**할 뿐, 창업 여부를 결정해주지 않는다
// (2026-08-09 신동환 사상 정리).
//
// 예전 문구는 "적극 추천 / 해볼 만함 / 권하지 않음 / 말립니다"였다. 넷 다
// **창업이라는 결정에 대한 조언**이고, 「말립니다」는 사실상 실패 예측이다.
// 우리가 잴 수 있는 건 상권·입지의 좋고 나쁨까지다 — 그 자리에서 개별 점포가
// 성공할지는 운영·타이밍·운이 갈라서 아무도 모른다. 잴 수 없는 것을 말하는
// 문구는 이 프로젝트가 계속 잡아온 결함(데이터가 뒷받침 못 하는 단정)의
// 제품 수준 재발이다.
//
// 그래서 넷 다 **자리를 서술하는 말**로 바꾼다. 결정은 창업자가 한다.
export const GRADE_MEANING = {
  상: "이 업종에 잘 맞는 자리",
  중상: "무난한 편, 확인할 약점 있음",
  중하: "약점이 뚜렷한 자리",
  하: "이 업종과는 잘 맞지 않는 자리",
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
//
// 일부러 4단계 굵은 버킷("상위 25% 이내" 등)만 반환한다. cuts는 상/중상/중하
// 3개의 컷 점수일 뿐 전체 분포가 아니라서, 그 3점만으로 "상위 12%" 같은 정밀
// 백분위를 만들어내면 실제로는 없는 정밀도를 지어내는 것이다 — 이 프로젝트가
// 명시적으로 금지하는 종류의 결함이라 굵은 버킷으로 고정한다.
export function rankLabel(score, cuts) {
  const [top, mid, low] = cuts;
  if (score >= top) return "상위 25% 이내";
  if (score >= mid) return "상위 50% 이내";
  if (score >= low) return "하위 50%";
  return "하위 25%";
}

// group/floor 조합의 계수를 찾는다. "이 그룹은 실제로 계수가 1.0이다"와
// "이 그룹이 테이블에 아예 없다"는 다른 사실이다 — 후자를 전자로 읽으면
// (예전처럼 `?? 1.0`으로 조용히 메우면) 업종→그룹 매핑 오타나 그룹명 변경,
// 한글 키 인코딩 차이 하나가 층수 보정을 통째로 무시한 채 등급을 만들어낸다.
// base가 null일 때 던지는 것과 같은 이유로, 여기서도 조용히 넘어가지 않고
// 어느 키가 없는지 이름으로 집어 던진다 — 이건 사용자가 고칠 수 있는 입력이
// 아니라 배포 설정 오류이기 때문이다.
function floorCoefficient({ group, floor, floorTable }) {
  const groupTable = floorTable?.[group];
  if (groupTable === undefined) {
    throw new Error(
      `floorCoefficient: 알 수 없는 업종군 "${group}" — floorTable에 이 그룹이 없다 (업종→그룹 매핑 오류 가능성)`
    );
  }
  const coefficient = groupTable[floor];
  if (coefficient === undefined) {
    throw new Error(
      `floorCoefficient: 알 수 없는 층수 "${floor}" (업종군 "${group}") — floorTable[${group}]에 이 층수 키가 없다`
    );
  }
  return coefficient;
}

export function floorWarning({ group, floor, floorTable, warnBelow }) {
  const coefficient = floorCoefficient({ group, floor, floorTable });
  if (coefficient >= warnBelow) return null;
  return {
    severity: coefficient < warnBelow * 0.7 ? "critical" : "caution",
    coefficient,
    message:
      `${FLOOR_LABELS[floor]} 위치는 이 업종(${group})과 궁합이 좋지 않습니다. ` +
      `유동인구가 많더라도 상당 부분이 체감되지 않습니다.`,
    basis: "heuristic",
  };
}

// base가 없으면(경쟁축 등 필수 입력 누락) 판정하지 않고 던진다. 이건 방어적
// 코드가 아니라 실제로 밟히는 경로다 — 실데이터에 base:null 업종행이 365개
// 있다. 호출부(Task 11)는 이 에러를 반드시 잡아서 등급 대신 🔴 "분석 불가"를
// 그려야 한다: 잡지 않으면 페이지가 죽고, 삼켜서 무시하면 없는 등급을
// 지어내는 것이 된다. 메시지에 "base"를 담아 원인을 바로 알 수 있게 한다.
export function judge({ entry, cuts, group, floor, floorTable, warnBelow }) {
  if (entry?.base === null || entry?.base === undefined) {
    throw new Error("judge: entry.base가 없어 판정할 수 없다 (경쟁축 등 필수 입력 누락 — 호출부는 등급 대신 분석 불가로 표시할 것)");
  }
  const coefficient = floorCoefficient({ group, floor, floorTable });
  const score = applyFloor(entry.base, coefficient);
  return {
    score,
    grade: gradeOf(score, cuts),
    meaning: GRADE_MEANING[gradeOf(score, cuts)],
    // ⚠️ rank는 **층수 적용 전 base**로 낸다. score로 내면 안 된다.
    //
    // cuts는 base_score 분포의 분위수다(scoring.py의 grade_cuts). 층수로 깎인
    // score를 안 깎인 cuts에 대면 서울 전역 순위가 아니라 아무것도 아닌 값이
    // 나온다. 실제로 그렇게 돼 있었고, 화곡역 4번/화장품(base 88.90 — 서울
    // 화장품 중 1등, 상위 컷은 60.60)이 3층에서 「하위 50%」로 표시됐다.
    // 화면 문장이 「서울 전역, 같은 업종」이라고 못박고 있으니 명백한 거짓이다.
    //
    // 순위는 **자리**의 속성이고, 층수는 그 위에 얹는 사용자의 선택이다.
    // 그래서 등급(층수 포함)과 순위(자리 자체)가 서로 다른 얘기를 할 수 있고,
    // 그게 오히려 이 서비스가 해줘야 할 말이다 — "자리는 서울 상위권인데
    // 3층이라 이 업종엔 중하로 본다". render.js가 그렇게 읽히도록 쓴다.
    rank: rankLabel(entry.base, cuts),
    warning: floorWarning({ group, floor, floorTable, warnBelow }),
    patterns: entry.patterns ?? [],
    // patterns_unknown: "경고 없음"과 "확인 못 함"은 다른 진술이다. 전자를
    // 못 채우면 이 필드가 죽은 데이터가 되어 화면에 절대 닿지 못한다.
    patternsUnknown: entry.patterns_unknown ?? [],
    axes: entry.axes ?? {},
    storeCount: entry.store_count ?? null,
    salesPerStore: entry.sales_per_store ?? null,
    // pool_size: 표본이 얇으면(n=5 등) percentile이 몇 개 값만 취할 수 있어
    // 사실상 잡음이다. patterns_unknown과 같은 이유로 judge()가 조합해서
    // 숨기지 않고 그대로 통과시킨다 — 얇은 표본을 숨기는 게 아니라
    // 정직하게 노출할지는 호출부(Task 11)의 판단이다.
    poolSize: entry.pool_size ?? null,
  };
}
