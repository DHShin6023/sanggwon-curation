import test from "node:test";
import assert from "node:assert/strict";
import { templateNarration, money, THIN_POOL } from "../js/narrate.js";

const BASE = {
  industryName: "커피-음료", areaName: "서교동", floor: "F2",
  grade: "중하", rank: "하위 50%", score: 30,
  storeCount: 47, salesPerStore: 12000000,
  axes: { footfall: 92, competition: 18, vitality: 40, fit: 55, resident: 60, worker: 30 },
  patterns: ["함정상권"],
  warning: { severity: "critical", message: "2층 위치는 궁합이 좋지 않습니다.", basis: "heuristic" },
};

test("등급과 의미가 헤드라인에 들어간다", () => {
  const n = templateNarration(BASE);
  assert.match(n.headline, /중하/);
});

test("긍정·부정 요인이 구분되어 나온다", () => {
  const n = templateNarration(BASE);
  const kinds = new Set(n.factors.map((f) => f.kind));
  assert.ok(kinds.has("positive"));
  assert.ok(kinds.has("negative"));
});

test("높은 유동인구는 긍정 요인으로 잡힌다", () => {
  const n = templateNarration(BASE);
  assert.ok(n.factors.some((f) => f.kind === "positive" && /유동/.test(f.text)));
});

test("층수 경고는 요인과 분리된 별도 항목이다", () => {
  const n = templateNarration(BASE);
  assert.ok(n.floorNote);
  assert.ok(!n.factors.some((f) => /2층/.test(f.text)));
});

test("층수 경고에 휴리스틱 근거임이 표기된다", () => {
  assert.match(templateNarration(BASE).floorNote.basisNote, /데이터|현장|경험|추정/);
});

test("패턴 설명이 따로 붙는다", () => {
  const n = templateNarration(BASE);
  assert.equal(n.patternNotes.length, 1);
  assert.match(n.patternNotes[0].text, /통행량|소비/);
});

test("어떤 출력에도 % 성공확률이 없다", () => {
  const text = JSON.stringify(templateNarration(BASE));
  assert.doesNotMatch(text, /성공\s*확률|성공률/);
});

test("경고가 없으면 floorNote도 없다", () => {
  const n = templateNarration({ ...BASE, warning: null });
  assert.equal(n.floorNote, null);
});

test("패턴이 없으면 patternNotes는 빈 배열", () => {
  assert.deepEqual(templateNarration({ ...BASE, patterns: [] }).patternNotes, []);
});

// ---------------------------------------------------------------------
// 리뷰 라운드 1(2026-08-08) 회귀 방지 테스트. 상세는 task-11-report.md의
// "Fix round 1" 절 참고. F3: null <= 30이 true라서 결측 축이 "하위권"이라는
// 사실 주장으로 렌더되던 결함(실데이터 예: 청계산원터골/한식음식점/2층).
// ---------------------------------------------------------------------

test("F3: footfall이 null이면 유동인구 관련 factor가 전혀 안 붙는다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, footfall: null } });
  assert.ok(!n.factors.some((f) => /유동/.test(f.text)),
    "null 축을 '하위권'/'상위권'으로 단정하면 없는 사실을 지어내는 것이다");
});

test("F3: 6개 축이 전부 null이면 factors에 축 기반 항목이 하나도 안 붙는다", () => {
  const n = templateNarration({
    ...BASE,
    axes: { footfall: null, resident: null, worker: null, competition: null, vitality: null, fit: null },
  });
  // poolSize 기반 caution(표본 얇음)은 axes와 무관하니 남을 수 있다 — 그것만
  // 빼고 축 관련 문구가 하나도 없어야 한다.
  const axisRelated = n.factors.filter((f) => !/표본/.test(f.text));
  assert.deepEqual(axisRelated, []);
});

test("F3: competition이 null이면 '경쟁이 심합니다'류 factor가 안 붙는다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, competition: null } });
  assert.ok(!n.factors.some((f) => /경쟁/.test(f.text)));
});

test("F3(파생): salesPerStore가 null이면 경쟁 factor에서 매출을 '하위권'으로 지어내지 않는다", () => {
  const n = templateNarration({ ...BASE, salesPerStore: null }); // competition:18 <= LOW 유지
  const negFactor = n.factors.find((f) => /경쟁이 심합니다/.test(f.text));
  assert.ok(negFactor, "경쟁 factor 자체는 여전히 있어야 한다(competition 축은 살아있으니까)");
  assert.ok(!/하위권|상위권/.test(negFactor.text),
    "매출 결측을 '하위권'이라는 순위 주장으로 바꾸면 없는 데이터를 지어내는 것이다");
});

test("money(): 결측(null/undefined)과 실제 0원은 다르게 처리된다", () => {
  assert.equal(money(null), null);
  assert.equal(money(undefined), null);
  assert.notEqual(money(0), null, "0원은 '값 없음'이 아니라 실제 0이어야 한다");
});

test("footfall이 100이면 '상위 0%'가 아니라 최소 1%로 표시된다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, footfall: 100 } });
  const f = n.factors.find((x) => /유동인구가 상위권/.test(x.text));
  assert.ok(f);
  assert.doesNotMatch(f.text, /상위 0%/);
});

test("커피-음료처럼 받침 없는 업종명에는 조사 '가'가 붙는다(이전엔 하드코딩된 '이')", () => {
  const n = templateNarration(BASE); // industryName: "커피-음료", competition:18<=LOW
  const negFactor = n.factors.find((f) => /경쟁이 심합니다/.test(f.text));
  assert.match(negFactor.text, /커피-음료가 이미/);
  assert.doesNotMatch(negFactor.text, /커피-음료이/);
});

test("F2: floorBasis는 경고 유무와 무관하게 항상 존재하고 휴리스틱임을 밝힌다", () => {
  const withWarning = templateNarration(BASE);
  const withoutWarning = templateNarration({ ...BASE, warning: null });
  assert.ok(withWarning.floorBasis);
  assert.ok(withoutWarning.floorBasis);
  assert.match(withWarning.floorBasis.text, /휴리스틱|현장 경험/);
  assert.match(withoutWarning.floorBasis.text, /휴리스틱|현장 경험/);
});

test("THIN_POOL은 render.js와 공유되는 export다(현재 30)", () => {
  assert.equal(THIN_POOL, 30);
});
