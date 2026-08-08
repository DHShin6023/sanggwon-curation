// 층수 보정 + 등급 판정. 스펙 7.2 / 7.5.
//
// ETL이 만든 base(층수 미적용 가중합)에 층수 계수를 곱해 등급컷과 대조한다.
// 층수는 사용자 입력이라 사전 계산할 수 없어 이 한 조각만 브라우저에 남는다.
//
// ⚠️ 층수 계수는 공공데이터 산출값이 아니라 도메인 휴리스틱이다.
//    공공데이터에 층별 매출이 존재하지 않는다 — 화면에 그 성격을 표기한다.
//
// ⚠️ data/domain/floor_coefficients.json은 현재 provisional 상태다: 6개 그룹
//    전부 계수가 1.0이라 applyFloor는 사실상 항등함수이고 floorWarning은
//    실 데이터로는 절대 발동하지 않는다. 이 파일의 로직은 브리핑이 준 합성
//    FLOOR_TABLE(실제로 변화하는 계수)로 테스트해야 검증된다 — 출하된 JSON을
//    돌려서 "동작 확인됨"이라고 결론 내리지 않는다.

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

// base가 없으면(경쟁축 등 필수 입력 누락) 판정하지 않고 던진다. 이건 방어적
// 코드가 아니라 실제로 밟히는 경로다 — 실데이터에 base:null 업종행이 365개
// 있다. 호출부(Task 11)는 이 에러를 반드시 잡아서 등급 대신 🔴 "분석 불가"를
// 그려야 한다: 잡지 않으면 페이지가 죽고, 삼켜서 무시하면 없는 등급을
// 지어내는 것이 된다. 메시지에 "base"를 담아 원인을 바로 알 수 있게 한다.
export function judge({ entry, cuts, group, floor, floorTable, warnBelow }) {
  if (entry?.base === null || entry?.base === undefined) {
    throw new Error("judge: entry.base가 없어 판정할 수 없다 (경쟁축 등 필수 입력 누락 — 호출부는 등급 대신 분석 불가로 표시할 것)");
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
    // patterns_unknown: "경고 없음"과 "확인 못 함"은 다른 진술이다. 전자를
    // 못 채우면 이 필드가 죽은 데이터가 되어 화면에 절대 닿지 못한다.
    patternsUnknown: entry.patterns_unknown ?? [],
    axes: entry.axes ?? {},
    storeCount: entry.store_count ?? null,
    salesPerStore: entry.sales_per_store ?? null,
  };
}
