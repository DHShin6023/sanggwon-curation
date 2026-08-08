import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { filterOpenable, filterByFloor, recommend } from "../js/alternatives.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJSON = (rel) => JSON.parse(readFileSync(path.join(__dirname, rel), "utf8"));

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

// 필터②는 {passed, excluded} 형태를 반환한다 — 판단 2(브리핑 대비): 결측 설정과
// "계수는 있지만 기준 미달"을 구분해야 하는데, 평평한 string[]로는 그 구분이
// 호출부에 보이지 않는다. excluded에는 오직 "설정 결측"만 담는다 — 계수가 있는데
// minCoefficient 미달로 빠진 코드는 정상적인 필터 동작이라 조용히 passed에서만
// 빠진다(신고 대상 아님).
test("필터②: 2층 물건에 1층 필수급 업종을 남기지 않는다", () => {
  const { passed } = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: GROUPS, floor: "F2", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.ok(!passed.includes("CAFE"), "2층 카페는 계수 0.5로 탈락해야 한다");
  assert.ok(passed.includes("LAUNDRY"));
});

test("필터②: 1층이면 유동의존형도 남는다", () => {
  const { passed } = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: GROUPS, floor: "F1", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.deepEqual(passed.sort(), ["CAFE", "LAUNDRY"]);
});

// --- 판단 2: 결측 설정은 "통과"가 아니다 (Task 9가 verdict.js에서 고친 것과 같은 결함) ---

test("필터②: 그룹 매핑이 없는 업종은 통과시키지 않는다 (fail-closed)", () => {
  const groupsWithGap = { CAFE: "유동의존형" }; // LAUNDRY는 매핑이 아예 없음
  const { passed, excluded } = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: groupsWithGap, floor: "F1", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.ok(!passed.includes("LAUNDRY"), "그룹이 없으면 조용히 통과시키면 안 된다");
  assert.ok(passed.includes("CAFE"));
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].code, "LAUNDRY");
  assert.equal(excluded[0].reason, "missing_config");
});

test("필터②: 그룹은 있지만 floorTable에 그 층수 키가 없는 업종도 통과시키지 않는다", () => {
  const partialTable = { 유동의존형: { F1: 1.0 } }; // F2 등 나머지 층수가 없다
  const { passed, excluded } = filterByFloor(["CAFE"],
    { groups: GROUPS, floor: "F2", floorTable: partialTable, minCoefficient: 0.6 });
  assert.deepEqual(passed, []);
  assert.equal(excluded[0].code, "CAFE");
  assert.equal(excluded[0].reason, "missing_config");
});

test("필터②: 계수가 있는데 기준 미달인 것은 excluded(설정 결측)가 아니라 그냥 미통과다", () => {
  const { passed, excluded } = filterByFloor(["CAFE"],
    { groups: GROUPS, floor: "F2", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.deepEqual(passed, []);
  assert.deepEqual(excluded, [], "실제 계수(0.5)가 있으니 설정 결측으로 신고할 게 아니다");
});

// --- recommend()는 {recommendations, skipped}를 반환한다 — 판단 1(브리핑 대비):
// judge()가 미등록 group/floor에서 던지므로, 후보 하나가 깨졌다고 전체가
// 죽거나 조용히 사라지면 안 된다. skipped에 원인을 남긴다. ---

test("recommend: 최대 2건을 점수순으로 반환", () => {
  const { recommendations: out } = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.equal(out.length, 2);
  assert.ok(out[0].score >= out[1].score);
});

test("recommend: 물어본 업종은 대안에서 제외한다", () => {
  const { recommendations: out } = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.ok(!out.some((r) => r.code === "CAFE"));
});

test("recommend: 자격장벽 업종이 최고점이어도 추천하지 않는다", () => {
  const { recommendations: out } = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.ok(!out.some((r) => r.code === "CLINIC"), "의원은 그림의 떡이다");
});

test("recommend: 2층이면 유동의존형을 추천하지 않는다", () => {
  const { recommendations: out } = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F2", askedCode: "LAUNDRY" });
  assert.ok(!out.some((r) => GROUPS[r.code] === "유동의존형"));
});

test("recommend: 근거는 물어본 업종과의 대비로 서술한다", () => {
  const { recommendations: out } = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  assert.match(out[0].reason, /커피-음료/, "물어본 업종이 근거에 등장해야 한다");
});

test("recommend: 후보가 없으면 빈 배열", () => {
  const { recommendations: out, skipped } = recommend({
    area: { industries: { CAFE: AREA.industries.CAFE } },
    meta: META, assets: ASSETS, floor: "F1", askedCode: "CAFE" });
  assert.deepEqual(out, []);
  assert.deepEqual(skipped, []);
});

// --- 판단 1: group/floor 미등록 업종이 하나 섞여도 recommend()는 죽지 않고,
// 그 사실을 skipped로 드러낸다. ---

test("recommend: assets.groups에 없는 업종 코드가 섞여도 죽지 않고 skipped로 드러난다", () => {
  const groupsWithGap = { CAFE: "유동의존형", LAUNDRY: "배후의존형", BANCHAN: "배후의존형" };
  // CLINIC은 GROUPS에서 빠져 있다 — startupFilter로 걸러지지 않는 상황을 가정해
  // (배포 설정 실수) group 매핑 결손 자체가 별도로 방어되는지 검증한다.
  const assetsWithGap = { groups: groupsWithGap, floorTable: FLOOR_TABLE, warnBelow: 0.75,
                           startupFilter: { excluded: [], min_coefficient: 0.6 } };
  const { recommendations: out, skipped } = recommend({ area: AREA, meta: META,
                          assets: assetsWithGap, floor: "F1", askedCode: "CAFE" });
  assert.ok(out.length > 0, "다른 정상 후보는 그대로 나와야 한다");
  assert.ok(!out.some((r) => r.code === "CLINIC"));
  assert.ok(skipped.some((s) => s.code === "CLINIC"), "빠진 이유가 조용히 사라지면 안 된다");
});

test("recommend: entry.base가 null인 업종은 skipped에 기록되고 계속 진행한다", () => {
  const areaWithNullBase = { industries: {
    ...AREA.industries,
    LAUNDRY: { ...AREA.industries.LAUNDRY, base: null },
  }};
  const { recommendations: out, skipped } = recommend({ area: areaWithNullBase, meta: META,
                          assets: ASSETS, floor: "F1", askedCode: "CAFE" });
  assert.ok(!out.some((r) => r.code === "LAUNDRY"));
  assert.ok(skipped.some((s) => s.code === "LAUNDRY"));
});

// --- Task 11이 그대로 넘겨받아야 하는 필드: patternsUnknown, poolSize, warning ---

test("recommend: patternsUnknown이 추천 결과에서 사라지지 않는다", () => {
  const areaWithUnknown = { industries: {
    ...AREA.industries,
    LAUNDRY: { ...AREA.industries.LAUNDRY, patterns_unknown: ["함정상권"] },
  }};
  const { recommendations: out } = recommend({ area: areaWithUnknown, meta: META,
                          assets: ASSETS, floor: "F1", askedCode: "CAFE" });
  const laundry = out.find((r) => r.code === "LAUNDRY");
  assert.ok(laundry, "세탁편의점이 상위 2건에 들어야 한다");
  assert.deepEqual(laundry.patternsUnknown, ["함정상권"]);
});

test("recommend: poolSize가 추천 결과에 그대로 실려 나온다", () => {
  const areaWithPool = { industries: {
    ...AREA.industries,
    LAUNDRY: { ...AREA.industries.LAUNDRY, pool_size: 4 },
  }};
  const { recommendations: out } = recommend({ area: areaWithPool, meta: META,
                          assets: ASSETS, floor: "F1", askedCode: "CAFE" });
  const laundry = out.find((r) => r.code === "LAUNDRY");
  assert.equal(laundry.poolSize, 4);
});

// --- 정직성: 필터가 실제로 아무것도 걸러내지 않는 출하 설정(provisional)으로
// "동작 확인됨"이라고 결론 내릴 수 없다 — 위 테스트들은 전부 합성 픽스처
// (excluded: ["CLINIC"], 층별로 다른 계수)로 검증했다. 아래는 출하된 실제
// startup_filter.json이 지금은 아무것도 거르지 못한다는 사실 자체를 문서화한다. ---

test("실데이터: 출하된 startup_filter.json은 현재 provisional이라 아무것도 거르지 않는다", () => {
  const shipped = readJSON("../../data/domain/startup_filter.json");
  assert.equal(shipped.provisional, true);
  assert.deepEqual(shipped.excluded, [],
    "이 값이 비어 있는 한 의원·치과의원·한의원·약국이 대안 추천에 나온다 — 배포 게이트");
});

test("실데이터: 11110 상권에서 real assets로 recommend를 돌리면 의원이 걸러지지 않는다 (알려진 게이트)", () => {
  const score = readJSON("../data/score/11110.json");
  const meta = readJSON("../data/meta.json");
  const groupsRaw = readJSON("../../data/domain/industry_groups.json");
  const floorRaw = readJSON("../../data/domain/floor_coefficients.json");
  const startupFilter = readJSON("../../data/domain/startup_filter.json");

  const groups = Object.fromEntries(
    Object.entries(groupsRaw.assignment).map(([code, v]) => [code, v.group])
  );
  const assets = {
    groups, floorTable: floorRaw.coefficients,
    warnBelow: floorRaw.warn_below, startupFilter,
  };

  const areaCode = Object.keys(score.areas)[0];
  const area = score.areas[areaCode];
  const clinicCode = meta.industries.find((i) => i.name === "일반의원")?.code;
  assert.ok(clinicCode, "meta.json에 일반의원 코드가 있어야 이 테스트가 의미 있다");
  if (!area.industries[clinicCode]) return; // 이 상권엔 의원 행 자체가 없을 수 있다

  const { recommendations } = recommend({ area, meta, assets, floor: "F1", askedCode: "CS100001" });
  // provisional 필터 그대로면 의원이 나올 수 있다는 사실 자체가 배포 게이트다.
  // (반드시 나온다고 단정하지 않는다 — 점수 경쟁에서 밀릴 수도 있다. 다만 나오는 걸
  // 막을 장치가 현재 전혀 없다는 것을 알려준다.)
  assert.equal(startupFilter.excluded.includes(clinicCode), false,
    "startup_filter가 살아있다면 의원 코드가 excluded에 있어야 하는데 지금은 없다");
});
