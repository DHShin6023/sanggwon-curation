// 대안 업종 추천. 스펙 8.
//
// 추가 데이터도 추가 로직도 없다 — 이미 만든 판정 엔진(judge())을 상권 내 전
// 업종에 한 번 더 돌리고 필터 두 겹을 통과한 상위 2개를 뽑는 것뿐이다.
//
// ⚠️ 필터 두 겹은 지금 둘 다 무력하다(provisional):
//    - data/domain/startup_filter.json의 excluded는 []다 → 필터①이 아무것도
//      거르지 않는다. 이게 채워지기 전에는 의원·치과의원·한의원·약국 같은
//      자격/자본 장벽 업종이 최고점이면 그대로 대안으로 뜬다 — 스펙 8.2 위반.
//    - data/domain/floor_coefficients.json의 모든 계수가 1.0이다 → 필터②도
//      사실상 항등 통과다.
//    두 파일 다 신동환이 실값을 채우기 전까지는 공개 배포 게이트다.

import { judge } from "./verdict.js";

// 필터 ① 「열 수 있는 업종」 — 자격증·수억 자본이 필요한 업종을 걸러낸다.
// 이게 없으면 데이터상 최고점인 병원·약국이 상위에 올라온다.
export function filterOpenable(codes, startupFilter) {
  const excluded = new Set(startupFilter?.excluded ?? []);
  return codes.filter((code) => !excluded.has(code));
}

// 필터 ② 「그 층에서 되는 업종」 — 2층 물건에 세탁편의점을 추천하면 헛다리다.
//
// verdict.js가 floorCoefficient에서 고친 것과 같은 결함군: "이 업종군은 그
// 층에서 실제로 계수가 낮다"와 "이 업종군/층수가 floorTable에 아예 없다"는
// 다른 사실이다. 이전 버전은 `coefficient === undefined`를 "통과"로 읽었는데
// (조용한 `?? 허용`), 그러면 업종→그룹 매핑이 빠진 업종이 층수 필터를 그냥
// 뚫고 나가 등급도 못 매긴 채(또는 잘못된 층 감쇠로) 추천될 수 있다.
//
// 여기서는 judge()처럼 던지지 않는다 — 필터가 코드 하나 때문에 던지면 후보
// 전체가 사라진다(recommend()가 그 예외를 못 받으면 페이지가 죽는다). 대신
// fail-closed: 결측 설정은 통과시키지 않고 뺀다. 그리고 "계수가 있는데 기준
// 미달"과 "설정 자체가 없음"을 호출부가 구분할 수 있도록 후자만 excluded에
// 사유와 함께 담아 반환한다 — 전자는 필터가 정상적으로 걸러낸 것이라 신고할
// 게 아니다.
export function filterByFloor(codes, { groups, floor, floorTable, minCoefficient }) {
  const passed = [];
  const excluded = [];
  for (const code of codes) {
    const group = groups?.[code];
    const coefficient = group !== undefined ? floorTable?.[group]?.[floor] : undefined;
    if (coefficient === undefined) {
      excluded.push({
        code,
        reason: "missing_config",
        detail: group === undefined
          ? `업종 코드 "${code}"에 대한 업종→업종군 매핑이 없다`
          : `업종군 "${group}"의 층수 "${floor}" 계수가 floorTable에 없다`,
      });
      continue;
    }
    if (coefficient >= minCoefficient) passed.push(code);
  }
  return { passed, excluded };
}

// 스펙 8.3 — "이 업종이 좋습니다"가 아니라 "물어본 것보다 왜 나은가"를 서술한다.
// 없는 데이터로 비교문을 만들지 않는다: 어느 한쪽이라도 null이면 그 항목은
// 그냥 언급하지 않는다(예: sales_per_store 한쪽이 null이면 매출 배수를 지어내지 않는다).
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
  if (mine.sales_per_store != null && theirs?.sales_per_store != null &&
      mine.sales_per_store > theirs.sales_per_store) {
    const ratio = (mine.sales_per_store / theirs.sales_per_store).toFixed(1);
    parts.push(`점포당 추정매출도 약 ${ratio}배 높습니다.`);
  }
  return parts.join(" ") || `${candidate.name}의 적합도가 더 높게 나왔습니다.`;
}

// recommend()는 배열 하나가 아니라 { recommendations, skipped }를 반환한다.
//
// 브리핑 원안은 recommend()가 배열만 반환했다. 그런데 judge()가 Task 9에서
// 미등록 group/floor에 대해 던지도록 바뀌었고, 상권 안의 업종 하나가 깨진
// group 매핑을 갖고 있어도(배포 설정 오류) 나머지 정상 업종에 대한 추천까지
// 통째로 날아가면 안 된다. 그렇다고 그 업종을 조용히 빼기만 하면 "대안이
// 없다"와 "설정이 깨져서 못 봤다"가 구분이 안 된다 — 이건 이 프로젝트가 계속
// 잡아온 "없는 데이터를 지어내지 않는다/숨기지 않는다" 원칙의 연장선이다.
// 그래서 판정에 실패한 각 후보를 이유와 함께 skipped에 남기고 recommendations
// 옆에 같이 돌려준다. 호출부(Task 11)는 skipped가 비어 있지 않으면 이를
// 노출할지 로그로만 남길지 정할 수 있다 — 적어도 데이터는 여기서 죽지 않는다.
export function recommend({ area, meta, assets, floor, askedCode, limit = 2 }) {
  const names = new Map(meta.industries.map((i) => [i.code, i.name]));
  const asked = askedCode
    ? { code: askedCode, name: names.get(askedCode) ?? askedCode }
    : null;

  const skipped = [];

  let codes = Object.keys(area.industries ?? {}).filter((c) => c !== askedCode);
  codes = filterOpenable(codes, assets.startupFilter);

  const { passed: floorPassed, excluded: floorExcluded } = filterByFloor(codes, {
    groups: assets.groups,
    floor,
    floorTable: assets.floorTable,
    minCoefficient: assets.startupFilter?.min_coefficient ?? 0.6,
  });
  for (const item of floorExcluded) {
    skipped.push({
      code: item.code,
      name: names.get(item.code) ?? item.code,
      reason: `층수 필터 설정 결측: ${item.detail}`,
    });
  }
  codes = floorPassed;

  const scored = [];
  for (const code of codes) {
    const cuts = meta.grade_cuts[code];
    const entry = area.industries[code];
    if (!cuts || entry?.base == null) {
      skipped.push({
        code,
        name: names.get(code) ?? code,
        reason: !cuts ? "grade_cuts 없음" : "entry.base 없음(필수 입력 누락)",
      });
      continue;
    }
    // judge()는 group/floor가 floorTable에 없으면 던진다(verdict.js 참고).
    // filterByFloor를 이미 통과한 코드는 이론상 이 예외를 밟지 않지만, 이
    // 방어는 그 전제에 기대지 않는다 — group/floor 룩업 결함군이 이 프로젝트에서
    // 이미 여러 번 나온 만큼, 후보 하나의 예외로 나머지 추천 전체가 죽는 것을
    // 여기서도 한 번 더 막아둔다.
    try {
      const result = judge({
        entry, cuts, group: assets.groups[code], floor,
        floorTable: assets.floorTable, warnBelow: assets.warnBelow,
      });
      scored.push({ code, name: names.get(code) ?? code, ...result });
    } catch (err) {
      skipped.push({ code, name: names.get(code) ?? code, reason: err.message });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const recommendations = scored.slice(0, limit).map((candidate) => ({
    code: candidate.code,
    name: candidate.name,
    grade: candidate.grade,
    score: candidate.score,
    reason: buildReason({ candidate, asked, area }),
    // patternsUnknown: "경고 없음"과 "확인 못 함"은 다른 진술이라 judge()가
    // 살려서 넘긴다 — 여기서도 떨어뜨리지 않는다.
    patternsUnknown: candidate.patternsUnknown,
    // poolSize: 표본이 얇으면(n<30 등) 상위 2위 안에 든 게 잡음일 수 있다.
    // 숨기지 않고 그대로 실어 보낸다 — 얇은 표본을 어떻게 보여줄지는 Task 11 몫.
    poolSize: candidate.poolSize,
    warning: candidate.warning,
  }));

  return { recommendations, skipped };
}
