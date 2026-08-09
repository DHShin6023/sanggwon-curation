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
// 예전엔 출하 자산이 전부 1.0이라 층수 필터가 사실상 항등이었고, 그 사실을
// 테스트로 박아 "실계수가 들어오면 깨지면서 알려주게" 해뒀다.
//
// **2026-08-09에 실제로 깨졌다** — 신동환 승인 계수가 들어오면서. 게이트가
// 설계대로 울린 것이고, 이제 반대 방향을 고정한다: 필터가 정말 살아 있는가. ---

test("실데이터: 신동환 확정 계수가 들어와 층수 필터가 실제로 동작한다", () => {
  const shipped = readJSON("../../data/domain/floor_coefficients.json");
  assert.equal(typeof shipped.min_coefficient, "number",
    "min_coefficient는 startup_filter 폐기 후 이 파일로 옮겨왔다");

  const all = Object.entries(shipped.coefficients)
    .flatMap(([g, byFloor]) => Object.entries(byFloor).map(([f, c]) => ({ g, f, c })));

  // 전부 1.0이던 시절로 되돌아가면(빌드 사고·자산 덮어쓰기) 층수 입력이 다시
  // 장식이 된다. 조용히 그렇게 되는 걸 막는 게 이 테스트의 목적이다.
  assert.ok(all.some((x) => x.c !== 1.0),
    "모든 계수가 1.0이면 층수를 뭘 고르든 등급이 같다 — 자산이 되돌아갔는지 확인할 것");

  const excluded = all.filter((x) => x.c < shipped.min_coefficient);
  assert.deepEqual(
    excluded.map((x) => `${x.g}/${x.f}`).sort(),
    ["복합의존형/F3P", "유동의존형/F3P"],
    "대안 추천에서 탈락하는 조합 — 바뀌면 의도한 변경인지 확인할 것");

  const warned = all.filter((x) => x.c < shipped.warn_below);
  assert.equal(warned.length, 8, "층수 경고가 붙는 조합 수");

  // 1층은 기준점이므로 어느 그룹에서도 1.00이어야 한다. 다른 값이 들어오면
  // 계수의 의미(1층 대비 상대값)가 무너진다.
  const f1 = all.filter((x) => x.f === "F1");
  assert.ok(f1.length > 0 && f1.every((x) => x.c === 1.0),
    "1층은 상대값의 기준점이라 반드시 1.00이다");
});

// 실데이터 픽스처. 런타임과 같은 경로로 자산을 만든다 — 웹은 data/domain/을
// 못 읽고 meta.json의 floor_config만 본다(build.py가 실어 보낸다).
function realFixture(gu = "11440", areaName = "합정역") {
  const score = readJSON(`../data/score/${gu}.json`);
  const meta = readJSON("../data/meta.json");
  const assets = {
    groups: Object.fromEntries(meta.industries.map((i) => [i.code, i.group])),
    floorTable: meta.floor_config.coefficients,
    warnBelow: meta.floor_config.warn_below,
    minCoefficient: meta.floor_config.min_coefficient,
  };
  const entry = Object.entries(score.areas).find(([, a]) => a.name === areaName)
    ?? Object.entries(score.areas)[0];
  return { area: entry[1], meta, assets };
}

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

// ---------------------------------------------------------------------
// 2026-08-09 실배포 관통 검증에서 발견. 실제 출력이 이랬다:
//
//   "물으신 커피-음료은 경쟁점 62곳인데 안경은 5곳입니다."
//
// "커피-음료"는 받침이 없으니 "커피-음료는"이 맞다. narrate.js는 같은 이유로
// 이미 josaGa()를 두고 있었는데(커피-음료이 → 커피-음료가), alternatives.js는
// "은"을 하드코딩하고 있었다. 업종명 62개 중 받침 없이 끝나는 것이 여럿이라
// (커피-음료, 문구, 신발, 가구, 완구, 안경 …) 드물게 나는 오타가 아니다.
// ---------------------------------------------------------------------

test("받침 없는 업종명에는 조사 '는'이 붙는다 (커피-음료은 ✗ / 커피-음료는 ✓)", () => {
  const { area, meta, assets } = realFixture();
  const { recommendations } = recommend({
    area, meta, assets, floor: "F1", askedCode: "CS100010" });   // 커피-음료
  const withReason = recommendations.filter((r) => /커피-음료/.test(r.reason));
  assert.ok(withReason.length > 0, "커피-음료를 물었으니 이유 문장에 그 이름이 나와야 한다");
  for (const r of withReason) {
    assert.doesNotMatch(r.reason, /커피-음료은/, "받침 없는 이름에 '은'을 붙이면 안 된다");
    assert.match(r.reason, /커피-음료는/);
  }
});

test("받침 있는 업종명에는 조사 '은'이 그대로 붙는다", () => {
  const { area, meta, assets } = realFixture();
  const { recommendations } = recommend({
    area, meta, assets, floor: "F1", askedCode: "CS100001" });   // 한식음식점
  const withReason = recommendations.filter((r) => /한식음식점/.test(r.reason));
  for (const r of withReason) {
    assert.match(r.reason, /한식음식점은/);
  }
});
