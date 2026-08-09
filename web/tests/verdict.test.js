import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FLOORS, GRADES, applyFloor, gradeOf, rankLabel, floorWarning, judge }
  from "../js/verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJSON = (rel) => JSON.parse(readFileSync(path.join(__dirname, rel), "utf8"));

const CUTS = [75, 50, 25];
const FLOOR_TABLE = { 유동의존형: { B1: 0.4, F1: 1.0, F2: 0.5, F3P: 0.35, DETACHED: 0.95 },
                      배후의존형: { B1: 0.8, F1: 1.0, F2: 0.95, F3P: 0.85, DETACHED: 1.0 } };

test("층수 구간은 5개로 고정", () => {
  assert.deepEqual(FLOORS, ["B1", "F1", "F2", "F3P", "DETACHED"]);
});

test("등급은 4단계로 고정", () => {
  assert.deepEqual(GRADES, ["상", "중상", "중하", "하"]);
});

test("gradeOf: 경계값이 상위 등급에 속한다", () => {
  assert.equal(gradeOf(75, CUTS), "상");
  assert.equal(gradeOf(74.99, CUTS), "중상");
  assert.equal(gradeOf(50, CUTS), "중상");
  assert.equal(gradeOf(25, CUTS), "중하");
  assert.equal(gradeOf(24.99, CUTS), "하");
});

test("applyFloor: 계수를 곱하고 0~100으로 자른다", () => {
  assert.equal(applyFloor(80, 0.5), 40);
  assert.equal(applyFloor(80, 2.0), 100);
});

test("2층 카페는 같은 자리 1층 카페보다 등급이 낮거나 같다", () => {
  const entry = { base: 80, store_count: 10, patterns: [], axes: {} };
  const args = { entry, cuts: CUTS, group: "유동의존형", floorTable: FLOOR_TABLE, warnBelow: 0.75 };
  const f1 = judge({ ...args, floor: "F1" });
  const f2 = judge({ ...args, floor: "F2" });
  assert.ok(f2.score < f1.score);
  assert.ok(GRADES.indexOf(f2.grade) >= GRADES.indexOf(f1.grade));
});

test("5개 층수 전체에서 판정이 나온다", () => {
  const entry = { base: 60, store_count: 5, patterns: [], axes: {} };
  for (const floor of FLOORS) {
    const r = judge({ entry, cuts: CUTS, group: "유동의존형", floor,
                      floorTable: FLOOR_TABLE, warnBelow: 0.75 });
    assert.ok(GRADES.includes(r.grade), `${floor} 등급 없음`);
  }
});

test("floorWarning: 계수가 임계 미만이면 경고", () => {
  const w = floorWarning({ group: "유동의존형", floor: "F2",
                           floorTable: FLOOR_TABLE, warnBelow: 0.75 });
  assert.ok(w && w.message.length > 0);
});

test("floorWarning: 궁합이 나쁘지 않으면 경고 없음", () => {
  assert.equal(floorWarning({ group: "배후의존형", floor: "F2",
                              floorTable: FLOOR_TABLE, warnBelow: 0.75 }), null);
});

test("등급 하락과 별도로 경고가 따로 나온다 (스펙 7.5 이중 처리)", () => {
  const r = judge({ entry: { base: 90, store_count: 10, patterns: [], axes: {} },
                    cuts: CUTS, group: "유동의존형", floor: "F3P",
                    floorTable: FLOOR_TABLE, warnBelow: 0.75 });
  assert.ok(r.warning, "경고가 있어야 한다");
  assert.ok(r.score < 90, "등급에도 반영되어야 한다");
});

test("rankLabel: %는 순위 표기일 뿐 성공확률이 아니다", () => {
  const label = rankLabel(90, CUTS);
  assert.match(label, /상위|하위/);
  assert.doesNotMatch(label, /성공|확률/);
});

test("base가 없으면 판정하지 않는다", () => {
  assert.throws(() => judge({ entry: { base: null }, cuts: CUTS, group: "유동의존형",
                              floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75 }));
});

// --- 이하 브리핑에 없는 추가 테스트: 4가지 판단(ruling) 검증 ---

test("judge: patternsUnknown이 patterns와 별도로 그대로 전달된다 (판단 1)", () => {
  const r = judge({
    entry: { base: 60, store_count: 5, patterns: [], patterns_unknown: ["함정상권", "블루오션"], axes: {} },
    cuts: CUTS, group: "유동의존형", floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75,
  });
  assert.deepEqual(r.patternsUnknown, ["함정상권", "블루오션"]);
  assert.deepEqual(r.patterns, []);
});

test("judge: patternsUnknown이 없는 entry는 빈 배열로 채워진다", () => {
  const r = judge({
    entry: { base: 60, store_count: 5, patterns: [], axes: {} },
    cuts: CUTS, group: "유동의존형", floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75,
  });
  assert.deepEqual(r.patternsUnknown, []);
});

test("rankLabel: 4단계 굵은 버킷만 반환한다 (판단 2 — 정밀 백분위 아님)", () => {
  assert.equal(rankLabel(80, CUTS), "상위 25% 이내");
  assert.equal(rankLabel(60, CUTS), "상위 50% 이내");
  assert.equal(rankLabel(30, CUTS), "하위 50%");
  assert.equal(rankLabel(10, CUTS), "하위 25%");
});

test("judge: base가 null이면 던지는 에러 메시지가 base 부재를 언급한다 (판단 3)", () => {
  assert.throws(
    () => judge({ entry: { base: null }, cuts: CUTS, group: "유동의존형",
                 floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75 }),
    /base/
  );
});

test("judge: store_count와 sales_per_store는 없으면 0이 아니라 null로 남는다", () => {
  const r = judge({
    entry: { base: 60, store_count: null, sales_per_store: null, patterns: [], axes: {} },
    cuts: CUTS, group: "유동의존형", floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75,
  });
  assert.equal(r.storeCount, null);
  assert.equal(r.salesPerStore, null);
});

// --- 리뷰 반영: 미등록 group/floor는 "계수 1.0"이 아니라 던진다 + poolSize ---

test("judge: floorTable에 없는 업종군은 조용히 1.0으로 넘어가지 않고 던진다", () => {
  const entry = { base: 60, store_count: 5, patterns: [], axes: {} };
  assert.throws(
    () => judge({ entry, cuts: CUTS, group: "존재하지않는그룹", floor: "F1",
                 floorTable: FLOOR_TABLE, warnBelow: 0.75 }),
    /존재하지않는그룹/
  );
});

test("judge: 알려진 업종군이라도 등록되지 않은 층수는 던진다", () => {
  const entry = { base: 60, store_count: 5, patterns: [], axes: {} };
  const partialTable = { 유동의존형: { F1: 1.0 } }; // F2 등 나머지 층수 키가 없다
  assert.throws(
    () => judge({ entry, cuts: CUTS, group: "유동의존형", floor: "F2",
                 floorTable: partialTable, warnBelow: 0.75 }),
    /F2/
  );
});

test("floorWarning: 미등록 업종군/층수도 null이 아니라 던진다 (judge와 동일한 결함군)", () => {
  assert.throws(
    () => floorWarning({ group: "존재하지않는그룹", floor: "F1",
                         floorTable: FLOOR_TABLE, warnBelow: 0.75 }),
    /존재하지않는그룹/
  );
  assert.throws(
    () => floorWarning({ group: "유동의존형", floor: "F1",
                         floorTable: { 유동의존형: { F2: 0.5 } }, warnBelow: 0.75 }),
    /F1/
  );
});

test("judge: poolSize가 entry.pool_size 그대로 전달된다", () => {
  const r = judge({
    entry: { base: 60, store_count: 5, patterns: [], axes: {}, pool_size: 7 },
    cuts: CUTS, group: "유동의존형", floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75,
  });
  assert.equal(r.poolSize, 7);
});

test("judge: pool_size가 없는 entry는 poolSize가 null로 남는다", () => {
  const r = judge({
    entry: { base: 60, store_count: 5, patterns: [], axes: {} },
    cuts: CUTS, group: "유동의존형", floor: "F1", floorTable: FLOOR_TABLE, warnBelow: 0.75,
  });
  assert.equal(r.poolSize, null);
});

// --- 실데이터 검증 ---

test("실데이터: 11110.json의 정상 industry가 그럴듯한 등급을 낸다", () => {
  const score = readJSON("../data/score/11110.json");
  const meta = readJSON("../data/meta.json");
  const area = score.areas["3110001"];
  const entry = area.industries["CS100001"];
  assert.ok(entry.base !== null, "이 entry는 base가 있어야 한다");
  const cuts = meta.grade_cuts["CS100001"];
  const r = judge({ entry, cuts, group: "유동의존형", floor: "F1",
                    floorTable: FLOOR_TABLE, warnBelow: 0.75 });
  assert.ok(GRADES.includes(r.grade));
  assert.equal(r.score, entry.base); // 1층은 이 합성 FLOOR_TABLE에서 계수 1.0
  assert.equal(r.poolSize, entry.pool_size); // 914 — 얇은 표본 판단은 Task 11 몫
});

test("실데이터: base가 null인 industry는 judge가 던진다", () => {
  const score = readJSON("../data/score/11110.json");
  const meta = readJSON("../data/meta.json");
  const area = score.areas["3110021"];
  const entry = area.industries["CS100006"];
  assert.equal(entry.base, null);
  const cuts = meta.grade_cuts["CS100006"];
  assert.throws(() => judge({ entry, cuts, group: "유동의존형", floor: "F1",
                              floorTable: FLOOR_TABLE, warnBelow: 0.75 }));
});

// ── SB2(최종 리뷰): 순위는 층수를 빼고 자리만 본 값이어야 한다 ──────────
//
// cuts는 base_score 분포의 분위수다(scoring.py grade_cuts). 층수로 깎인 score를
// 안 깎인 cuts에 대면 "서울 전역 순위"가 아니라 아무것도 아닌 값이 나온다.
// 실측으로 잡힌 사례: 화곡역 4번/화장품은 base 88.9032로 서울 화장품 중 1등인데
// (상위 컷 60.6034) 3층을 고르면 「하위 50%」로 표시됐다. 화면 문장이
// 「서울 전역, 같은 업종」이라고 못박고 있으니 명백한 거짓이었다.

test("SB2: rank는 층수 보정 전 base로 계산된다 — 층수가 순위를 바꾸면 안 된다", () => {
  const entry = { base: 88.9032, patterns: [], patternsUnknown: [], poolSize: 200 };
  const cuts = [60.6034, 45.0, 30.0];
  const floorTable = { G: { B1: 0.6, F1: 1.0, F2: 0.7, F3P: 0.5, DETACHED: 0.85 } };

  const ranks = FLOORS.map((floor) =>
    judge({ entry, cuts, group: "G", floor, floorTable, warnBelow: 0.75 }).rank);

  assert.deepEqual([...new Set(ranks)], ["상위 25% 이내"],
    `층수가 순위를 바꿨다: ${JSON.stringify(ranks)} — 순위는 자리의 속성이지 층수의 속성이 아니다`);
});

test("SB2: 등급은 여전히 층수를 반영한다 — 순위와 등급이 갈릴 수 있고 그게 정상이다", () => {
  const entry = { base: 88.9032, patterns: [], patternsUnknown: [], poolSize: 200 };
  const cuts = [60.6034, 45.0, 30.0];
  const floorTable = { G: { B1: 0.6, F1: 1.0, F2: 0.7, F3P: 0.5, DETACHED: 0.85 } };

  const f1 = judge({ entry, cuts, group: "G", floor: "F1", floorTable, warnBelow: 0.75 });
  const f3 = judge({ entry, cuts, group: "G", floor: "F3P", floorTable, warnBelow: 0.75 });

  assert.equal(f1.grade, "상");
  assert.equal(f3.grade, "중하", "3층은 계수 0.5라 등급이 내려가야 한다");
  assert.equal(f3.rank, "상위 25% 이내",
    "자리 자체는 서울 상위권이다 — 「자리는 좋은데 3층이라 중하」가 이 서비스가 해줘야 할 말이다");
});
