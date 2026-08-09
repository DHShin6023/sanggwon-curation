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

test("F3: footfall이 null이면 '상위권/하위권' 사실 주장은 안 붙는다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, footfall: null } });
  assert.ok(!n.factors.some((f) => /유동인구가 (상위|하위)권입니다/.test(f.text)),
    "null 축을 '하위권'/'상위권'으로 단정하면 없는 사실을 지어내는 것이다");
});

test("F3: 6개 축이 전부 null이면 '상위권/하위권'류 factor가 하나도 안 붙는다", () => {
  const n = templateNarration({
    ...BASE,
    axes: { footfall: null, resident: null, worker: null, competition: null, vitality: null, fit: null },
  });
  assert.ok(!n.factors.some((f) => /(상위|하위)권입니다|경쟁이 심합니다|경쟁 대비 점포당|소비 시간대|소비 성격|매출 추세와 영업/.test(f.text)));
});

test("F3: competition이 null이면 '경쟁이 심합니다'류 factor가 안 붙는다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, competition: null } });
  assert.ok(!n.factors.some((f) => /경쟁이 심합니다|경쟁 대비 점포당 매출이 양호합니다/.test(f.text)));
});

// ---------------------------------------------------------------------
// 리뷰 라운드 2(2026-08-09) I3: null 축을 "하위권"으로 지어내지 않게 된
// 것(F3)과, 그 축이 등급 계산에서 아예 빠졌다는 사실 자체를 조용히 삼키는
// 것은 다른 문제다. 실측 사례: 청계산원터골(gu 11650)/한식음식점은
// footfall이 null이고, base_score()는 결측 축을 빼고 나머지로 재정규화해
// 등급을 낸다 — 화면이 이 사실을 알려야 한다.
// ---------------------------------------------------------------------

test("I3: footfall만 null이면 '유동인구 데이터가 없어...' caution이 붙는다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, footfall: null } });
  const caution = n.factors.find((f) => f.kind === "caution" && /데이터가 없어/.test(f.text));
  assert.ok(caution, "결측 축을 알리는 caution factor가 있어야 한다");
  assert.match(caution.text, /유동인구/);
  assert.match(caution.text, /재배분|다시 배분/);
  // 다른 축(경쟁·활력·궁합 등) 이름까지 끌려들어오면 안 된다 — footfall
  // 하나만 없앤 케이스니까.
  assert.doesNotMatch(caution.text, /경쟁·|배후 거주인구·/);
});

test("I3: 축 여러 개가 null이면 그 이름들이 · 로 이어져 한 caution에 담긴다", () => {
  const n = templateNarration({ ...BASE, axes: { ...BASE.axes, footfall: null, worker: null } });
  const caution = n.factors.find((f) => f.kind === "caution" && /데이터가 없어/.test(f.text));
  assert.ok(caution);
  assert.match(caution.text, /유동인구·직장인구|직장인구·유동인구/);
});

test("I3: 축이 전부 있으면 결측 축 caution이 안 붙는다", () => {
  const n = templateNarration(BASE); // BASE의 6개 축 전부 숫자
  assert.ok(!n.factors.some((f) => /데이터가 없어.*재배분|다시 배분/.test(f.text)));
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

// ---------------------------------------------------------------------
// 리뷰 라운드 2 C1: floorBasis가 "층수는 등급에 반영됩니다"를 무조건 참으로
// 하드코딩했었다. 배포된 floor_config 계수가 전부 1.0이라 성공한 모든
// 판정에서 실제로는 거짓이었다 — 이제 baseScore(층수 적용 전)와
// score(적용 후)를 비교해서 판단한다. 세 가지 상태를 각각 고정한다.
// ---------------------------------------------------------------------

test("C1: baseScore를 안 주면(구버전 호출부 등) 영향 유무를 단정하지 않는다", () => {
  const n = templateNarration(BASE); // BASE에 baseScore 없음
  assert.doesNotMatch(n.floorBasis.text, /영향을 주지 않았습니다|아무 영향도/);
  assert.doesNotMatch(n.floorBasis.text, /실제로 반영됐습니다/);
  assert.match(n.floorBasis.text, /휴리스틱/);
});

test("C1/SB3: 1층에서 계수가 1.0인 건 '영향 없음'이 아니라 '기준점'이라고 말한다", () => {
  // SB3(최종 리뷰): 예전엔 층에 상관없이 "층수가 등급에 아무 영향도 주지
  // 않았습니다 … 잠정값 상태라 대부분의 판정에서 이렇게 나옵니다"였다.
  // 1층은 기본 선택지라 이 문장이 제일 많이 읽히는데, 원인(기준점이라 1.0이지
  // 잠정값이라서가 아니다)도 빈도(35개 중 8개)도 둘 다 거짓이었다.
  const n = templateNarration({ ...BASE, floor: "F1", score: 59.4786, baseScore: 59.4786 });
  assert.match(n.floorBasis.text, /기준점/);
  assert.doesNotMatch(n.floorBasis.text, /대부분의 판정/,
    "실계수가 들어온 지금 1.0은 35개 중 8개다 — '대부분'이 아니다");
  assert.doesNotMatch(n.floorBasis.text, /잠정값 상태라/,
    "1층이 1.0인 원인은 잠정값이 아니라 설계다");
});

test("C1: 1층이 아닌데 score === baseScore면 그 층 계수가 1.0이라고 말한다", () => {
  // BASE.floor === "F2". 실계수에서는 목적방문형/단독건물이 이 경우다.
  const n = templateNarration({ ...BASE, score: 59.4786, baseScore: 59.4786 });
  assert.match(n.floorBasis.text, /계수가 1\.0/);
  assert.match(n.floorBasis.text, /1층과 같게/);
  assert.doesNotMatch(n.floorBasis.text, /기준점/, "기준점은 1층에만 쓰는 말이다");
});

test("C1: score !== baseScore면 '실제로 반영됐다'고 말하고 보정 배수를 보여준다", () => {
  const n = templateNarration({ ...BASE, score: 40, baseScore: 50 });
  assert.match(n.floorBasis.text, /실제로 반영됐습니다/);
  assert.match(n.floorBasis.text, /0\.80배/); // 40/50 = 0.80
});

test("C1: 두 상태 모두 헤딩이 '반영/영향 없음' 둘 중 하나로만 갈리고, 서로 섞이지 않는다", () => {
  const noEffect = templateNarration({ ...BASE, score: 30, baseScore: 30 });
  const effect = templateNarration({ ...BASE, score: 25, baseScore: 30 });
  assert.doesNotMatch(noEffect.floorBasis.text, /실제로 반영됐습니다/);
  assert.doesNotMatch(effect.floorBasis.text, /영향도 주지 않았습니다/);
});
