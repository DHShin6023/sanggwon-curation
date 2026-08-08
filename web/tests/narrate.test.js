import test from "node:test";
import assert from "node:assert/strict";
import { templateNarration } from "../js/narrate.js";

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
