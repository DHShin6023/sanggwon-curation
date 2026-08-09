import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { aiNarration, aiPayload, cacheKey, validateNarration } from "../js/narrate.js";
import { judge, rankLabel } from "../js/verdict.js";

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
  const key = `narr:${cacheKey(result)}`;
  const store = new Map([[key, BAD_GRADE_TEXT]]);
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    stubNarrateFetch(OK_TEXT);
    assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), OK_TEXT);
    assert.equal(store.get(key), OK_TEXT,
      "재검증에 떨어진 묵은 문장은 새로 통과한 문장으로 대체돼야 한다");
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});

test("M3: 재검증에 떨어진 localStorage 항목은 즉시 지워진다", async () => {
  // 안 지우면 그 (상권·업종·층수·등급) 조합은 매번 읽히고 매번 거부돼 영영
  // 캐시 적중 없이 모델을 다시 부른다 — 유료 키에서는 그대로 반복 지출이다.
  // 위 테스트와 달리 이번 호출은 모델도 실패시켜, 지우는 동작이 "새 문장으로
  // 덮어써서" 지워진 것처럼 보이는 게 아님을 분리해 확인한다.
  const result = { ...V, areaName: "묵은캐시삭제동" };
  const key = `narr:${cacheKey(result)}`;
  const store = new Map([[key, BAD_GRADE_TEXT]]);
  const removed = [];
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => { removed.push(k); store.delete(k); },
  };
  try {
    stubNarrateFetch(BAD_GRADE_TEXT);   // 모델도 못 통과 → 덮어쓸 문장이 없다
    assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), null);
    assert.deepEqual(removed, [key], "미통과 항목에 removeItem이 불려야 한다");
    assert.equal(store.has(key), false, "미통과 항목이 그대로 남으면 안 된다");
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});

test("storage가 막힌 환경에서도 검증을 통과한 문장은 버려지지 않는다", async () => {
  // 사파리 프라이빗 모드는 setItem에서 QuotaExceededError를 던지고, 이 캐시는
  // 비우는 코드가 없어 오래 쓰면 한도에 닿는다. 그때 반환값까지 null로
  // 떨어지면 **이미 크레딧을 치르고 받아 검증까지 통과한 문장**이 버려진다.
  // removeItem이 없는 구형 storage도 같은 자리에서 TypeError를 낸다.
  // (이 테스트를 쓰다가 발견한 결함이다 — 리뷰 지적 M3와는 별건.)
  const result = { ...V, areaName: "구형스토리지동" };
  const store = new Map([[`narr:${cacheKey(result)}`, BAD_GRADE_TEXT]]);
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: () => { throw new Error("QuotaExceededError"); },
    // removeItem 없음 — 호출하면 TypeError
  };
  try {
    stubNarrateFetch(OK_TEXT);
    assert.equal(await aiNarration(result, { endpoint: ENDPOINT }), OK_TEXT);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});

// ---------------------------------------------------------------------
// I1(리뷰 1라운드): 우리가 모델에게 %가 든 payload를 주고서, %가 든 출력을
// 거부하고 있었다. rankLabel()의 네 갈래가 전부 "상위 25% 이내"처럼 %를
// 담고 있고 그게 judge() → narrationInput → 워커로 그대로 갔다. 결과적으로
// **payload를 정확히 인용한 문장은 거부되고 아무 수치도 안 대는 모호한
// 문장만 통과**했다 — 인센티브가 정확히 거꾸로였다.
//
// 이게 배포될 뻔한 이유는 위 V 픽스처에 rank가 없어서 validateNarration이
// 현실적인 payload로는 한 번도 돌아본 적이 없었기 때문이다. 그래서 여기서는
// 실데이터로 judge()를 실제로 돌려 그 반환을 픽스처로 쓴다.
// ---------------------------------------------------------------------

const REAL = (() => {
  const meta = JSON.parse(fs.readFileSync(new URL("../data/meta.json", import.meta.url), "utf8"));
  const scores = JSON.parse(fs.readFileSync(new URL("../data/score/11110.json", import.meta.url), "utf8"));
  const area = scores.areas["3110008"];            // 배화여자대학교(박노수미술관)
  const entry = area.industries.CS100001;          // 한식음식점
  const verdict = judge({
    entry,
    cuts: meta.grade_cuts.CS100001,
    group: Object.fromEntries(meta.industries.map((i) => [i.code, i.group])).CS100001,
    floor: "F2",
    floorTable: meta.floor_config.coefficients,
    warnBelow: meta.floor_config.warn_below,
  });
  return { ...verdict, industryName: "한식음식점", areaName: area.name, floor: "F2", baseScore: entry.base };
})();

test("I1(회귀의 근원): judge()의 실제 반환에는 %가 든 rank가 들어 있다", () => {
  assert.match(REAL.rank, /%/, "이 전제가 깨지면 아래 테스트들의 의미가 달라진다");
});

test("I1: aiPayload는 payload에서 %를 걷어내되 rank의 정보는 남긴다", () => {
  const payload = aiPayload(REAL);
  assert.doesNotMatch(JSON.stringify(payload), /%|퍼센트|확률/);
  assert.ok(payload.rank, "rank를 그냥 지우면 AI 해설이 템플릿보다 빈약해진다");
  assert.notEqual(payload.rank, REAL.rank);
});

test("I1: rankLabel이 낼 수 있는 네 갈래가 전부 %-없는 표현으로 옮겨진다", () => {
  // rankLabel의 분기가 늘거나 문구가 바뀌면 여기서 잡힌다.
  const cuts = [75, 50, 25];
  const labels = [...new Set([90, 60, 30, 10].map((s) => rankLabel(s, cuts)))];
  assert.equal(labels.length, 4, "rankLabel은 네 갈래라는 전제");
  for (const rank of labels) {
    const moved = aiPayload({ ...V, rank }).rank;
    assert.ok(moved, `"${rank}"에 대응하는 %-없는 표현이 없다 — 매핑을 추가해야 한다`);
    assert.doesNotMatch(moved, /%|퍼센트|확률/);
  }
});

test("I1: rank 말고 다른 필드에 %가 섞여 들어와도 AI payload에서 빠진다", () => {
  // 나중에 %를 담은 필드가 하나 더 생겨도 같은 사고가 반복되지 않게 한다.
  const payload = aiPayload({ ...REAL, futureField: "상위 12% 수준" });
  assert.doesNotMatch(JSON.stringify(payload), /%|퍼센트|확률/);
});

test("I1(핵심): payload를 정확히 인용한 문장이 검증을 통과한다", () => {
  const payload = aiPayload(REAL);
  const text =
    `${payload.areaName}에서 한식음식점은 ${payload.rank}에 해당합니다. ` +
    `이미 ${payload.storeCount}개가 영업 중이라 경쟁이 가볍지 않습니다. ` +
    "임대료와 고정비를 먼저 계산해 보시길 권합니다.";
  assert.equal(validateNarration(text, payload), text,
    "payload를 정확히 인용한 문장이 거부되면 모호한 문장만 살아남는다");
});

test("I1: aiNarration이 워커로 보내는 payload에도 %가 없다", async () => {
  let sent = null;
  global.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ text: OK_TEXT }) };
  };
  await aiNarration({ ...REAL, areaName: "퍼센트제거동" }, { endpoint: ENDPOINT });
  assert.ok(sent, "요청이 나갔어야 한다");
  assert.doesNotMatch(JSON.stringify(sent), /%|퍼센트|확률/);
});

// ---------------------------------------------------------------------
// M1(리뷰 1라운드): 따옴표·괄호로 감싼 등급이 규칙 3을 그대로 빠져나갔다.
// 모델은 payload에서 등급을 문자열로 받으므로 인용부호를 붙여 쓰는 건
// 오히려 자연스러운 출력 형태다.
// ---------------------------------------------------------------------

test("M1: 따옴표·괄호로 감싼 다른 등급도 거부한다", () => {
  const quoted = [
    "이 자리는 '상' 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.",
    "이 자리는 「상」 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.",
    'この자리는 "중상" 등급이라 지금 들어가셔도 충분히 해볼 만합니다. 준비만 잘하시면 됩니다.',
    "이 자리는 (상) 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.",
    "이 자리는 [중상] 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.",
    "이 자리는 ‘상’ 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.",
    "이 자리는 “중상” 등급이라 지금 들어가셔도 충분히 해볼 만한 조건입니다.",
  ];
  for (const text of quoted) {
    assert.equal(validateNarration(text, V), null, `거부했어야 한다: ${text}`);
  }
});

test("M1: 감싼 등급이 result.grade와 같으면 통과한다", () => {
  const text = "종합하면 '중하' 등급인 자리입니다. 임대료를 낮추지 못하면 버티기 어려울 수 있습니다.";
  assert.equal(validateNarration(text, V), text);
});

test("M1: 규칙을 넓힌 뒤에도 오탐 케이스는 전부 통과한다", () => {
  const shouldPass = [
    "이 상권은 유동인구가 많습니다. 다만 고정비를 먼저 계산해 보시길 권해 드립니다.",
    "기대 이상 등급의 입지를 찾으시는 거라면 이 자리는 조금 아쉬울 수 있겠습니다.",
    "이 자리를 최상 등급 입지라고 부르기는 어렵지만 준비에 따라 달라질 여지는 있습니다.",
    "중상위 상권을 기준으로 보시면 이 자리는 조금 아래에 있다고 보시면 되겠습니다.",
    "상황 등급을 따지기 전에 임대료부터 확인해 보시길 권해 드립니다. 그게 먼저입니다.",
  ];
  for (const text of shouldPass) {
    assert.equal(validateNarration(text, V), text, `통과했어야 한다: ${text}`);
  }
});
