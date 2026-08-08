import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { filterByFloor, recommend } from "../js/alternatives.js";

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
                 minCoefficient: 0.6 };

// 층수 필터는 {passed, excluded} 형태를 반환한다 — 판단 2(브리핑 대비): 결측 설정과
// "계수는 있지만 기준 미달"을 구분해야 하는데, 평평한 string[]로는 그 구분이
// 호출부에 보이지 않는다. excluded에는 오직 "설정 결측"만 담는다 — 계수가 있는데
// minCoefficient 미달로 빠진 코드는 정상적인 필터 동작이라 조용히 passed에서만
// 빠진다(신고 대상 아님).
test("층수 필터: 2층 물건에 1층 필수급 업종을 남기지 않는다", () => {
  const { passed } = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: GROUPS, floor: "F2", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.ok(!passed.includes("CAFE"), "2층 카페는 계수 0.5로 탈락해야 한다");
  assert.ok(passed.includes("LAUNDRY"));
});

test("층수 필터: 1층이면 유동의존형도 남는다", () => {
  const { passed } = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: GROUPS, floor: "F1", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.deepEqual(passed.sort(), ["CAFE", "LAUNDRY"]);
});

// --- 판단 2: 결측 설정은 "통과"가 아니다 (Task 9가 verdict.js에서 고친 것과 같은 결함) ---

test("층수 필터: 그룹 매핑이 없는 업종은 통과시키지 않는다 (fail-closed)", () => {
  const groupsWithGap = { CAFE: "유동의존형" }; // LAUNDRY는 매핑이 아예 없음
  const { passed, excluded } = filterByFloor(["CAFE", "LAUNDRY"],
    { groups: groupsWithGap, floor: "F1", floorTable: FLOOR_TABLE, minCoefficient: 0.6 });
  assert.ok(!passed.includes("LAUNDRY"), "그룹이 없으면 조용히 통과시키면 안 된다");
  assert.ok(passed.includes("CAFE"));
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].code, "LAUNDRY");
  assert.equal(excluded[0].reason, "missing_config");
});

test("층수 필터: 그룹은 있지만 floorTable에 그 층수 키가 없는 업종도 통과시키지 않는다", () => {
  const partialTable = { 유동의존형: { F1: 1.0 } }; // F2 등 나머지 층수가 없다
  const { passed, excluded } = filterByFloor(["CAFE"],
    { groups: GROUPS, floor: "F2", floorTable: partialTable, minCoefficient: 0.6 });
  assert.deepEqual(passed, []);
  assert.equal(excluded[0].code, "CAFE");
  assert.equal(excluded[0].reason, "missing_config");
});

test("층수 필터: 계수가 있는데 기준 미달인 것은 excluded(설정 결측)가 아니라 그냥 미통과다", () => {
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

// 2026-08-08 신동환 결정으로 뒤집힌 계약. 이전에는 "의원은 그림의 떡이라
// 추천하지 않는다"였다. 지금은 출점지 적합도만 보므로 의원이 최고점이면 그대로
// 1순위로 나오는 것이 정상이고, "자격 필요" 같은 표기도 붙이지 않는다.
test("recommend: 자격장벽 업종도 점수가 높으면 그대로 추천한다", () => {
  const { recommendations: out } = recommend({ area: AREA, meta: META, assets: ASSETS,
                          floor: "F1", askedCode: "CAFE" });
  const clinic = out.find((r) => r.code === "CLINIC");
  assert.ok(clinic, "base 95로 최고점인 의원이 추천에서 빠지면 안 된다");
  assert.equal(out[0].code, "CLINIC", "점수순이면 의원이 1순위다");
  assert.equal(clinic.name, "의원");
  // 표기 없이 그냥 추천한다 — 별도 태그/경고 필드를 새로 만들지 않는다.
  assert.deepEqual(Object.keys(clinic).sort(),
    ["code", "grade", "name", "patternsUnknown", "poolSize", "reason", "score", "warning"]);
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
  // CLINIC은 GROUPS에서 빠져 있다 — 배포 설정 실수로 업종→업종군 매핑이 빠졌을 때
  // 그 결손이 조용히 통과되지 않고 skipped로 드러나는지 검증한다.
  const assetsWithGap = { groups: groupsWithGap, floorTable: FLOOR_TABLE, warnBelow: 0.75,
                           minCoefficient: 0.6 };
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

// --- 설정 결측을 조용한 기본값으로 덮지 않는다 ---

test("recommend: minCoefficient가 없으면 조용히 기본값을 쓰지 않고 던진다", () => {
  const { minCoefficient, ...assetsWithoutMin } = ASSETS;
  assert.throws(
    () => recommend({ area: AREA, meta: META, assets: assetsWithoutMin,
                      floor: "F1", askedCode: "CAFE" }),
    /minCoefficient/,
  );
});

// --- 정직성: 위 테스트들은 전부 합성 픽스처(층별로 다른 계수)로 검증했다.
// 출하된 실제 도메인 자산은 아직 잠정값이라 층수 필터가 사실상 동작하지 않는다.
// 그 사실 자체를 테스트로 박아둔다 — 실계수가 들어오면 이 테스트가 깨지면서
// "이제 필터가 산다"는 걸 알려준다. ---

test("실데이터: 출하된 floor_coefficients.json은 잠정값이라 층수 필터가 현재 항등이다", () => {
  const shipped = readJSON("../../data/domain/floor_coefficients.json");
  assert.equal(shipped.provisional, true);
  assert.equal(typeof shipped.min_coefficient, "number",
    "min_coefficient는 startup_filter 폐기 후 이 파일로 옮겨왔다");

  const allCoefficients = Object.values(shipped.coefficients)
    .flatMap((byFloor) => Object.values(byFloor));
  assert.ok(allCoefficients.every((c) => c >= shipped.min_coefficient),
    "모든 계수가 기준 이상이라 어떤 업종도 층수로 탈락하지 않는다 — 배포 게이트");
});

test("실데이터: 11110 상권에서 real assets로 recommend가 돌아간다 (의원 등장은 의도된 출력)", () => {
  const score = readJSON("../data/score/11110.json");
  const meta = readJSON("../data/meta.json");
  // 런타임과 같은 경로로 자산을 만든다: 웹은 data/domain/을 못 읽고
  // meta.json의 floor_config만 본다(build.py가 실어 보낸다).
  const assets = {
    groups: Object.fromEntries(meta.industries.map((i) => [i.code, i.group])),
    floorTable: meta.floor_config.coefficients,
    warnBelow: meta.floor_config.warn_below,
    minCoefficient: meta.floor_config.min_coefficient,
  };

  const areaCode = Object.keys(score.areas)[0];
  const area = score.areas[areaCode];

  const { recommendations, skipped } = recommend({
    area, meta, assets, floor: "F1", askedCode: "CS100001" });

  assert.ok(recommendations.length > 0, "실데이터 상권에서 대안이 하나도 안 나오면 이상하다");
  assert.ok(recommendations.length <= 2);
  assert.deepEqual(skipped.filter((s) => /층수 필터 설정 결측/.test(s.reason)), [],
    "실제 도메인 자산으로는 층수 설정 결측이 나오면 안 된다");
  // 의원·약국이 여기 섞여 나오는 것은 결함이 아니다(2026-08-08 결정). 이 테스트는
  // 그것을 막지 않는다는 사실을 명시적으로 남겨둔다.
});
