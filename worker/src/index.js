// 카카오·OpenRouter 키 은닉용 얇은 프록시. 판정 로직은 여기 없다.
//
// 카카오 REST 키는 도메인 화이트리스트 대상이 아니라 프론트에 두면 그대로 털린다.
// 이 Worker가 유일한 호출 지점이다 — 스펙 9.2.3.
//
// ⚠️ 2026-08-09 개정 (나) — 프록시 남용 방지.
// CORS는 브라우저만 막고 curl은 못 막는다. workers.dev 주소가 알려지면
// 남이 이 프록시로 카카오 할당량을 태우고 OpenRouter 크레딧을 대신 쓰게 할 수
// 있다. OpenRouter는 선불 크레딧을 쓰는 유료 키이므로(2026-08-09 결정) 남용의
// 결과는 "서비스 정지"가 아니라 "청구"다. 그래서 Origin 검사 + KV 일 한도
// 두 겹을 둔다.

const ALLOWED_ORIGINS = ["https://dhshin6023.github.io", "http://localhost:8080"];

// AI 엔드포인트 전용 일 한도. /geocode는 여기 걸리지 않는다 — 아래 aiBudget()
// 주석에 이유를 적었다.
//
// M5: OpenRouter는 유료(크레딧) 키를 쓴다. 따라서 이 전역 한도는 무료 할당량
// 보호 장치가 아니라 **지출 상한**이다 — 하루 최대 AI 호출 수가 곧 하루 최대
// 지출이다. 적정값은 모델 단가에 달렸으므로 코드가 정하지 않고 env로 뺀다
// (기본 100은 출발점일 뿐이다). 자세한 건 README.
const IP_DAILY_LIMIT = 30;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100;
const COUNTER_TTL_SECONDS = 60 * 60 * 48;   // 이틀. 날짜 키가 영원히 쌓이지 않게.

// 업스트림 타임아웃(I2). 브라우저 fetch에도 워커 fetch에도 기본 타임아웃이
// 없다 — 없으면 업스트림이 멈출 때 "조용히 폴백"이 아니라 "조용히 멈춤"이 된다.
const KAKAO_TIMEOUT_MS = 5000;
// ⚠️ 이 값은 **브라우저 쪽 /narrate 타임아웃(narrate.js의 timeoutMs, 4000ms)보다
// 반드시 작아야 한다.** 크면 브라우저가 먼저 포기한 뒤에도 워커는 계속 기다려
// OpenRouter 호출을 끝내고, 그 크레딧은 나가지만 문장은 아무도 못 받는다 —
// 클라이언트가 이미 버렸으니 캐시에도 안 남아 같은 질문에 다음에 또 지불한다.
// 유료 키에서는 이게 그대로 반복 지출이다. 1초는 워커 자체 오버헤드(KV 읽기·
// 쓰기, JSON 처리) 몫으로 남긴 여유다.
const MODEL_TIMEOUT_MS = 3000;

// M6: 일 한도 키는 KST 기준이다. 서울 전용 서비스인데 UTC를 쓰면 한도가
// 09:00 KST에 리셋된다 — 하필 개점 준비 시간대 한복판이다.
const seoulDate = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

// 개정 (다): 기본값은 2024년 프리뷰 모델이라 지금 살아 있다고 가정하지 않는다.
// 2026-08-09 신동환 결정으로 **유료(크레딧) 키를 쓰므로 이 :free 기본값은
// 의도한 설정이 아니다** — 지정을 빠뜨렸을 때 조용히 템플릿으로 떨어지게 두는
// 안전판일 뿐이다. 배포 시 OpenRouter 대시보드에서 쓸 모델의 정확한 id를 확인해
// env.MODEL로 반드시 지정할 것(README). 여기에 특정 id를 미리 적지 않는 이유는
// 그게 이 코드가 확인할 수 없는 사실이기 때문이다.
// 모델이 죽어 있으면 askModel()이 {called:false, text:null}을 반환하고(호출로
// 세지 않는다) 프론트가 템플릿으로 떨어진다.
const DEFAULT_MODEL = "google/gemini-2.0-flash-exp:free";

// N3: `Number(x) || 기본값`은 **0을 기본값으로 되돌린다.** README가 "지출을
// 줄이려면 GLOBAL_DAILY_LIMIT을 내린다"고 안내하는데, 급해서 0을 넣으면 AI가
// 꺼지는 게 아니라 100으로 되살아났다 — 안내와 정반대다. 오타("1,000"→NaN)도
// 조용히 100이 됐다.
// 0은 "AI를 끈다"는 유효한 설정이므로 그대로 존중하고, 해석할 수 없는 값은
// 로그를 남긴 뒤 기본값으로 간다(빌드 없이 콘솔에서 고칠 수 있어야 한다).
function parseLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_GLOBAL_DAILY_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`GLOBAL_DAILY_LIMIT을 해석할 수 없다: ${JSON.stringify(raw)} — 기본값 ${DEFAULT_GLOBAL_DAILY_LIMIT}을 쓴다. 콤마·공백 없는 정수로 넣을 것`);
    return DEFAULT_GLOBAL_DAILY_LIMIT;
  }
  return Math.floor(n);
}

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
  return fetch(url, {
    headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
    signal: AbortSignal.timeout(KAKAO_TIMEOUT_MS),
  });
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
//     비싼 쪽은 건당 크레딧이 나가는 OpenRouter지 카카오(10만/일 무료)가 아니다.
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
  const day = seoulDate();
  const ipKey = `rate:${ip}:${day}`;
  const globalKey = `rate:global:${day}`;

  try {
    const [ipRaw, globalRaw] = await Promise.all([kv.get(ipKey), kv.get(globalKey)]);
    const ipCount = Number(ipRaw) || 0;
    const globalCount = Number(globalRaw) || 0;
    const globalLimit = parseLimit(env.GLOBAL_DAILY_LIMIT);
    // 개정 (나)4: 초과 시에는 읽기만 하고 쓰지 않는다.
    if (ipCount >= IP_DAILY_LIMIT || globalCount >= globalLimit) return null;

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

// 반환은 {called, text}다. M4: "업스트림을 실제로 소비했는가"(called)와
// "쓸 만한 문장이 나왔는가"(text)는 다른 사실이고, 한도를 깎을지는 앞의 것으로
// 정해야 한다. 둘을 뭉뚱그려 null 하나로 돌려주던 예전 버전은 MODEL이 틀렸을 때
// 하루치 예산과 KV 쓰기를 아무 산출 없이 통째로 태웠다((다) 시나리오).
async function askModel(env, system, user, maxTokens) {
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.MODEL ?? DEFAULT_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    // 네트워크 실패·타임아웃 abort. 예전엔 여기서 던진 예외가 바깥 try까지
    // 올라가 500이 나갔고, 프론트는 그걸 폴백이 아니라 오류로 받았다.
    console.error("askModel 업스트림 실패:", error);
    // N2: **타임아웃은 센다.** 우리가 abort해도 요청은 이미 OpenRouter에
    // 도착했고, 모델이 토큰을 뽑았다면 그건 과금된다 — 우리가 안 받았을 뿐이다.
    // 안 세면 업스트림이 느려질 때 한도가 통째로 무력해진다(실측: abort만
    // 반복시키면 500건을 내보내도 전역 카운터가 0). 지출 상한이 "느릴 때만
    // 풀리는" 상한이면 상한이 아니다.
    // 반대로 **송신 전 실패는 세지 않는다** — DNS·연결 실패는 모델에 닿지도
    // 못했으므로 과금이 없고, 이걸 세면 업스트림 장애가 그날 한도를 태운다.
    const dispatched = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { called: dispatched, text: null };
  }
  // 모델 사망·인증 실패 전부 여기 — 프론트가 템플릿으로 떨어진다.
  // 세지 않는다: 4xx는 서버가 생성 전에 거절한 것이라 과금이 없고, MODEL을
  // 잘못 넣었을 때 하루 한도를 통째로 태우는 걸 막는 게 M4의 취지였다.
  if (!res.ok) return { called: false, text: null };

  try {
    const content = (await res.json()).choices?.[0]?.message?.content?.trim();
    // 200을 받았으면 업스트림은 실제로 소비했다 — 내용이 비어도 센다.
    return { called: true, text: content || null };
  } catch (error) {
    console.error("askModel 응답 파싱 실패:", error);
    return { called: true, text: null };
  }
}

// 입구: 자유 입력 업종 → 표준 코드. 확신이 없으면 null을 반환하고 프론트가 목록 선택으로 폴백한다.
async function mapIndustry(body, env, origin, spend) {
  if (!spend) return json({ code: null }, origin);   // 한도 초과·KV 사고(개정 (나)3)

  const candidates = body.candidates ?? [];
  const list = candidates.map((c) => `${c.code}:${c.name}`).join("\n");
  const { called, text } = await askModel(env,
    "너는 업종 분류기다. 주어진 목록에서 가장 가까운 코드 하나만 출력한다. " +
    "확실하지 않으면 정확히 NONE 이라고만 출력한다. 다른 말은 하지 않는다.",
    `입력: ${body.text}\n\n목록:\n${list}`, 16);
  if (called) await spend();   // M4: 부르지도 못한 호출로 한도를 깎지 않는다

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

  const { called, text } = await askModel(env,
    "너는 상권분석 결과를 설명하는 조력자다. 다음 규칙을 반드시 지킨다.\n" +
    "1. 주어진 등급과 수치를 바꾸거나 재해석하지 않는다.\n" +
    "2. %, 퍼센트, 확률이라는 표현을 일절 쓰지 않는다. 성공 가능성을 수치로 말하지 않고, " +
    "순위는 주어진 payload의 표현(예: 상위 절반 이내)을 그대로 쓴다.\n" +
    "3. 주어진 데이터에 없는 사실을 지어내지 않는다.\n" +
    "4. 3~5문장, 존댓말, 창업 선배가 말하듯 담백하게.",
    JSON.stringify(body.payload), 400);
  if (called) await spend();   // M4: 부르지도 못한 호출로 한도를 깎지 않는다

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
