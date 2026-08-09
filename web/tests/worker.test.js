// worker/src/index.js 단위 테스트.
//
// ⚠️ 위치에 대하여: 테스트 대상은 worker/ 아래인데 테스트는 web/tests/에 있다.
// 이 프로젝트의 공식 실행 명령이 `for f in web/tests/*.test.js; do node --test
// "$f"; done` 하나뿐이라, 다른 디렉터리에 두면 아무도 안 돌리게 된다.
// worker/package.json이 {"type":"module"}이라 여기서 그대로 import된다.
//
// 네트워크는 타지 않는다 — 카카오는 global.fetch 스텁으로 대신한다.
// 배포는 이 Task의 범위가 아니므로(개정 (바)) 실키·실주소 검증은 여기 없다.
//
// 2026-08-09: AI 두 엔드포인트를 걷어내면서 이 파일의 22개 테스트가 함께
// 사라졌다(일 한도·지출 상한·모델 타임아웃·프롬프트 규칙·KV 카운터).
// 워커가 하는 일이 카카오 키 은닉 하나로 줄었으니 테스트도 그만큼만 남는다.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../worker/src/index.js";

const ORIGIN = "https://dhshin6023.github.io";
const IP = "203.0.113.7";

// 업스트림(카카오) 대역. url 조각 → 응답 함수.
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

const ENV = () => ({ KAKAO_REST_KEY: "kakao-test" });

// 카카오 주소검색 정상 응답. h_code(행정동)와 b_code(법정동)가 함께 온다.
const KAKAO_ADDRESS_OK = {
  documents: [{
    address_name: "서울 종로구 청운동 1",
    x: "126.9709", y: "37.5896",
    address: { b_code: "1111010100", h_code: "1111051500" },
  }],
};

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

test("알 수 없는 경로는 404다", async () => {
  stubUpstream({});
  const res = await worker.fetch(get("/없는경로"), ENV());
  assert.equal(res.status, 404);
});

test("업스트림이 예외를 던져도 500 응답 하나로 끝난다(내부 메시지를 노출하지 않는다)", async () => {
  stubUpstream({ "search/address.json": () => { throw new Error("KakaoAK abcdef123456 로 호출 실패"); } });
  const res = await worker.fetch(get("/geocode?q=아무거나"), ENV());
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "요청을 처리하지 못했습니다");
  assert.doesNotMatch(JSON.stringify(body), /KakaoAK|abcdef/,
    "키가 섞인 내부 메시지를 응답에 실으면 안 된다");
});

test("카카오 호출에 타임아웃(AbortSignal)이 걸려 있다", async () => {
  // 없으면 카카오가 멈출 때 "조용히 실패"가 아니라 "조용히 멈춤"이 된다.
  const calls = stubUpstream({ "search/address.json": () => jsonResponse(KAKAO_ADDRESS_OK) });
  await worker.fetch(get("/geocode?q=서울 종로구 청운동 1"), ENV());
  assert.ok(calls[0].init?.signal, "카카오 호출에 AbortSignal이 없다");
});

test("AI 제거 후: /narrate와 /map-industry는 더 이상 존재하지 않는다", async () => {
  // 지우고 나서 라우팅에 남아 있으면, 배포된 워커가 OPENROUTER_KEY 없이
  // 그 경로를 받아 500을 내고 프론트는 이유를 알 수 없게 된다.
  stubUpstream({});
  for (const path of ["/narrate", "/map-industry"]) {
    const res = await worker.fetch(get(path), ENV());
    assert.equal(res.status, 404, `${path}가 아직 라우팅에 남아 있다`);
  }
});

test("AI 제거 후: 워커 소스에 OpenRouter·KV 흔적이 남아 있지 않다", async () => {
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = fs.readFileSync(
    fileURLToPath(new URL("../../worker/src/index.js", import.meta.url)), "utf8");
  // 주석의 설명(왜 없앴는지)은 남겨두되, 실제 호출·바인딩은 없어야 한다.
  assert.doesNotMatch(src, /openrouter\.ai\/api/, "OpenRouter 호출이 남아 있다");
  assert.doesNotMatch(src, /env\.RATE|kv\.put|kv\.get/, "KV 사용이 남아 있다");
  assert.doesNotMatch(src, /env\.OPENROUTER_KEY/, "OpenRouter 키 참조가 남아 있다");
});
