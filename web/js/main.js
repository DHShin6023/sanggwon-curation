// 화면 진입점.
//
// 2026-08-09: AI 두 곳(업종매핑 입구·해설 출구)을 걷어냈다. 지금 이 페이지의
// 모든 문장은 룰엔진 산출물이고, 브라우저가 외부를 부르는 곳은 /geocode
// 하나뿐이다. 업종매핑은 별칭 사전이, 해설은 templateNarration()이 대신한다.
//
// ⚠️ 2026-08-08 개정 블록 반영:
//  (가) 자산은 web/data/meta.json 하나에서만 온다.
//  (나) 창업 필터(필터 ①)는 폐기됐다 — startupFilter 자산 없음.
//  (다) recommend()는 {recommendations, skipped}를 반환한다.
//  (라) judge()는 entry.base===null이거나 group/floor가 floorTable에 없으면
//      던진다 — analyze()가 잡아서 🔴 "분석 불가"로 떨어뜨린다.
//
// ⚠️ 리뷰 라운드 1(2026-08-08) 반영 — 상세는 task-11-report.md의 "Fix round 1" 절.
//  F1  등급이 매겨진 채점 풀(골목/전통시장/광역)을 화면에 드러낸다.
//  F4  meta.json 로드 실패가 module top-level에서 조용히 죽지 않게 한다.
//      submit 리스너는 부트스트랩 성패와 무관하게 항상 등록된다.
//  F5  🟡 행정동 단위는 🔴 분석 불가로 이어지지 않는다 — dong 원자료(있으면)를
//      보여주거나, 없으면 그 사실을 그대로 말한다.
//  F6  🔴 분석 불가의 세 가지 원인(범위 밖 / 업종 데이터 없음 / 설정 오류)을
//      precision.reason으로 구분해 넘긴다.
//  F7  대안 0건일 때 "왜 0건인지"(다른 업종 자체가 없음 / 판정 실패로 제외됨 /
//      확인했지만 더 나은 게 없었음)를 payload에 실어 render.js가 구분해 보여준다.
//
// ⚠️ 리뷰 라운드 2(2026-08-09) 반영 — 상세는 task-11-report.md의 "Fix round 2" 절.
//  C1  entry.base(baseScore)를 narrate.js에 넘겨, "층수가 영향을 줬는가"를
//      하드코딩 대신 실제 점수 비교로 판단하게 한다.
//  I1  meta.json이 200이어도 모양이 불완전할 수 있다(캐시된 구버전 등) —
//      validateMeta()로 부트스트랩 try 블록 안에서 필수 필드를 확인한다.
//  M6  role="alert"는 에러 <p>에 있지 root에 없다 — root.removeAttribute
//      ("role")는 아무 일도 안 하는 죽은 코드였다, 제거.
//  M7  FLOOR_LABELS[floor]가 undefined면 그 문자열 그대로가 아니라 원본
//      floor 코드를 보여준다.

import { matchArea, resolvePrecision } from "./locate.js";
import { judge, FLOOR_LABELS } from "./verdict.js";
import { recommend } from "./alternatives.js";
import { templateNarration } from "./narrate.js";
import { renderResult } from "./render.js";

// 워커 주소. wrangler.toml의 name(sanggwon-proxy) + 계정 서브도메인으로 정해진다.
// 서브도메인은 맛집 큐레이션 프록시(matzip-naver-proxy.dhshin6023.workers.dev)와
// 같은 계정이라 이미 확정돼 있다.
//
// ⚠️ 아직 배포 전이면 이 주소는 응답하지 않고, geocode()가 「주소 조회에
// 실패했습니다」를 띄운다. 지오코딩은 **폴백이 없는 유일한 경로**다 —
// 좌표를 모르면 어느 상권인지 알 수 없고, 모르는 채로 등급을 지어낼 수는 없다.
// 조용히 넘어가지 않고 화면에 보이는 게 맞다.
const PROXY = "https://sanggwon-proxy.dhshin6023.workers.dev";

// N7: /geocode에는 타임아웃이 아예 없었다. 이 호출이 멈추면 등급 자체가 안
// 나오므로 **화면이 통째로 아무 변화 없이 선다**. 넉넉히 잡되 무한 대기만은 막는다.
// 워커 쪽 카카오 호출이 최대 3번(주소검색 → 키워드검색 → coord2regioncode)이라
// 워커 총 예산이 이 값을 넘을 수 있는데, 그건 감수한다 — 카카오는 건당 과금이
// 아니라 무료 할당량(10만/일)이라 버려지는 호출의 대가가 크레딧이 아니고,
// 사용자를 15초씩 세워두는 쪽이 더 비싸다.
//
// 2026-08-09: AI 두 엔드포인트를 걷어내면서 브라우저가 워커를 부르는 곳은
// 여기 하나만 남았다. 예전에 있던 "안쪽이 바깥쪽보다 짧아야 한다"는 규칙은
// 유료 호출이 버려지는 걸 막으려던 것이라, 지오코딩에는 적용되지 않는다.
const GEOCODE_TIMEOUT_MS = 10000;

const cache = new Map();
const loadJson = async (path) => {
  if (!cache.has(path)) cache.set(path, fetch(path).then((r) => (r.ok ? r.json() : null)));
  return cache.get(path);
};

// I1(리뷰 라운드 2): meta.json이 200으로 응답해도 모양이 불완전할 수
// 있다 — 예를 들어 브라우저 캐시가 649d7d3 이전(구버전, floor_config 없음)
// meta.json을 들고 있는데 새 JS가 배포되면, `!meta` 가드는 통과하지만
// `meta.floor_config.coefficients`에서 그대로 죽는다. fetch 성공 여부뿐
// 아니라 필요한 필드가 실제로 있는지까지 부트스트랩 try 블록 안에서 확인한다.
function validateMeta(m) {
  const required = ["period_label", "sources", "industries", "grade_cuts", "floor_config", "gu"];
  for (const key of required) {
    if (m[key] == null) {
      throw new Error(`meta.json에 "${key}" 필드가 없습니다(캐시된 구버전이거나 배포가 깨졌을 수 있습니다). 새로고침해 주세요.`);
    }
  }
  if (!Array.isArray(m.industries) || !Array.isArray(m.sources)) {
    throw new Error("meta.json의 industries/sources가 배열이 아닙니다. 새로고침해 주세요.");
  }
  const fc = m.floor_config;
  if (typeof fc !== "object" || !fc.coefficients || typeof fc.warn_below !== "number" || typeof fc.min_coefficient !== "number") {
    throw new Error("meta.json의 floor_config가 불완전합니다(캐시된 구버전 JS/데이터 조합일 수 있습니다). 새로고침해 주세요.");
  }
}

// --- 부트스트랩 -------------------------------------------------------
// meta.json 로드 실패(배포 중 404 등)나 불완전한 모양이 여기서 예외로
// 죽으면 아래 addEventListener("submit", ...) 등록 자체가 실행되지 않는다.
// 그러면 "분석하기" 버튼은 그냥 네이티브 폼 제출을 일으켜 페이지가
// 새로고침되고 사용자에게는 아무 설명도 없이 입력값만 날아간다(F4). meta
// 로드+검증은 반드시 같은 try/catch로 감싸고, submit 리스너는 그 성패와
// 무관하게 항상 등록한다.
let meta = null;
let bootError = null;
try {
  const loaded = await loadJson("data/meta.json");
  if (!loaded) throw new Error("데이터를 불러오지 못했습니다(404). 잠시 후 새로고침해 주세요.");
  validateMeta(loaded);
  meta = loaded; // 검증까지 통과한 뒤에만 meta를 채운다 — 부분 로드 상태로 아래 코드가 돌지 않게.
} catch (err) {
  bootError = err;
  meta = null;
  console.error("부트스트랩 실패:", err.message);
}

const periodEl = document.getElementById("data-period");
const sourcesEl = document.getElementById("sources");
const provisionalEl = document.getElementById("provisional-notice");

let assets = null;
if (meta) {
  if (periodEl) periodEl.textContent = `데이터 기준: ${meta.period_label}`;
  if (sourcesEl) sourcesEl.textContent = `출처: ${meta.sources.join(" / ")}`;

  // meta.provisional: true는 "floor_config의 계수가 아직 실측이 아니라
  // 잠정값"이라는 뜻이다. C1(리뷰 라운드 2): 예전 문구는 "반영되지 않고
  // 있을 수 있습니다"로 방향을 하드코딩된 애매함으로 얼버무렸는데, 실제로는
  // 지금 로드한 floor_config.coefficients를 직접 보면 전부 1.0인지 아닌지
  // 확실히 알 수 있다 — 확실히 아는 걸 "있을 수 있다"고 하지 않는다.
  if (provisionalEl && meta.provisional) {
    const allFloorCoefficientsAreOne = Object.values(meta.floor_config.coefficients)
      .every((group) => Object.values(group).every((c) => c === 1));
    provisionalEl.hidden = false;
    provisionalEl.textContent = allFloorCoefficientsAreOne
      ? "⚠ 이 서비스의 층수 보정 계수는 현재 전부 1.0(잠정값)입니다 — 층수는 지금 등급 계산에 전혀 영향을 주지 않습니다."
      : `⚠ 이 서비스의 층수 보정 계수는 아직 잠정값입니다(기준: ${meta.floor_basis ?? "heuristic"}). 실제 현장 감각과 다를 수 있습니다.`;
  }

  assets = {
    groups: Object.fromEntries(meta.industries.map((i) => [i.code, i.group])),
    floorTable: meta.floor_config.coefficients,
    warnBelow: meta.floor_config.warn_below,
    minCoefficient: meta.floor_config.min_coefficient,
  };
} else if (periodEl) {
  periodEl.textContent = "데이터를 불러오지 못했습니다. 새로고침해 주세요.";
}

// 업종 매핑. 네트워크를 타지 않는다 — 2026-08-09에 AI 경로를 걷어냈고
// 별칭 사전이 그 자리를 대신한다(아래 mapIndustryLocal 주석 참고).
//
// 정확히 일치하면 그걸 우선한다 — datalist가 실제 업종명을 보여주므로
// 대부분의 정상 입력은 여기서 끝난다. 아주 짧은 입력(길이<2)은 부분일치를
// 시도하지 않는다 — "점" 한 글자가 "한식음식점" 등 거의 모든 음식점류와
// 매치되는 것처럼, 부분일치가 오탐을 낼 위험이 커진다.
const normalizeQuery = (s) => (s ?? "").trim().replace(/\s+/g, "");

// 별칭 사전(meta.industry_aliases)이 AI 업종매핑을 대체한다 — 2026-08-09 결정.
//
// 근거: 창업자가 실제로 쓸 법한 어휘 37개를 넣어보니 이름 부분일치만으로는
// 26개(70%)가 실패했다. 그것도 카페·치킨집·술집·빵집·약국·병원처럼 가장 흔한
// 말들이다("카페"는 "커피-음료"에 걸리지 않는다). AI로 메우던 자리인데,
// 사전이 더 낫다: 공짜고, 즉시고, 거짓말을 못 하고, 틀리면 한 줄 고치면 된다.
// (AI 매핑은 「미용」을 자동차미용으로 보내던 오답 전력이 있다.)
//
// 순서가 중요하다. 정확일치 → 별칭 → 부분일치.
// 별칭을 부분일치보다 먼저 두지 않으면 「치킨집」이 부분일치에서 엉뚱한 데
// 걸릴 수 있다. 부분일치는 마지막 그물이다.
function mapIndustryLocal(q) {
  const exact = meta.industries.find((i) => i.name === q);
  if (exact) return exact;

  const key = normalizeQuery(q);
  const aliased = meta.industry_aliases?.[key];
  if (aliased) {
    const hit = meta.industries.find((i) => i.code === aliased);
    // 사전이 가리키는 코드가 목록에 없으면 업종을 지어내지 않고 넘어간다.
    // (빌드가 막고 있지만, 낡은 meta.json이 캐시돼 있을 수 있다.)
    if (hit) return hit;
  }

  // 아주 짧은 입력(길이<2)은 부분일치를 시도하지 않는다 — "점" 한 글자가
  // "한식음식점" 등 거의 모든 음식점류와 매치되는 것처럼 오탐이 커진다.
  if (q.length < 2) return null;
  return meta.industries.find((i) => i.name.includes(q) || q.includes(i.name)) ?? null;
}

// 못 찾으면 null이고, 호출부가 「목록에서 선택해 주세요」를 띄운다
// (스펙 10.2 입구 폴백). 목록은 입력창 datalist에 항상 떠 있다.
function mapIndustry(text) {
  if (!meta) return null;
  const q = (text ?? "").trim();
  if (!q) return null;
  return mapIndustryLocal(q);
}

// datalist: 사용자가 실제로 존재하는 업종명을 볼 수 있게 한다 — 폼이
// 광고하는 예시 입력이 전부 실패하던 문제(리뷰 F11)의 근본 대응. 정적
// 목록이라 별도 의존성이 없다.
const industryList = document.getElementById("industry-options");
if (industryList && meta) {
  for (const industry of meta.industries) {
    const option = document.createElement("option");
    option.value = industry.name;
    industryList.append(option);
  }
}

async function geocode(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${PROXY}/geocode?q=${encodeURIComponent(address)}`,
      { signal: controller.signal });
  } catch (error) {
    // 멈춘 것과 못 찾은 것은 사용자가 할 일이 다르다. 주소를 고쳐 쓰라는
    // 안내를 접속 실패에 띄우면 멀쩡한 주소를 계속 고쳐 쓰게 된다.
    throw new Error(error?.name === "AbortError"
      ? "주소 조회가 지연되고 있습니다. 잠시 후 다시 시도해 주세요."
      : "주소 조회에 실패했습니다. 네트워크 상태를 확인해 주세요.");
  } finally {
    clearTimeout(timer);
  }
  // ⚠️ 2026-08-09 실배포: 예전엔 !res.ok를 전부 「주소를 찾지 못했습니다.
  // 도로명 또는 지번으로 다시 입력해 주세요」로 뭉갰다. 카카오맵 서비스가
  // 꺼져 있어 워커가 502로 "주소 문제가 아니다"라고 말해주는데도 화면은
  // 주소 탓을 했고, 사용자는 멀쩡한 주소를 계속 고쳐 쓰게 된다.
  //
  // 워커가 이유를 말해줬으면 그 문장을 그대로 쓴다. 404(정말 못 찾음)일 때만
  // 주소를 고쳐 쓰라고 안내한다 — 그때는 그게 실제로 해결책이다.
  if (!res.ok) {
    let upstream = null;
    try {
      upstream = (await res.json())?.error ?? null;
    } catch {
      upstream = null;   // 본문이 없거나 JSON이 아닌 경우(구버전 워커 등)
    }
    if (res.status !== 404 && upstream) throw new Error(upstream);
    throw new Error("주소를 찾지 못했습니다. 도로명 또는 지번으로 다시 입력해 주세요.");
  }
  return res.json();   // { lng, lat, gu_code, dong_code }
}

export async function analyze({ address, industryText, floor }) {
  if (!meta || !assets) {
    throw new Error(bootError?.message ?? "서비스 초기화에 실패했습니다. 새로고침해 주세요.");
  }

  const industry = await mapIndustry(industryText);
  if (!industry) throw new Error("업종을 인식하지 못했습니다. 목록에서 선택해 주세요.");

  // 워커 배포 전까지는 PROXY에 `<계정>` 리터럴이 박혀 있어 geocode()가 여기서
  // 실패하는 게 정상이다(개정 (바)). 지오코딩만은 폴백이 없다 — 좌표를 모르면
  // 어느 상권인지 알 수 없고, 모르는 채로 등급을 지어낼 수는 없다. 실패는
  // 위로 던져서 submit 핸들러가 메시지를 보여준다.
  const { lng, lat, gu_code: gu, dong_code: dongCode } = await geocode(address);
  const [boundary, scores, dongData] = await Promise.all([
    loadJson(`data/boundary/${gu}.json`),
    loadJson(`data/score/${gu}.json`),
    loadJson(`data/dong/${gu}.json`),
  ]);

  const matched = boundary ? matchArea({ lng, lat }, boundary) : null;
  const precision = resolvePrecision({ area: matched, dongData, dongCode });

  // M7: floor는 <select>가 5개 값으로 제한하지만, 방어적으로 라벨이 없는
  // 값이 들어와도 "undefined"라는 글자를 화면에 그대로 찍지 않는다 — 원래
  // 받은 코드 자체를 보여주는 편이 정직하다.
  const base = {
    precision, industryName: industry.name, floorLabel: FLOOR_LABELS[floor] ?? floor,
    verdict: null, narration: null, alternatives: [],
  };

  // F5: 🟡 행정동 단위는 🔴 분석 불가로 이어지지 않는다. resolvePrecision이
  // "dong"을 돌려줬다는 건 상권 폴리곤 밖이지만 그 행정동의 원자료(dong/*.json)는
  // 있다는 뜻이다 — 등급을 지어낼 수는 없지만, 있는 원자료(월 매출 총액)는
  // 보여줄 수 있다. dong 데이터에는 상권명/행정동명이 없어(구조 확인함) 이름을
  // 지어내는 대신 구 이름 + 행정동코드를 그대로 보여준다.
  if (precision.level === "dong") {
    const guName = meta.gu?.[gu] ?? gu;
    const dongEntry = dongData?.dongs?.[dongCode];
    const salesTotal = dongEntry?.industries?.[industry.code]?.sales_total ?? null;
    return {
      ...base,
      areaName: `${guName} 일대`,
      dongInfo: { guName, dongCode, salesTotal },
    };
  }

  if (precision.level !== "area") {
    // resolvePrecision이 직접 돌려주는 "none"은 폴리곤도 행정동 데이터도
    // 둘 다 없는 경우뿐이다 — "제공 데이터 범위 밖"이라는 설명이 정확하다.
    return { ...base, areaName: "해당 지역", precision: { ...precision, reason: "out_of_bounds" } };
  }

  const area = scores.areas[matched.code];
  const entry = area?.industries?.[industry.code];
  if (!entry || entry.base == null) {
    // F6: 상권은 찾았는데(matched 존재) 이 업종의 경쟁축 데이터가 없는
    // 경우다(base===null, 실데이터 365/21,188행). "제공 데이터 범위 밖"이
    // 아니라 "이 상권은 맞는데 이 업종 데이터가 없다"는 다른 사실이다.
    return {
      ...base,
      areaName: area?.name ?? matched.name,
      areaType: area?.area_type ?? null,
      precision: { level: "none", badge: "🔴", label: "분석 불가", reason: "no_data" },
    };
  }

  // 개정 (라): judge()는 entry.base===null이거나 group/floor가 floorTable에
  // 없으면 던진다. 위에서 entry.base는 미리 걸렀지만, group/floor 매핑 결함은
  // 여기서만 잡을 수 있다.
  let verdict;
  try {
    verdict = judge({
      entry, cuts: meta.grade_cuts[industry.code], group: assets.groups[industry.code],
      floor, floorTable: assets.floorTable, warnBelow: assets.warnBelow,
    });
  } catch (err) {
    console.error("judge() 실패 — 분석 불가로 표시:", err.message);
    // F6: 이건 사용자 입력 문제도 데이터 결측도 아니라 배포 설정 오류다 —
    // "제공 데이터 범위 밖"이라고 하면 사용자가 잘못된 결론(이 지역엔 아예
    // 데이터가 없다)을 내린다. 원인을 구분해서 넘긴다.
    return {
      ...base,
      areaName: area.name,
      areaType: area.area_type,
      precision: { level: "none", badge: "🔴", label: "분석 불가", reason: "config_error" },
    };
  }

  // C1: floorBasis(narrate.js)가 "층수가 실제로 등급에 영향을 줬는가"를
  // entry.base(층수 적용 전)와 verdict.score(적용 후)를 비교해 판단하므로
  // baseScore를 함께 넘긴다 — 이게 없으면 narrate.js는 참/거짓 어느 쪽도
  // 판단할 근거가 없다.
  const narrationInput = {
    ...verdict, industryName: industry.name, areaName: area.name, floor, baseScore: entry.base,
  };
  const narration = templateNarration(narrationInput);

  // 개정 (다): 배열이 아니라 {recommendations, skipped}다. skipped는
  // 조용히 버리지 않는다 — console.warn으로 남긴다.
  const { recommendations, skipped } = recommend({
    area, meta, assets, floor, askedCode: industry.code,
  });
  if (skipped.length) {
    console.warn(`대안 후보 ${skipped.length}건이 판정 실패로 제외됨:`, skipped);
  }

  // F7: recommendations가 0건일 때, "다른 업종 자체가 이 상권에 없다"와
  // "있었는데 판정 실패로 다 빠졌다"와 "있었는데 이 자리엔 안 맞았다"는
  // 서로 다른 사실이다. render.js가 이 셋을 구분해 보여줄 수 있도록
  // 개수를 실어 보낸다 — console.warn만으로는 화면에 흔적이 안 남는다.
  const otherCount = Object.keys(area.industries ?? {}).filter((c) => c !== industry.code).length;

  return {
    ...base, areaName: area.name, areaType: area.area_type,
    verdict, narration, alternatives: recommendations,
    alternativesContext: { otherCount, skippedCount: skipped.length },
  };
}

const form = document.getElementById("query");
const root = document.getElementById("result");

// submit 리스너는 부트스트랩 성패와 무관하게 항상 등록한다(F4) — 이게
// 등록되지 않으면 버튼 클릭이 네이티브 폼 제출(페이지 새로고침, 입력값
// 소실)로 새어나간다. analyze()가 meta 없음을 자체적으로 던지므로 이
// 핸들러의 catch가 그대로 처리한다.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = new FormData(event.target);
    const payload = await analyze({
      address: data.get("address"),
      industryText: data.get("industry"),
      floor: data.get("floor"),
    });
    renderResult(root, payload);
  } catch (error) {
    root.hidden = false;
    root.replaceChildren();
    const p = document.createElement("p");
    p.className = "error";
    p.setAttribute("role", "alert");
    p.textContent = error.message;
    root.append(p);
  }
  // F9: 결과가 갱신됐다는 걸 스크린리더 사용자에게도 전달한다 — 포커스가
  // 버튼에 그대로 남아있으면 결과 영역까지 다시 탐색해야 한다. #result는
  // index.html에서 tabindex="-1"로 프로그램적 포커스를 받을 수 있게 했다.
  if (typeof root.focus === "function") root.focus();
});

// 「새로 입력」 (2026-08-09 신동환 요청) — 결과를 본 뒤 다른 물건지·업종을
// 바로 넣을 수 있게 한다. 이전 결과가 화면에 남아 있으면 새 입력과 옛 결과가
// 한 화면에 섞여 어느 쪽인지 헷갈린다.
//
// 페이지를 새로고침(location.reload)하지 않는 이유: meta.json과 구별 데이터
// 파일을 전부 다시 받아 느리고, 오프라인/네트워크 불안정에서 멀쩡히 떠 있던
// 화면이 죽을 수 있다. 화면 상태만 되돌린다.
//
// 버튼이 없는 마크업(구버전 캐시 등)에서도 부트스트랩이 죽으면 안 되므로
// 전부 옵셔널로 다룬다 — getElementById는 없는 id에 null을 돌려준다.
const resetButton = document.getElementById("reset");
const addressInput = document.getElementById("address");

resetButton?.addEventListener("click", () => {
  root.hidden = true;
  root.replaceChildren();
  if (typeof form.reset === "function") form.reset();
  if (typeof addressInput?.focus === "function") addressInput.focus();
  // 결과를 보느라 아래로 내려와 있으니 입력 칸이 보이는 위치로 되돌린다.
  if (typeof globalThis.scrollTo === "function") globalThis.scrollTo({ top: 0, behavior: "smooth" });
});
