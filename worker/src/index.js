// 카카오 키 은닉용 얇은 프록시. 판정 로직은 여기 없다.
//
// 카카오 REST 키는 도메인 화이트리스트 대상이 아니라 프론트에 두면 그대로 털린다.
// 이 Worker가 유일한 호출 지점이다 — 스펙 9.2.3. **이것이 이 워커의 유일한
// 존재 이유다.**
//
// ⚠️ 2026-08-09: AI 두 엔드포인트(/narrate, /map-industry)를 걷어냈다.
// 서비스가 「성패를 가르는 나침반」이 아니라 「자리와 업종의 궁합을 개략적으로
// 알려주는 조언자」로 정리되면서, 그 정도 설명은 web/js/narrate.js의 템플릿이
// 데이터에서 직접 만들어낸다(신동환 결정). 업종매핑은 별칭 사전
// (data/domain/industry_aliases.json)으로 대체했다 — 공짜고, 즉시고,
// 거짓말을 못 한다.
//
// 함께 사라진 것: OpenRouter 호출, KV 일 한도 카운터, 지출 상한, spend(),
// 모델 타임아웃, MODEL 설정. **KV 바인딩 자체가 더 이상 필요 없다.**
// 되살릴 일이 생기면 git 이력에서 꺼내되, 클라이언트 쪽 validateNarration을
// 반드시 함께 되살릴 것.

// 2026-09-03: Vercel 배포를 추가했다. 같은 저장소의 web/ 을 GitHub Pages와
// Vercel 두 곳에서 서비스하므로 Origin이 둘이다. 프리뷰 배포
// (sanggwon-curation-<해시>.vercel.app)는 URL이 매번 달라 여기 못 넣는다 —
// 프리뷰에서 주소 검색을 쓰려면 그때 별도로 판단한다.
const ALLOWED_ORIGINS = [
  "https://dhshin6023.github.io",
  "https://sanggwon-curation.vercel.app",
  "http://localhost:8080",
];

// 업스트림 타임아웃. fetch에는 기본 타임아웃이 없어서, 없으면 카카오가 멈출 때
// "조용히 실패"가 아니라 "조용히 멈춤"이 된다.
const KAKAO_TIMEOUT_MS = 5000;

const cors = (origin) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,OPTIONS",
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

// ⚠️ 2026-08-09 실배포에서 밟은 결함. 예전 코드는 `res.ok ? … : null` 한 줄로
// 카카오의 모든 실패를 「문서 없음」과 같은 것으로 뭉갰다. 그 결과:
//
//   카카오 앱에서 카카오맵(로컬) 서비스가 꺼져 있으면 403이 오는데
//   → 화면은 「주소를 찾지 못했습니다. 도로명 또는 지번으로 다시 입력해 주세요」
//
// 주소는 멀쩡히 존재하고 우리 설정이 꺼져 있는 상황이다. 사용자는 주소를
// 몇 번을 고쳐 써도 안 되는데 고쳐 쓰라는 말을 듣는다. 데이터가 뒷받침하지
// 않는 문장을 화면에 내보내는 것 — 이 프로젝트가 계속 잡아온 그 결함이다.
//
// 그래서 「못 찾음」과 「부를 수 없음」을 갈라서 던진다.
//  - 401/403 : 키·권한 설정 문제 (우리 잘못, 사용자가 할 수 있는 게 없다)
//  - 5xx     : 카카오 장애 (기다리는 것 말고 할 게 없다)
//  - 그 외    : 400 등 질의 자체의 문제 → 이건 정말 「못 찾음」이 맞다
class UpstreamError extends Error {
  constructor(status) {
    super(`kakao upstream ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }
}

// 이 로그가 원인 규명의 유일한 통로다. 삼키면 배포 후에 볼 수 있는 건
// 「주소를 찾지 못했습니다」뿐이고, 그건 원인을 하나도 알려주지 않는다.
// (실제로 이 로그 한 줄이 붙고 나서야 403/OPEN_MAP_AND_LOCAL이 보였다.)
const upstreamFailed = async (res, label) => {
  const body = await res.text();
  console.error(`카카오 ${label} 실패 status=${res.status} body=${body.slice(0, 300)}`);
  if (res.status === 401 || res.status === 403 || res.status >= 500) {
    throw new UpstreamError(res.status);
  }
};

const firstDocument = async (res, label) => {
  if (!res.ok) {
    await upstreamFailed(res, label);
    return null;   // 400 등 — 질의 문제이므로 「못 찾음」으로 흘려보낸다
  }
  return (await res.json()).documents?.[0] ?? null;
};

// 키워드검색 결과에는 h_code가 없다 — 좌표로 한 번 더 물어서 행정동을 얻는다.
async function hCodeFromCoords(env, x, y) {
  const res = await kakao(env, "/v2/local/geo/coord2regioncode.json", { x, y });
  if (!res.ok) {
    await upstreamFailed(res, "coord2regioncode");
    return null;
  }
  const docs = (await res.json()).documents ?? [];
  return docs.find((d) => d.region_type === "H")?.code ?? null;
}

async function geocode(query, env, origin) {
  let doc = await firstDocument(
    await kakao(env, "/v2/local/search/address.json", { query }), "주소검색");
  let hCode = doc?.address?.h_code ?? doc?.road_address?.h_code ?? null;

  if (!doc) {   // 도로명·지번 실패 시 키워드 검색으로 한 번 더
    doc = await firstDocument(
      await kakao(env, "/v2/local/search/keyword.json", { query }), "키워드검색");
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") ?? "";

    // 모르는 Origin은 403. 예전의
    // `ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]` 폴백은
    // 삭제했다 — 모르는 Origin에 남의 주소를 CORS 헤더로 돌려주는 건 의미가 없다.
    //
    // ⚠️ 이건 브라우저만 막는다. `curl -H "Origin: ..."` 한 줄로 위조되므로
    // 카카오 할당량(10만/일)에 대한 방어로는 부족하다. 제대로 된 해법은
    // Cloudflare Rate Limiting Rules이며 콘솔에서 거는 배포 단계다(README).
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
      return json({ error: "not found" }, origin, 404);
    } catch (error) {
      // 업스트림을 「부를 수 없었다」와 「불렀는데 결과가 없다」는 사용자가 할
      // 일이 완전히 다르다. 전자에서 주소를 고쳐 쓰라고 하면 영원히 안 된다.
      // 502 = 우리/카카오 쪽 사정이라는 뜻이고, 프론트는 이 메시지를 그대로 띄운다.
      if (error?.name === "UpstreamError") {
        console.error(`카카오를 호출하지 못했다 status=${error.status}`);
        return json({
          error: "주소 조회 서비스에 연결하지 못했습니다. 입력하신 주소 문제가 아니니 잠시 후 다시 시도해 주세요.",
        }, origin, 502);
      }
      // 내부 사정을 그대로 응답에 실으면(예전 `String(error)`) 업스트림 URL·키
      // 관련 문구가 밖으로 샐 수 있다. 자세한 건 로그로만 남긴다.
      console.error("worker 처리 실패:", error);
      return json({ error: "요청을 처리하지 못했습니다" }, origin, 500);
    }
  },
};
