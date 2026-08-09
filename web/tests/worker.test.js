// worker/src/index.js 단위 테스트.
//
// ⚠️ 위치에 대하여: 테스트 대상은 worker/ 아래인데 테스트는 web/tests/에 있다.
// 이 프로젝트의 공식 실행 명령이 `for f in web/tests/*.test.js; do node --test
// "$f"; done` 하나뿐이라, 다른 디렉터리에 두면 아무도 안 돌리게 된다.
// worker/package.json이 {"type":"module"}이라 여기서 그대로 import된다.
//
// 네트워크는 타지 않는다 — 카카오·OpenRouter는 global.fetch 스텁으로,
// Cloudflare KV는 fakeKV로 대신한다. 배포(Step 7)는 이 Task의 범위가
// 아니므로(개정 (바)) 실키·실주소 검증은 여기 없다.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../worker/src/index.js";

const ORIGIN = "https://dhshin6023.github.io";
const IP = "203.0.113.7";
const TODAY = new Date().toISOString().slice(0, 10);

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) { puts.push({ k, v, opts }); store.set(k, v); },
    puts,
    store,
  };
}

// 업스트림(카카오·OpenRouter) 대역. url 조각 → 응답 함수.
function stubUpstream(routes) {
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [needle, handler] of Object.entries(routes)) {
      if (u.includes(needle)) return handler(u, init);
    }
    return new Response("스텁되지 않은 업스트림 호출", { status: 500 });
  };
  return calls;
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const get = (path, { origin = ORIGIN, ip = IP } = {}) =>
  new Request(`https://proxy.example${path}`, {
    headers: { origin, "cf-connecting-ip": ip },
  });

const post = (path, body, { origin = ORIGIN, ip = IP } = {}) =>
  new Request(`https://proxy.example${path}`, {
    method: "POST",
    headers: { origin, "cf-connecting-ip": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ENV = () => ({ KAKAO_REST_KEY: "kakao-test", OPENROUTER_KEY: "or-test", RATE: fakeKV() });

// 카카오 주소검색 정상 응답. h_code(행정동)와 b_code(법정동)가 함께 온다.
const KAKAO_ADDRESS_OK = {
  documents: [{
    address_name: "서울 종로구 청운동 1",
    x: "126.9709", y: "37.5896",
    address: { b_code: "1111010100", h_code: "1111051500" },
  }],
};

const OPENROUTER_OK = (content) => jsonResponse({ choices: [{ message: { content } }] });

// ── Origin 검사 (개정 (나)1) ──────────────────────────────────────────

test("개정 (나)1: 허용되지 않은 Origin은 403이고, CORS 헤더로 남의 주소를 돌려주지 않는다", async () => {
  stubUpstream({});
  const res = await worker.fetch(get("/geocode?q=서울시청", { origin: "https://evil.example" }), ENV());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null,
    "모르는 Origin에 ALLOWED_ORIGINS[0]을 돌려주는 폴백은 삭제됐어야 한다");
});

test("개정 (나)1: Origin 헤더가 아예 없으면(curl) 403이다", async () => {
  stubUpstream({});
  const res = await worker.fetch(
    new Request("https://proxy.example/geocode?q=서울시청"), ENV());
  assert.equal(res.status, 403);
});

test("허용된 Origin의 OPTIONS 프리플라이트는 그 Origin을 그대로 반사한다", async () => {
  stubUpstream({});
  const req = new Request("https://proxy.example/narrate", {
    method: "OPTIONS", headers: { origin: "http://localhost:8080" },
  });
  const res = await worker.fetch(req, ENV());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:8080");
});

// ── /geocode ─────────────────────────────────────────────────────────

test("/geocode: dong_code는 법정동(b_code)이 아니라 행정동(h_code) 8자리다", async () => {
  // 실데이터(web/data/dong/11110.json)의 키는 ADSTRD_CD(행정동) 8자리
  // "11110515"다. b_code를 자르면 "11110101"이 나와 어떤 행정동과도 안 맞고,
  // 🟡 행정동 폴백이 조용히 죽는다.
  stubUpstream({ "search/address.json": () => jsonResponse(KAKAO_ADDRESS_OK) });
  const res = await worker.fetch(get("/geocode?q=서울 종로구 청운동 1"), ENV());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.gu_code, "11110");
  assert.equal(body.dong_code, "11110515");
  assert.equal(body.lng, 126.9709);
  assert.equal(body.lat, 37.5896);
});

test("/geocode: 주소검색이 비면 키워드검색 → 좌표로 행정동코드를 해석한다", async () => {
  const calls = stubUpstream({
    "search/address.json": () => jsonResponse({ documents: [] }),
    "search/keyword.json": () => jsonResponse({
      documents: [{ address_name: "서울 종로구 세종로", x: "126.9770", y: "37.5759" }],
    }),
    "coord2regioncode.json": () => jsonResponse({
      documents: [
        { region_type: "B", code: "1111010100" },
        { region_type: "H", code: "1111051500" },
      ],
    }),
  });
  const res = await worker.fetch(get("/geocode?q=경복궁"), ENV());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.dong_code, "11110515");
  assert.ok(calls.some((c) => c.url.includes("coord2regioncode")),
    "키워드검색 결과에는 h_code가 없다 — 좌표로 한 번 더 물어야 한다");
});

test("/geocode: 끝내 행정동코드를 못 구하면 404다 — 빈 코드를 지어내지 않는다", async () => {
  stubUpstream({
    "search/address.json": () => jsonResponse({ documents: [] }),
    "search/keyword.json": () => jsonResponse({ documents: [] }),
  });
  const res = await worker.fetch(get("/geocode?q=없는주소"), ENV());
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.gu_code, undefined, "찾지 못했는데 빈 문자열 코드를 실어 보내면 안 된다");
});

test("개정 (나)5: KV가 미바인딩이어도 /geocode는 그대로 동작한다(등급이 나와야 한다)", async () => {
  stubUpstream({ "search/address.json": () => jsonResponse(KAKAO_ADDRESS_OK) });
  const res = await worker.fetch(get("/geocode?q=서울 종로구 청운동 1"), { KAKAO_REST_KEY: "k" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dong_code, "11110515");
});

// ── AI 엔드포인트의 일 한도 (개정 (나)2~5) ─────────────────────────────

test("개정 (나)5: KV 미바인딩이면 AI는 건너뛴다 — 모델을 부르지 않고 {text: null}", async () => {
  const calls = stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("아무 말") });
  const res = await worker.fetch(post("/narrate", { payload: { grade: "중하" } }),
    { KAKAO_REST_KEY: "k", OPENROUTER_KEY: "o" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, null);
  assert.equal(calls.length, 0, "비싼 쪽(AI)을 닫는다");
});

test("개정 (나)3/4: IP 일 한도를 넘으면 429가 아니라 200 {text: null}이고, KV에 쓰지 않는다", async () => {
  const kv = fakeKV({ [`rate:${IP}:${TODAY}`]: "30" });
  const calls = stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("아무 말") });
  const res = await worker.fetch(post("/narrate", { payload: { grade: "중하" } }),
    { KAKAO_REST_KEY: "k", OPENROUTER_KEY: "o", RATE: kv });

  assert.equal(res.status, 200, "429를 주면 프론트에 새 분기가 생긴다 — 기존 폴백을 그대로 타게 한다");
  assert.equal((await res.json()).text, null);
  assert.equal(calls.length, 0);
  assert.equal(kv.puts.length, 0, "한도 초과 시 쓰면 KV 무료 쓰기 한도가 먼저 죽는다");
});

test("개정 (나)3: 전역 일 한도를 넘으면 200 {text: null}이다", async () => {
  const kv = fakeKV({ [`rate:global:${TODAY}`]: "400" });
  const calls = stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("아무 말") });
  const res = await worker.fetch(post("/narrate", { payload: { grade: "중하" } }),
    { KAKAO_REST_KEY: "k", OPENROUTER_KEY: "o", RATE: kv });
  assert.equal((await res.json()).text, null);
  assert.equal(calls.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("한도 안이면 모델 문장을 돌려주고 IP·전역 카운터를 함께 올린다", async () => {
  const kv = fakeKV();
  stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("  담백한 해설입니다.  ") });
  const res = await worker.fetch(post("/narrate", { payload: { grade: "중하" } }),
    { KAKAO_REST_KEY: "k", OPENROUTER_KEY: "o", RATE: kv });

  assert.equal((await res.json()).text, "담백한 해설입니다.");
  assert.equal(await kv.get(`rate:${IP}:${TODAY}`), "1");
  assert.equal(await kv.get(`rate:global:${TODAY}`), "1");
  assert.ok(kv.puts.every((p) => p.opts?.expirationTtl > 0),
    "카운터에 TTL이 없으면 날짜별 키가 영원히 쌓인다");
});

// ── 모델 사망 폴백 (개정 (다)) ────────────────────────────────────────

test("개정 (다): 모델 id가 죽어 있으면(OpenRouter 4xx) {text: null}로 떨어진다", async () => {
  stubUpstream({ "openrouter.ai": () => jsonResponse({ error: "no such model" }, 404) });
  const res = await worker.fetch(post("/narrate", { payload: { grade: "중하" } }), ENV());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, null);
});

test("개정 (다): 모델 id는 env.MODEL로 주입된다", async () => {
  const calls = stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("해설") });
  await worker.fetch(post("/narrate", { payload: { grade: "중하" } }),
    { OPENROUTER_KEY: "o", MODEL: "some/current-free-model", RATE: fakeKV() });
  assert.equal(JSON.parse(calls[0].init.body).model, "some/current-free-model");
});

// ── /map-industry ────────────────────────────────────────────────────

const CANDIDATES = [
  { code: "CS100001", name: "한식음식점" },
  { code: "CS100010", name: "커피-음료" },
];

test("/map-industry: 한도 초과면 200 {code: null}이다", async () => {
  const kv = fakeKV({ [`rate:${IP}:${TODAY}`]: "30" });
  const calls = stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("CS100010") });
  const res = await worker.fetch(post("/map-industry", { text: "카페", candidates: CANDIDATES }),
    { OPENROUTER_KEY: "o", RATE: kv });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, null);
  assert.equal(calls.length, 0);
});

test("/map-industry: 모델이 NONE이라고 하면 {code: null}이다", async () => {
  stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("NONE") });
  const res = await worker.fetch(post("/map-industry", { text: "우주선 정비소", candidates: CANDIDATES }), ENV());
  assert.equal((await res.json()).code, null);
});

test("/map-industry: 모델이 목록에 없는 코드를 지어내면 {code: null}이다", async () => {
  stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("CS999999") });
  const res = await worker.fetch(post("/map-industry", { text: "무언가", candidates: CANDIDATES }), ENV());
  assert.equal((await res.json()).code, null);
});

test("/map-industry: 후보 목록에 있는 코드면 그대로 돌려준다", async () => {
  stubUpstream({ "openrouter.ai": () => OPENROUTER_OK("CS100010") });
  const res = await worker.fetch(post("/map-industry", { text: "카페라떼 파는 곳", candidates: CANDIDATES }), ENV());
  assert.equal((await res.json()).code, "CS100010");
});

// ── 기타 ─────────────────────────────────────────────────────────────

test("알 수 없는 경로는 404다", async () => {
  stubUpstream({});
  const res = await worker.fetch(get("/no-such-thing"), ENV());
  assert.equal(res.status, 404);
});

test("업스트림이 예외를 던져도 500 응답 하나로 끝난다(내부 메시지를 노출하지 않는다)", async () => {
  global.fetch = async () => { throw new Error("카카오 키가 유출된 내부 사정"); };
  const res = await worker.fetch(get("/geocode?q=서울시청"), ENV());
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.doesNotMatch(JSON.stringify(body), /유출된 내부 사정/);
});
