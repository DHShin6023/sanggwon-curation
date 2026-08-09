import test from "node:test";
import assert from "node:assert/strict";
import { aiNarration, cacheKey, validateNarration } from "../js/narrate.js";

const RESULT = { industryName: "커피-음료", areaName: "서교동", floor: "F2",
                 grade: "중하", axes: { footfall: 92, competition: 18 }, patterns: [] };

test("cacheKey: 같은 입력은 같은 키", () => {
  assert.equal(cacheKey(RESULT), cacheKey({ ...RESULT }));
});

test("cacheKey: 층수가 다르면 다른 키", () => {
  assert.notEqual(cacheKey(RESULT), cacheKey({ ...RESULT, floor: "F1" }));
});

test("aiNarration: 네트워크 실패 시 null (예외를 던지지 않는다)", async () => {
  const out = await aiNarration(RESULT, {
    endpoint: "http://127.0.0.1:1/narrate", timeoutMs: 200,
  });
  assert.equal(out, null);
});

test("aiNarration: 타임아웃이 걸린다", async () => {
  const started = Date.now();
  await aiNarration(RESULT, { endpoint: "http://10.255.255.1/narrate", timeoutMs: 300 });
  assert.ok(Date.now() - started < 2000, "타임아웃이 동작해야 한다");
});

// ---------------------------------------------------------------------
// 개정 (가): AI 출력 검증. 생성모델이 직접 문장을 만드는 유일한 지점이라
// 「없는 데이터를 지어내지 않는다」가 여기서 무너지면 막을 곳이 없다.
// 프롬프트는 검증이 아니다 — 돌아온 문장을 코드로 다시 본다.
// ---------------------------------------------------------------------

const V = {
  industryName: "커피-음료", areaName: "서교동", floor: "F2", grade: "중하",
  score: 30.5, storeCount: 47, salesPerStore: 12000000, salesTotal: 123456789,
  axes: { footfall: 92, competition: 18 }, patterns: [],
};

const OK_TEXT =
  "서교동에서 커피-음료를 여시려는 자리입니다. 통행량 자체는 나쁘지 않지만 경쟁이 만만치 않습니다. " +
  "무리하게 크게 벌이기보다 작게 시작해 보시길 권합니다.";

test("validateNarration: 규칙을 어기지 않은 문장은 그대로 통과한다", () => {
  assert.equal(validateNarration(OK_TEXT, V), OK_TEXT);
});

test("validateNarration: 20자 미만은 거부한다", () => {
  assert.equal(validateNarration("좋은 자리입니다.", V), null);
});

test("validateNarration: 600자 초과는 거부한다", () => {
  assert.equal(validateNarration("가".repeat(601), V), null);
  assert.equal(validateNarration("가".repeat(600), V), "가".repeat(600));
});

test("validateNarration: %가 들어가면 거부한다", () => {
  assert.equal(
    validateNarration("이 자리에서 살아남을 가능성은 대략 60% 정도로 보시면 됩니다. 신중하게 결정하십시오.", V),
    null,
  );
});

test("validateNarration: '퍼센트'가 들어가면 거부한다", () => {
  assert.equal(
    validateNarration("이 자리에서 살아남을 가능성은 대략 육십 퍼센트 정도로 보시면 됩니다. 신중하게 결정하십시오.", V),
    null,
  );
});

test("validateNarration: '확률'이 들어가면 거부한다", () => {
  assert.equal(
    validateNarration("이 자리에서 성공할 확률은 그리 높지 않으니 신중하게 결정하시길 권해 드립니다.", V),
    null,
  );
});

test("validateNarration: result.grade와 다른 등급을 단정하면 거부한다", () => {
  assert.equal(
    validateNarration("이 자리는 상 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.", V),
    null,
  );
  assert.equal(
    validateNarration("종합하면 중상 등급에 가까운 자리라고 보시면 되겠습니다. 준비만 잘하시면 됩니다.", V),
    null,
  );
});

test("validateNarration: result.grade와 같은 등급을 말하는 건 통과한다", () => {
  const text = "종합하면 중하 등급인 자리입니다. 임대료를 낮추지 못하면 버티기 어려울 수 있습니다.";
  assert.equal(validateNarration(text, V), text);
});

test("validateNarration(오탐 방지): 「이 상권은」·「기대 이상」·「상황」은 등급 단정이 아니다", () => {
  const text =
    "이 상권은 유동인구가 많습니다. 다만 기대 이상으로 경쟁이 몰려 있어 상황이 녹록지 않습니다. " +
    "하루 매출보다 고정비를 먼저 계산해 보시길 권합니다.";
  assert.equal(validateNarration(text, V), text);
});

test("validateNarration(오탐 방지): 「이 상권은 유동인구가 많습니다」는 등급 규칙에 걸리지 않는다", () => {
  // 브리프가 콕 집어 물은 케이스다. 주의 — 이 문장 **단독**(16자)은 통과하지
  // 못하는데, 그건 등급 규칙(3) 때문이 아니라 길이 규칙(1, 20자 미만)
  // 때문이다. 두 이유를 섞어 읽지 않도록 두 방향을 함께 고정한다.
  const bare = "이 상권은 유동인구가 많습니다";
  assert.ok(bare.length < 20, "이 문장 단독은 최소 길이에 못 미친다 — 아래 null은 길이 때문이다");
  assert.equal(validateNarration(bare, V), null);

  // 길이만 채우면 그대로 통과한다 = 「상」 오탐이 없다.
  const long = `${bare}. 다만 경쟁이 몰려 있어 상황이 녹록지 않으니 고정비를 먼저 계산해 보십시오.`;
  assert.equal(validateNarration(long, V), long);
});

test("validateNarration(오탐 방지): 「최상 등급」처럼 다른 낱말에 붙은 「상」은 등급 토큰이 아니다", () => {
  const text = "이 자리는 최상 등급 입지라고 부르기는 어렵지만, 준비에 따라 달라질 여지는 남아 있습니다.";
  assert.equal(validateNarration(text, V), text);
});

test("validateNarration: payload에 없는 수치를 지어내면 거부한다", () => {
  assert.equal(
    validateNarration("이 상권의 커피-음료 점포당 월매출은 3,000만원 수준입니다. 고정비를 먼저 따져 보십시오.", V),
    null,
  );
  assert.equal(
    validateNarration("이 자리 반경 안에는 커피-음료 매장이 이미 218개나 들어와 있는 상태입니다.", V),
    null,
  );
});

test("validateNarration: payload 값의 반올림·천단위 콤마 표기는 통과시킨다", () => {
  const text = "점포는 47개이고 점포당 추정매출은 1,200만원입니다. 상권 전체로는 약 1.2억원 규모입니다.";
  assert.equal(validateNarration(text, V), text);
});

test("validateNarration: 문자열이 아니거나 비면 거부한다", () => {
  assert.equal(validateNarration(null, V), null);
  assert.equal(validateNarration("", V), null);
  assert.equal(validateNarration("   ", V), null);
});

// ---------------------------------------------------------------------
// 개정 (가): aiNarration()은 반환 직전에 반드시 validateNarration()을
// 통과시키고, 캐시(memory/localStorage)에는 통과한 문장만 넣는다.
// ---------------------------------------------------------------------

const ENDPOINT = "http://example.invalid/narrate";
const BAD_GRADE_TEXT = "이 자리는 상 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.";

// 네트워크를 타지 않고 서버 응답만 흉내낸다 — 호출 횟수를 세서 "캐시됐는가"를
// 간접이 아니라 직접 확인한다.
function stubNarrateFetch(text) {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ text }) };
  };
  return () => calls;
}

test("aiNarration: 검증에 실패한 문장은 null이고 캐시에도 남지 않는다", async () => {
  const result = { ...V, areaName: "검증실패동" };
  const calls = stubNarrateFetch(BAD_GRADE_TEXT);

  assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), null);
  assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), null);
  assert.equal(calls(), 2,
    "검증 실패 문장이 캐시됐다면 두 번째 호출은 네트워크를 타지 않았을 것이다");
});

test("aiNarration: 검증을 통과한 문장은 반환되고 캐시된다(회귀 가드)", async () => {
  const result = { ...V, areaName: "검증통과동" };
  const calls = stubNarrateFetch(OK_TEXT);

  assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), OK_TEXT);
  assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), OK_TEXT);
  assert.equal(calls(), 1, "두 번째 호출은 메모리 캐시에서 나와야 한다");
});

test("aiNarration: 서버가 {text: null}이면(모델 사망·일 한도 초과) 조용히 null이다", async () => {
  // 개정 (다)/(나)3 — 워커는 429가 아니라 200 {text: null}로 응답한다.
  // 프론트는 새 분기 없이 기존 폴백(null → 템플릿)을 그대로 탄다.
  global.fetch = async () => ({ ok: true, json: async () => ({ text: null }) });
  assert.equal(await aiNarration({ ...V, areaName: "널응답동" }, { endpoint: ENDPOINT }), null);
});

test("aiNarration: localStorage에는 검증을 통과한 문장만 저장된다", async () => {
  const store = new Map();
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  try {
    const bad = { ...V, areaName: "스토리지실패동" };
    stubNarrateFetch(BAD_GRADE_TEXT);
    assert.equal(await aiNarration(bad, { endpoint: ENDPOINT }), null);
    assert.equal(store.size, 0, "검증 실패 문장이 localStorage에 남으면 안 된다");

    const good = { ...V, areaName: "스토리지통과동" };
    stubNarrateFetch(OK_TEXT);
    assert.equal(await aiNarration(good, { endpoint: ENDPOINT }), OK_TEXT);
    assert.equal(store.get(`narr:${cacheKey(good)}`), OK_TEXT);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});

test("aiNarration: localStorage에 남아 있던 검증 미통과 문장은 쓰지 않는다", async () => {
  // localStorage는 배포를 건너 살아남는다 — 검증 규칙이 바뀌기 전에 저장된
  // 문장이 그대로 화면에 올라가면 검증을 넣은 의미가 없다. 읽을 때도 본다.
  const result = { ...V, areaName: "묵은캐시동" };
  const store = new Map([[`narr:${cacheKey(result)}`, BAD_GRADE_TEXT]]);
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  try {
    stubNarrateFetch(OK_TEXT);
    assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), OK_TEXT);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});
