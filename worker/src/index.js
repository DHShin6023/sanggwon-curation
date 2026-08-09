// 카카오·OpenRouter 키 은닉용 얇은 프록시. 판정 로직은 여기 없다.
//
// 카카오 REST 키는 도메인 화이트리스트 대상이 아니라 프론트에 두면 그대로 털린다.
// 이 Worker가 유일한 호출 지점이다 — 스펙 9.2.3.
//
// ⚠️ 2026-08-09 개정 (나) — 프록시 남용 방지.
// CORS는 브라우저만 막고 curl은 못 막는다. workers.dev 주소가 알려지면
// 카카오·OpenRouter 무료 할당량을 남이 태울 수 있고, OpenRouter 무료 티어는
// 하루 50건이라 한 명만 긁어도 그날 서비스가 죽는다. 그래서 Origin 검사 +
// KV 일 한도 두 겹을 둔다.

const ALLOWED_ORIGINS = ["https://dhshin6023.github.io", "http://localhost:8080"];

// AI 엔드포인트 전용 일 한도. /geocode는 여기 걸리지 않는다 — 아래 aiBudget()
// 주석에 이유를 적었다.
const IP_DAILY_LIMIT = 30;
const GLOBAL_DAILY_LIMIT = 400;
const COUNTER_TTL_SECONDS = 60 * 60 * 48;   // 이틀. 날짜 키가 영원히 쌓이지 않게.

// 개정 (다): 기본값은 2024년 프리뷰 모델이라 지금 살아 있다고 가정하지 않는다.
// 배포 시 OpenRouter에서 현행 무료 모델을 확인해 env.MODEL로 지정할 것(README).
// 모델이 죽어 있으면 askModel()이 null을 반환하고 프론트가 템플릿으로 떨어진다.
const DEFAULT_MODEL = "google/gemini-2.0-flash-exp:free";

const cors = (origin) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
});

const json = (body, origin, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...cors(origin) },
  });

// ── 지오코딩 ─────────────────────────────────────────────────────────
//
// ⚠️ dong_code는 **행정동 코드**(ADSTRD_CD 8자리)여야 한다.
// 프론트가 이 값으로 web/data/dong/{구}.json을 찾는데, 그 파일의 키는
// 서울 열린데이터광장의 ADSTRD_CD(행정동)다 — 예: "11110515".
// 카카오 주소검색이 주는 b_code는 **법정동** 코드(1111010100)라 8자리로
// 자르면 "11110101"이 나와 어떤 행정동과도 안 맞는다. 그러면 상권 폴리곤
// 밖 주소의 🟡 행정동 폴백이 조용히 죽고 전부 🔴 범위 밖으로 떨어진다.
// 반드시 h_code(1111051500 → "11110515")를 쓴다.

const kakao = (env, path, params) => {
  const url = new URL(`https://dapi.kakao.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` } });
};

const firstDocument = async (res) => (res.ok ? (await res.json()).documents?.[0] ?? null : null);

// 키워드검색 결과에는 h_code가 없다 — 좌표로 한 번 더 물어서 행정동을 얻는다.
async function hCodeFromCoords(env, x, y) {
  const res = await kakao(env, "/v2/local/geo/coord2regioncode.json", { x, y });
  if (!res.ok) return null;
  const docs = (await res.json()).documents ?? [];
  return docs.find((d) => d.region_type === "H")?.code ?? null;
}

async function geocode(query, env, origin) {
  let doc = await firstDocument(await kakao(env, "/v2/local/search/address.json", { query }));
  let hCode = doc?.address?.h_code ?? doc?.road_address?.h_code ?? null;

  if (!doc) {   // 도로명·지번 실패 시 키워드 검색으로 한 번 더
    doc = await firstDocument(await kakao(env, "/v2/local/search/keyword.json", { query }));
    hCode = null;
  }
  if (doc && !hCode) hCode = await hCodeFromCoords(env, doc.x, doc.y);

  // 행정동 코드를 못 구했으면 좌표만 있어도 소용이 없다 — 빈 코드를 실어
  // 보내면 프론트는 "찾긴 찾았는데 데이터 범위 밖"이라는 틀린 결론을 낸다.
  if (!doc || !hCode) return json({ error: "주소를 찾지 못했습니다" }, origin, 404);

  return json({
    lng: Number(doc.x), lat: Number(doc.y),
    gu_code: hCode.slice(0, 5),
    dong_code: hCode.slice(0, 8),
    address: doc.address_name ?? query,
  }, origin);
}

// ── AI 일 한도 ───────────────────────────────────────────────────────
//
// 한도를 KV로 재는 대상은 **AI 두 엔드포인트뿐**이다. /geocode는 Origin
// 검사만으로 두는데, 이유가 둘이다:
//  1. 개정 (나)3·5가 "한도 초과·KV 사고 시에도 등급·근거는 그대로 나와야
//     한다 / /geocode는 통과시킨다"고 못박았다. 지오코딩이 막히면 등급 자체가
//     안 나온다.
//  2. Cloudflare 무료 KV는 쓰기 1,000건/일이다. 세 엔드포인트를 전부 세면
//     분석 1건당 3~6회를 써서 한도 장치가 보호 대상보다 먼저 죽는다.
//     실제로 희소한 자원은 OpenRouter(무료 50 RPD)지 카카오(10만/일)가 아니다.
//
// 반환값: 한도 안이면 "실제로 모델을 부른 뒤 호출할 카운터 증가 함수",
// 한도 초과·KV 오류·미바인딩이면 null(= AI를 건너뛴다).
//
// ⚠️ 한계: read-then-write라 원자적이지 않고 KV는 최종 일관성이다. 동시
// 요청이 몰리면 한도를 조금 넘겨 셀 수 있다 — 이건 정확한 계량기가 아니라
// "하루치를 한 명이 통째로 태우는 것"을 막는 장치다.
async function aiBudget(request, env) {
  const kv = env.RATE;
  if (!kv) return null;   // 미바인딩이면 비싼 쪽을 닫는다(개정 (나)5)

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `rate:${ip}:${day}`;
  const globalKey = `rate:global:${day}`;

  try {
    const [ipRaw, globalRaw] = await Promise.all([kv.get(ipKey), kv.get(globalKey)]);
    const ipCount = Number(ipRaw) || 0;
    const globalCount = Number(globalRaw) || 0;
    // 개정 (나)4: 초과 시에는 읽기만 하고 쓰지 않는다.
    if (ipCount >= IP_DAILY_LIMIT || globalCount >= GLOBAL_DAILY_LIMIT) return null;

    return async () => {
      await Promise.all([
        kv.put(ipKey, String(ipCount + 1), { expirationTtl: COUNTER_TTL_SECONDS }),
        kv.put(globalKey, String(globalCount + 1), { expirationTtl: COUNTER_TTL_SECONDS }),
      ]);
    };
  } catch {
    return null;   // KV 오류도 AI를 건너뛴다(개정 (나)5)
  }
}

async function askModel(env, system, user, maxTokens) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENROUTER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.MODEL ?? DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) return null;   // 모델 사망·인증 실패 전부 여기 — 프론트가 템플릿으로 떨어진다
  return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
}

// 입구: 자유 입력 업종 → 표준 코드. 확신이 없으면 null을 반환하고 프론트가 목록 선택으로 폴백한다.
async function mapIndustry(body, env, origin, spend) {
  if (!spend) return json({ code: null }, origin);   // 한도 초과·KV 사고(개정 (나)3)

  const candidates = body.candidates ?? [];
  const list = candidates.map((c) => `${c.code}:${c.name}`).join("\n");
  const text = await askModel(env,
    "너는 업종 분류기다. 주어진 목록에서 가장 가까운 코드 하나만 출력한다. " +
    "확실하지 않으면 정확히 NONE 이라고만 출력한다. 다른 말은 하지 않는다.",
    `입력: ${body.text}\n\n목록:\n${list}`, 16);
  await spend();

  // 모델이 목록에 없는 코드를 지어낼 수 있다 — 후보에 실재하는 코드만 통과시킨다.
  const code = text && text !== "NONE"
    ? candidates.find((c) => text.includes(c.code))?.code ?? null
    : null;
  return json({ code }, origin);
}

// 출구: 판정 결과 → 해설. 판정을 바꾸지 못하게 프롬프트로 봉한다.
//
// ⚠️ 프롬프트는 검증이 아니다. 아래 규칙을 어긴 문장이 돌아올 수 있고, 그건
// 클라이언트의 narrate.js:validateNarration()이 다시 거른다(개정 (가)).
// 검증을 워커가 아니라 클라이언트에 둔 이유는 폴백 경로가 거기 있고,
// 배포 없이 node --test로 검증되기 때문이다.
async function narrate(body, env, origin, spend) {
  if (!spend) return json({ text: null }, origin);   // 한도 초과·KV 사고(개정 (나)3)

  const text = await askModel(env,
    "너는 상권분석 결과를 설명하는 조력자다. 다음 규칙을 반드시 지킨다.\n" +
    "1. 주어진 등급과 수치를 바꾸거나 재해석하지 않는다.\n" +
    "2. 성공 확률을 %로 말하지 않는다.\n" +
    "3. 주어진 데이터에 없는 사실을 지어내지 않는다.\n" +
    "4. 3~5문장, 존댓말, 창업 선배가 말하듯 담백하게.",
    JSON.stringify(body.payload), 400);
  await spend();

  return json({ text }, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") ?? "";

    // 개정 (나)1: 모르는 Origin은 403. 예전의
    // `ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]` 폴백은
    // 삭제했다 — 모르는 Origin에 남의 주소를 CORS 헤더로 돌려주는 건 의미가 없다.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    const { pathname, searchParams } = new URL(request.url);
    try {
      if (pathname === "/geocode") {
        return await geocode(searchParams.get("q") ?? "", env, origin);
      }
      if (pathname === "/map-industry") {
        return await mapIndustry(await request.json(), env, origin, await aiBudget(request, env));
      }
      if (pathname === "/narrate") {
        return await narrate(await request.json(), env, origin, await aiBudget(request, env));
      }
      return json({ error: "not found" }, origin, 404);
    } catch (error) {
      // 내부 사정을 그대로 응답에 실으면(예전 `String(error)`) 업스트림 URL·키
      // 관련 문구가 밖으로 샐 수 있다. 자세한 건 로그로만 남긴다.
      console.error("worker 처리 실패:", error);
      return json({ error: "요청을 처리하지 못했습니다" }, origin, 500);
    }
  },
};
