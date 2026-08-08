// render.js 단위 테스트. 리뷰 라운드 1(2026-08-08)에서 지적된 F1/F2/F5/F6/
// F7/F8/F9를 이 파일에서 고정한다. 실제 브라우저가 아니라 tests/helpers/
// dom-stub.js의 최소 스텁 위에서 돈다 — CSS 렌더링이나 실제 스크린리더
// 동작은 이 테스트로 검증되지 않는다(report에 명시).
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, FakeNode } from "./helpers/dom-stub.js";

installDom();
const { renderResult } = await import("../js/render.js");

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

test("F6: reason이 없으면(방어적 기본값) out_of_bounds 문구로 떨어진다", () => {
  const root = new FakeNode("section");
  renderResult(root, {
    precision: { level: "none", badge: "🔴", label: "분석 불가" },
    areaName: "해당 지역", floorLabel: "1층", industryName: "카페",
    verdict: null, narration: null, alternatives: [],
  });
  assert.match(root.query("note").textContent, /범위 밖/);
});

test("F7: 대안 0건 + 다른 업종 자체가 없음 → 그 사실을 말한다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 0, skippedCount: 0 } }));
  assert.match(root.query("alternatives").textContent, /비교할 다른 업종 데이터가 없습니다/);
});

test("F7: 대안 0건 + 전부 skipped → skipped 사실이 화면에 남는다(console 전용이 아니다)", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 5, skippedCount: 5 } }));
  const text = root.query("alternatives").textContent;
  assert.match(text, /5개는 데이터 부족·설정 결측으로/);
});

test("F7: 대안 0건 + 확인했지만 더 나은 게 없음 → 세 번째 문구로 구분된다", () => {
  const root = new FakeNode("section");
  renderResult(root, areaPayload({ alternatives: [], alternativesContext: { otherCount: 3, skippedCount: 0 } }));
  const text = root.query("alternatives").textContent;
  assert.match(text, /더 나은 대안은 없었습니다/);
  assert.ok(!/데이터 부족/.test(text));
});

test("F8: 모든 대안이 asked보다 높은 점수면 '더 맞는 업종' 헤딩을 쓴다", () => {
  const root = new FakeNode("section");
  const alts = [{ code: "X", name: "네일숍", grade: "상", score: 80, reason: "r", patternsUnknown: [], poolSize: 100, warning: null }];
  renderResult(root, areaPayload({ verdict: { ...VERDICT, score: 60 }, alternatives: alts }));
  const heading = root.query("alternatives").children.find((c) => c.tagName === "h2");
  assert.equal(heading.textContent, "이 자리에 더 맞는 업종");
});

test("F8: 대안 점수가 asked 이하면 중립적 헤딩 + 카드별 경고를 붙인다(중앙고등학교 사례)", () => {
  const root = new FakeNode("section");
  const alts = [
    { code: "X", name: "양식음식점", grade: "중상", score: 55, reason: "r", patternsUnknown: [], poolSize: 100, warning: null },
    { code: "Y", name: "커피-음료", grade: "중하", score: 40, reason: "r", patternsUnknown: [], poolSize: 100, warning: null },
  ];
  renderResult(root, areaPayload({ verdict: { ...VERDICT, score: 60, grade: "상" }, alternatives: alts }));
  const section = root.query("alternatives");
  const heading = section.children.find((c) => c.tagName === "h2");
  assert.equal(heading.textContent, "이 상권의 다른 업종", "asked보다 낮은 대안이 섞였는데 '더 맞는 업종'이라고 하면 거짓 주장이다(F8)");
  const cautions = section.queryAll("alt-note").filter((n) => /보다 점수가 낮습니다/.test(n.textContent));
  assert.equal(cautions.length, 2, "두 대안 모두 asked보다 낮으므로 카드마다 경고가 붙어야 한다");
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
