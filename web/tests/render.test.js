// render.js 단위 테스트. 리뷰 라운드 1(2026-08-08)에서 지적된 F1/F2/F5/F6/
// F7/F8/F9를 이 파일에서 고정한다. 실제 브라우저가 아니라 tests/helpers/
// dom-stub.js의 최소 스텁 위에서 돈다 — CSS 렌더링이나 실제 스크린리더
// 동작은 이 테스트로 검증되지 않는다(report에 명시).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { installDom, FakeNode } from "./helpers/dom-stub.js";

installDom();
const { renderResult } = await import("../js/render.js");
const { THIN_POOL } = await import("../js/narrate.js");

function flattenHeadings(node, out = []) {
  if (["h1", "h2", "h3"].includes(node.tagName)) out.push({ tag: node.tagName, text: node.textContent });
  for (const c of node.children) flattenHeadings(c, out);
  return out;
}

const VERDICT = {
  score: 60, grade: "중상", meaning: "해볼 만함, 단 조건부", rank: "상위 50% 이내",
  warning: null, patterns: [], patternsUnknown: [], poolSize: 200,
  axes: {}, storeCount: 10, salesPerStore: 1000000,
};
const NARRATION = { headline: "h", factors: [], floorNote: null, floorBasis: { text: "층수는 휴리스틱 추정입니다." }, patternNotes: [] };

function areaPayload(overrides = {}) {
  return {
    precision: { level: "area", badge: "🟢", label: "상권 단위 분석" },
    areaName: "서교동", floorLabel: "1층", industryName: "한식음식점",
    verdict: VERDICT, narration: NARRATION, alternatives: [],
    ...overrides,
  };
}

test("F1: area_type가 있으면 채점 풀(한글 라벨)과 비교 범위 안내가 뜬다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ areaType: "alley" }));
  const p = root.query("area-type");
  assert.ok(p, "area-type 노드가 있어야 한다");
  assert.match(p.textContent, /골목상권/);
  assert.match(p.textContent, /상권 종류가 다르면/);
});

test("F1: area_type가 metro/market이면 각각 다른 한글 라벨이 뜬다", () => {
  const rootMetro = new FakeNode("section");
  renderResult(rootMetro, areaPayload({ areaType: "metro" }));
  assert.match(rootMetro.query("area-type").textContent, /광역상권/);

  const rootMarket = new FakeNode("section");
  renderResult(rootMarket, areaPayload({ areaType: "market" }));
  assert.match(rootMarket.query("area-type").textContent, /전통시장/);
});

test("F2: 층수 경고가 없어도(warning:null) 휴리스틱 고지는 항상 뜬다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload()); // NARRATION.floorNote === null
  const basis = root.query("basis");
  assert.ok(basis, "basis 노드가 있어야 한다(경고 여부와 무관)");
  assert.match(basis.textContent, /휴리스틱/);
  // 경고가 없을 때 "층수 경고" 제목을 달면 없는 경고를 지어내는 것이다.
  const floorNoteBox = root.query("floor-note");
  assert.match(floorNoteBox.textContent, /층수 보정 안내/);
  assert.ok(!/층수 경고/.test(floorNoteBox.textContent));
});

test("F2: 층수 경고가 있으면 basisNote와 경고 문구가 함께 뜬다", () => {
  const root = new FakeNode("section");
  const narrationWithWarning = {
    ...NARRATION,
    floorNote: { severity: "critical", text: "2층은 궁합이 안 좋습니다.", basisNote: "휴리스틱" },
  };
  renderResult(root, areaPayload({ narration: narrationWithWarning }));
  const box = root.query("critical");
  assert.ok(box, "critical 클래스의 floor-note가 있어야 한다");
  assert.match(box.textContent, /2층은 궁합이 안 좋습니다/);
  assert.match(box.textContent, /휴리스틱 추정입니다/); // floorBasis.text
});

test("F5: precision.level이 dong이면 verdict 없이도 던지지 않고, 분석 불가라고 하지 않는다", () => {
  const root = new FakeNode("section");
  assert.doesNotThrow(() => renderResult(root, {
    precision: { level: "dong", badge: "🟡", label: "행정동 단위 분석", note: "해상도가 낮습니다" },
    areaName: "종로구 일대", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
    dongInfo: { guName: "종로구", dongCode: "11110515", salesTotal: 3865728183 },
  }));
  assert.ok(!/분석 불가/.test(root.textContent), "🟡인데 분석 불가라고 하면 안 된다(F5)");
  assert.match(root.textContent, /종로구/);
  assert.match(root.textContent, /억원|만원/); // dongInfo.salesTotal이 money()로 렌더됨
});

test("F5: dong인데 salesTotal이 없으면 '데이터가 없다'고 정직하게 말한다(지어내지 않는다)", () => {
  const root = new FakeNode("section");
  renderResult(root, {
    precision: { level: "dong", badge: "🟡", label: "행정동 단위 분석" },
    areaName: "종로구 일대", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
    dongInfo: { guName: "종로구", dongCode: "11110515", salesTotal: null },
  });
  assert.ok(!/분석 불가/.test(root.textContent));
  assert.match(root.textContent, /데이터가 없습니다/);
});

test("F6: 🔴 none의 세 가지 reason이 서로 다른 문장을 낸다", () => {
  const reasons = ["out_of_bounds", "no_data", "config_error"];
  const texts = reasons.map((reason) => {
    const root = new FakeNode("section");
    renderResult(root, {
      precision: { level: "none", badge: "🔴", label: "분석 불가", reason },
      areaName: "배화여자대학교(박노수미술관)", floorLabel: "1층", industryName: "한식음식점",
      verdict: null, narration: null, alternatives: [],
    });
    return root.query("note").textContent;
  });
  const unique = new Set(texts);
  assert.equal(unique.size, 3, `세 reason의 문장이 모두 달라야 하는데: ${JSON.stringify(texts)}`);
  assert.match(texts[1], /배화여자대학교/); // no_data는 matched 상권 이름을 언급해야 한다
});

test("M2: reason이 없으면 out_of_bounds로 조용히 떨어지지 않고 '모른다'고 말한다", () => {
  const root = new FakeNode("section");
  renderResult(root, {
    precision: { level: "none", badge: "🔴", label: "분석 불가" },
    areaName: "해당 지역", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
  });
  const text = root.query("note").textContent;
  assert.match(text, /확인할 수 없습니다/);
  // out_of_bounds 텍스트("양쪽 다 범위 밖")를 기본값으로 깔면 안 된다 —
  // reason이 실제로 out_of_bounds일 때만 그 문장이 나와야 한다.
  assert.doesNotMatch(text, /양쪽 다 범위 밖/);
});

test("M2: reason이 알 수 없는 값(오타 등)이어도 out_of_bounds로 안 새고 '모른다'고 말한다", () => {
  const root = new FakeNode("section");
  renderResult(root, {
    precision: { level: "none", badge: "🔴", label: "분석 불가", reason: "이런_reason_없음" },
    areaName: "해당 지역", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
  });
  assert.match(root.query("note").textContent, /확인할 수 없습니다/);
});

// ---------------------------------------------------------------------
// M1(리뷰 라운드 2): recommend()의 실제 알고리즘상 "판정엔 성공했는데
// top-2에 못 들어 0건"은 존재할 수 없다(judge() 성공 → scored에 들어감 →
// slice(0,limit)이 비었다는 건 scored 자체가 비었다는 뜻 → 그럼 skipped
// 아니면 codes가 0). 알고리즘이 실제로 만들 수 있는 두 갈래만 테스트한다.
// ---------------------------------------------------------------------

test("F7/M1: 대안 0건 + 다른 업종 자체가 없음 → 그 사실을 말한다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 0, skippedCount: 0 } }));
  assert.match(root.query("alternatives").textContent, /비교할 다른 업종 데이터가 없습니다/);
});

test("F7/M1: 대안 0건 + 전부 skipped → skipped 사실이 화면에 남는다(console 전용이 아니다)", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 5, skippedCount: 5 } }));
  const text = root.query("alternatives").textContent;
  assert.match(text, /5개는 모두 데이터 부족·설정 결측으로/);
});

test("M1: 대안 0건 + 전부 층수 적합도 미달(skipped 0) → '판정 실패'가 아니라 '층 기준 미달'이라고 말한다", () => {
  // 이 갈래는 filterByFloor가 minCoefficient 미달로 조용히 뺀 경우다.
  // 현재 배포된 층수 계수가 전부 1.0이라 실데이터로는 아직 안 밟히지만,
  // recommend()의 알고리즘상 가능한 상태라 문구를 남겨둔다.
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 3, skippedCount: 0 } }));
  const text = root.query("alternatives").textContent;
  assert.match(text, /이 층 적합도 기준을 통과하지 못해/);
  assert.doesNotMatch(text, /판정 실패로 제외|더 나은 대안은 없었습니다/,
    "판정에 성공했는데 top-2에 못 들었다는 건 recommend() 알고리즘상 불가능하다 — 그렇게 말하면 안 된다");
});

test("M1: 대안 0건 + 일부만 skipped, 나머지는 층수 미달 → 두 원인이 함께 보인다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 5, skippedCount: 2 } }));
  const text = root.query("alternatives").textContent;
  assert.match(text, /2개는 판정 실패로 제외/);
  assert.match(text, /나머지 3개는 이 층 적합도 기준을 통과하지 못해/);
});

// ---------------------------------------------------------------------
// I2(리뷰 라운드 2): F8은 "asked보다 점수가 높은가"만 봤는데, 그 조건은
// 후보가 "중하"·"하"여도 만족될 수 있다. 실측(청계산원터골, gu 11650,
// 1층): 한식음식점 하(score 28.6643) → 대안 커피-음료 하(33.1455),
// 운동/경기용품 하(31.25) — 둘 다 점수만 높을 뿐 등급은 똑같이 "하"다.
// ---------------------------------------------------------------------

test("I2: 대안이 상/중상이면서 asked보다 점수가 높을 때만 '더 맞는 업종' 헤딩을 쓴다", () => {
  const root = new FakeNode("section");
  const alts = [{ code: "X", name: "네일숍", grade: "상", score: 80, reason: "r", patternsUnknown: [], poolSize: 100, warning: null }];
  renderResult(root, areaPayload({ verdict: { ...VERDICT, score: 60 }, alternatives: alts }));
  const heading = root.query("alternatives").children.find((c) => c.tagName === "h2");
  assert.equal(heading.textContent, "이 자리에 더 맞는 업종");
});

test("I2: 대안 점수가 asked 이하면 중립적 헤딩 + 카드별 경고를 붙인다", () => {
  const root = new FakeNode("section");
  const alts = [
    { code: "X", name: "양식음식점", grade: "중상", score: 55, reason: "r", patternsUnknown: [], poolSize: 100, warning: null },
    { code: "Y", name: "커피-음료", grade: "중하", score: 40, reason: "r", patternsUnknown: [], poolSize: 100, warning: null },
  ];
  renderResult(root, areaPayload({ verdict: { ...VERDICT, score: 60, grade: "상" }, alternatives: alts }));
  const section = root.query("alternatives");
  const heading = section.children.find((c) => c.tagName === "h2");
  assert.equal(heading.textContent, "이 상권의 다른 업종", "asked보다 낮은 대안이 섞였는데 '더 맞는 업종'이라고 하면 거짓 주장이다");
  const cautions = section.queryAll("alt-note").filter((n) => /보다 점수가 낮습니다/.test(n.textContent));
  assert.equal(cautions.length, 2, "두 대안 모두 asked보다 낮으므로 카드마다 경고가 붙어야 한다");
});

test("I2(실측 재현): 대안이 asked보다 점수는 높지만 등급이 똑같이 '하'면 '더 맞는 업종'이라고 하지 않는다", () => {
  const root = new FakeNode("section");
  // 청계산원터골/한식음식점(F1) 실측값 그대로.
  const askedVerdict = { ...VERDICT, grade: "하", meaning: "말립니다", score: 28.6643, rank: "하위 25%" };
  const alts = [
    { code: "CS100010", name: "커피-음료", grade: "하", score: 33.1455, reason: "r", patternsUnknown: [], poolSize: 914, warning: null },
    { code: "CS300024", name: "운동/경기용품", grade: "하", score: 31.25, reason: "r", patternsUnknown: [], poolSize: 200, warning: null },
  ];
  renderResult(root, areaPayload({ verdict: askedVerdict, alternatives: alts }));
  const section = root.query("alternatives");
  const heading = section.children.find((c) => c.tagName === "h2");
  assert.equal(heading.textContent, "이 상권의 다른 업종",
    "verdict.js 자신이 '하'를 '말립니다'라고 하는데 그 등급의 후보를 '더 맞는 업종'이라 부르면 모순이다");
  // asked 자신도 안 좋은 등급이므로 "이 자리 자체가 안 좋다"는 강한 문구가 붙어야 한다.
  assert.match(section.textContent, /어떤 업종에도 특별히 좋아 보이지 않습니다/);
  // 각 카드에도 "적극 추천할 수준은 아니다" 경고가 붙어야 한다(점수는 asked보다 높으므로
  // '점수가 낮다' 캡션이 아니라 '등급이 낮다' 캡션이 붙어야 한다).
  const gradeCautions = section.queryAll("alt-note").filter((n) => /적극 추천할 수준은 아닙니다/.test(n.textContent));
  assert.equal(gradeCautions.length, 2);
});

test("I2: 대안이 전부 중하·하인데 asked 자신은 좋은 등급이면 담담한 문구를 쓴다(강한 문구를 안 쓴다)", () => {
  const root = new FakeNode("section");
  const alts = [
    { code: "X", name: "업종X", grade: "중하", score: 45, reason: "r", patternsUnknown: [], poolSize: 100, warning: null },
    { code: "Y", name: "업종Y", grade: "하", score: 20, reason: "r", patternsUnknown: [], poolSize: 100, warning: null },
  ];
  renderResult(root, areaPayload({ verdict: { ...VERDICT, grade: "상", score: 90 }, alternatives: alts }));
  const text = root.query("alternatives").textContent;
  assert.match(text, /참고용으로만 보십시오/);
  assert.doesNotMatch(text, /어떤 업종에도 특별히 좋아 보이지 않습니다/,
    "asked 자신은 좋은 등급인데 '이 자리 자체가 안 좋다'는 과장된 결론을 내면 안 된다");
});

test("F9: 결과 영역의 첫 heading은 h2다 (h1 -> h3로 건너뛰지 않는다)", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ areaType: "alley" }));
  const headings = flattenHeadings(root);
  assert.ok(headings.length > 0);
  assert.equal(headings[0].tag, "h2", `첫 heading이 h2여야 하는데: ${JSON.stringify(headings)}`);
});

test("dong/none 어느 쪽도 예외 없이 렌더된다 (회귀 방지 — 브리핑 원안이 dong에서 죽던 지점)", () => {
  const root1 = new FakeNode("section");
  assert.doesNotThrow(() => renderResult(root1, {
    precision: { level: "dong", badge: "🟡", label: "행정동 단위 분석" },
    areaName: "해당 지역", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
  }));
  const root2 = new FakeNode("section");
  assert.doesNotThrow(() => renderResult(root2, {
    precision: { level: "none", badge: "🔴", label: "분석 불가", reason: "out_of_bounds" },
    areaName: "해당 지역", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
  }));
});

// ---------------------------------------------------------------------
// I6(리뷰 라운드 2): etl/engine/scoring.py의 grade_cuts()는 industry_code로만
// 묶고 area_type으로는 안 쪼갠다(docstring: "상권종류로는 더 쪼개지 않는다") —
// 즉 rank는 "이 상권 안에서"가 아니라 서울 전역의 같은 업종 기준이다. rank
// 문장과 area-type(F1) 문장이 서로 모순되면 안 된다.
// ---------------------------------------------------------------------

test("I6: rank 문장이 '이 상권 X 중'이 아니라 서울 전역·같은 업종 기준임을 밝힌다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload());
  const rank = root.query("rank").textContent;
  assert.doesNotMatch(rank, /이 상권 .+ 중/, "grade_cuts는 area_type으로 안 쪼갠다 — '이 상권 중'이라고 하면 틀린 말이다");
  assert.match(rank, /서울 전역/);
});

test("I6: rank 문장과 area-type 문장이 서로 모순되지 않는다 — 순위는 전역, 세부 지표는 상권종류별", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ areaType: "alley" }));
  const rank = root.query("rank").textContent;
  const areaTypeText = root.query("area-type").textContent;
  assert.match(rank, /서울 전역/);
  assert.match(areaTypeText, /골목상권 안에서만 비교한 값/);
  // area-type 문장이 "이 순위"를 가리키며 rank 문장을 부정하지 않아야 한다.
  assert.doesNotMatch(areaTypeText, /이 상권 안에서의 순위/);
});

// ---------------------------------------------------------------------
// M4(리뷰 라운드 2): THIN_POOL을 render.js가 narrate.js에서 import하지 않고
// 다시 로컬 상수로 박아두면(값이 같더라도) "두 파일이 같은 기준을 공유한다"는
// 보장이 깨진다. 소스 텍스트 검사로 "재정의하지 않고 import한다"는 사실
// 자체를 고정하고, 별도로 경계값 동작도 확인한다.
// ---------------------------------------------------------------------

test("M4: render.js는 THIN_POOL을 narrate.js에서 import할 뿐 재정의하지 않는다", () => {
  const renderSrc = fs.readFileSync(fileURLToPath(new URL("../js/render.js", import.meta.url)), "utf8");
  assert.match(renderSrc, /import\s*{[^}]*\bTHIN_POOL\b[^}]*}\s*from\s*["']\.\/narrate\.js["']/,
    "render.js가 narrate.js로부터 THIN_POOL을 import해야 한다");
  assert.doesNotMatch(renderSrc, /const\s+THIN_POOL\s*=/,
    "render.js가 THIN_POOL을 로컬로 재정의하면 narrate.js와 기준이 갈릴 수 있다");
});

test("M4: 대안 카드의 얇은 표본 경고는 THIN_POOL 경계에서 정확히 갈린다", () => {
  const root = new FakeNode("section");
  const alts = [
    { code: "X", name: "업종X", grade: "상", score: 90, reason: "r", patternsUnknown: [], poolSize: THIN_POOL - 1, warning: null },
    { code: "Y", name: "업종Y", grade: "상", score: 91, reason: "r", patternsUnknown: [], poolSize: THIN_POOL, warning: null },
  ];
  renderResult(root, areaPayload({ verdict: { ...VERDICT, score: 10, grade: "하" }, alternatives: alts }));
  const cards = root.query("alternatives").queryAll("alt-card");
  assert.match(cards[0].textContent, /표본 .+ 기준/, `poolSize=${THIN_POOL - 1}(THIN_POOL 미만)은 얇은 표본 경고가 붙어야 한다`);
  assert.doesNotMatch(cards[1].textContent, /표본 .+ 기준/, `poolSize=${THIN_POOL}(THIN_POOL과 같음)은 경고가 안 붙어야 한다`);
});

// ---------------------------------------------------------------------
// Task 12: AI 해설. 있으면 요인 목록 위에 문단으로, 없으면 아무것도 하지
// 않는다 — 빈 자리나 "AI 해설 없음" 같은 흔적을 남기지 않는다.
// ---------------------------------------------------------------------

const AI_TEXT = "서교동에서 한식음식점을 여시려는 자리입니다. 통행량은 나쁘지 않지만 경쟁이 만만치 않습니다.";

test("Task 12: narration.aiText가 있으면 요인 목록 위에 문단으로 나온다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({
    narration: { ...NARRATION, aiText: AI_TEXT },
    verdict: { ...VERDICT },
  }));

  const box = root.query("ai-narration");
  assert.ok(box, "ai-narration 노드가 있어야 한다");
  assert.match(box.textContent, /통행량은 나쁘지 않지만/);

  const classes = root.children.map((c) => c.className);
  assert.ok(classes.indexOf("ai-narration") < classes.indexOf("factors"),
    "AI 해설은 요인 목록(ul.factors)보다 위에 와야 한다");
});

test("Task 12: AI 해설에는 그 문단이 AI가 쓴 것이고 등급은 규칙이 계산했다는 고지가 붙는다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ narration: { ...NARRATION, aiText: AI_TEXT } }));
  const note = root.query("ai-narration-note");
  assert.ok(note, "AI가 쓴 문단임을 밝히는 고지가 있어야 한다");
  assert.match(note.textContent, /AI/);
  assert.match(note.textContent, /등급/);
});

test("M2: AI 고지는 AI 문단 안의 수치를 보증하지 않고, 어긋날 때 어느 쪽이 맞는지 밝힌다", () => {
  // 이전 문구는 AI 문단 바로 밑에서 「등급과 근거 수치는 규칙으로 계산된
  // 값입니다」라고 해, 그 문단 **안의** 수치를 우리가 보증한다고 읽혔다.
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ narration: { ...NARRATION, aiText: AI_TEXT } }));
  const note = root.query("ai-narration-note");
  assert.match(note.textContent, /아래/,
    "보증 대상이 AI 문단이 아니라 아래의 규칙 계산 값임을 가리켜야 한다");
  assert.match(note.textContent, /다르게 말하면 아래 값이 맞습니다/,
    "둘이 어긋날 때 규칙 쪽이 우선임을 밝혀야 한다");
});

test("Task 12: aiText가 없으면(AI 실패·미배포) 아무 흔적도 남기지 않는다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload()); // NARRATION에 aiText 없음
  assert.equal(root.query("ai-narration"), null);
  assert.doesNotMatch(root.textContent, /AI/);
});
