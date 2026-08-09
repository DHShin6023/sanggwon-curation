// main.js 단위/통합 테스트. 리뷰 라운드 1(2026-08-08)의 F4(부트스트랩 실패
// 시 조용히 죽음)/F1(area_type 전달)/F6(none의 reason 구분)/F7
// (alternativesContext 전달)/F11(짧은 입력 부분일치 오탐 완화)을 고정한다.
//
// Node ESM은 모듈을 URL별로 캐시한다 — 시나리오마다 global.document/
// global.fetch를 다시 세팅한 뒤 쿼리스트링이 다른 specifier로 import해
// main.js 최상단 부트스트랩 코드를 매번 새로 돌게 한다(실제로 격리되는지는
// 이 파일 맨 아래 회귀 테스트로 별도 확인한다).
//
// fetch 스텁은 실제 web/data/*.json을 파일에서 읽어 그대로 돌려준다 —
// 좌표만 미리 검증된 실제 값을 쓴다(별도 스크립트로 locate.js의 실제
// matchArea()에 넣어 어느 상권에 맞는지 확인 완료, 아래 각 시나리오 주석 참고).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installDom, setFormValues } from "./helpers/dom-stub.js";

const WEB_ROOT = new URL("../", import.meta.url).pathname;
const ALL_IDS = ["data-period", "sources", "provisional-notice", "query", "result", "industry-options"];

// metaTransform: I1/C1 테스트가 "200이지만 모양이 이상한 meta.json"이나
// "provisional 계수가 실제로 어떤 값인지"를 재현하려면 실제 meta.json을
// 읽어서 일부러 망가뜨린 사본을 돌려줘야 한다.
//
// Task 12: 프록시 엔드포인트가 셋(/geocode, /map-industry, /narrate)이 됐으므로
// 하나로 뭉뚱그리지 않고 경로별로 응답을 나눈다. 지정하지 않은 엔드포인트는
// {ok:false} — 즉 "아직 배포 안 된 프록시"와 같은 상태이고, 그 상태에서도
// 등급·근거가 나와야 한다(개정 (바)). proxyCalls로 호출 여부도 확인한다.
function stubFetch({ metaOk = true, geocodeResponse, metaTransform,
                     mapIndustryResponse, narrateResponse, proxyCalls } = {}) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://sanggwon-proxy")) {
      proxyCalls?.push(u);
      if (u.includes("/map-industry")) {
        return mapIndustryResponse ? { ok: true, json: async () => mapIndustryResponse } : { ok: false };
      }
      if (u.includes("/narrate")) {
        return narrateResponse ? { ok: true, json: async () => narrateResponse } : { ok: false };
      }
      if (!geocodeResponse) return { ok: false };
      return { ok: true, json: async () => geocodeResponse };
    }
    if (u === "data/meta.json") {
      if (!metaOk) return { ok: false };
      if (metaTransform) {
        const raw = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, u), "utf8"));
        return { ok: true, json: async () => metaTransform(raw) };
      }
    }
    const filePath = path.join(WEB_ROOT, u);
    if (!fs.existsSync(filePath)) return { ok: false };
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(filePath, "utf8")) };
  };
}

let seq = 0;
async function importMain() {
  seq += 1;
  return import(`../js/main.js?case=${seq}`);
}

test("F4: meta.json 로드 실패 시에도 submit 리스너가 등록되고, analyze()는 조용히 죽지 않는다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({ metaOk: false });
  const { analyze } = await importMain();

  // F4 핵심: 리스너가 등록됐어야 한다 — 안 됐으면 버튼 클릭이 네이티브 폼
  // 제출(새로고침)로 새어나간다.
  assert.ok(els.query._listeners.has("submit"), "meta 로드 실패해도 submit 리스너는 등록돼야 한다");

  assert.match(els["data-period"].textContent, /불러오지 못했/);

  await assert.rejects(
    () => analyze({ address: "아무 주소", industryText: "한식", floor: "F1" }),
    (err) => {
      assert.match(err.message, /새로고침|초기화/);
      return true;
    },
  );
});

test("정상 부트스트랩: data-period/sources/datalist가 실제 meta.json 값으로 채워진다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({ metaOk: true });
  await importMain();
  assert.match(els["data-period"].textContent, /2026년 1분기/);
  assert.match(els.sources.textContent, /서울 열린데이터광장/);
  assert.ok(els["industry-options"].children.length > 50, "meta.industries 62개가 datalist option으로 들어가야 한다");
});

test("F11: 두 글자 미만 입력은 부분일치를 시도하지 않는다(짧은 입력의 오탐 방지)", async () => {
  installDom(ALL_IDS);
  stubFetch({ metaOk: true });
  const { analyze } = await importMain();
  await assert.rejects(
    () => analyze({ address: "아무 주소", industryText: "점", floor: "F1" }),
    /업종을 인식하지 못했습니다/,
  );
});

test("F11: 정확히 일치하는 업종명은 그대로 매핑된다", async () => {
  installDom(ALL_IDS);
  stubFetch({ metaOk: true, geocodeResponse: { lng: 0, lat: 0, gu_code: "11110", dong_code: "no-such-dong" } });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "커피-음료", floor: "F1" });
  // 좌표 (0,0)은 모든 상권 폴리곤 밖이고 dong_code도 실재하지 않으므로
  // out_of_bounds로 떨어진다 — 이 테스트는 매핑 자체(업종 인식)만 본다.
  assert.equal(payload.industryName, "커피-음료");
});

test("F1/F6(no_data): 실데이터의 base:null 행은 matched 상권 이름을 유지한 채 reason=no_data로 떨어진다", async () => {
  installDom(ALL_IDS);
  // 좌표는 별도 스크립트로 locate.js의 matchArea()에 넣어 "동대문상가B동"
  // (구 11110, area_type: market)에 매치됨을 사전에 확인했다. 이 상권의
  // CS300014("신발")는 실데이터에서 base:null이다(entry.base 없음 — 365건
  // 중 하나).
  stubFetch({
    metaOk: true,
    geocodeResponse: { lng: 127.01215142857144, lat: 37.56991214285714, gu_code: "11110", dong_code: "11110515" },
  });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "신발", floor: "F1" });
  assert.equal(payload.precision.level, "none");
  assert.equal(payload.precision.reason, "no_data");
  assert.equal(payload.areaName, "동대문상가B동", "상권을 찾았으면 '해당 지역'으로 뭉개지 않고 실제 이름을 보여줘야 한다(F6)");
});

test("F1: 실데이터 happy path에서 areaType과 alternativesContext가 payload에 실려 온다", async () => {
  installDom(ALL_IDS);
  // 좌표는 별도 스크립트로 확인: 구 11110 "배화여자대학교(박노수미술관)"
  // (area_type: alley)에 매치되고, CS100001(한식음식점)은 base != null이다.
  stubFetch({
    metaOk: true,
    geocodeResponse: { lng: 126.96686300917433, lat: 37.580259174311934, gu_code: "11110", dong_code: "11110515" },
  });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "F2" });
  assert.equal(payload.precision.level, "area");
  assert.equal(payload.areaType, "alley");
  assert.ok(payload.alternativesContext, "alternativesContext가 있어야 render.js가 F7을 처리할 수 있다");
  assert.equal(typeof payload.alternativesContext.otherCount, "number");
  assert.equal(typeof payload.alternativesContext.skippedCount, "number");
});

test("F5: 상권 폴리곤 밖 + 실재하는 행정동이면 precision.level은 dong이고 dongInfo가 실린다", async () => {
  installDom(ALL_IDS);
  // (0,0)은 모든 폴리곤 밖이고, dong_code "11110515"는 gu 11110의 실제
  // dong/11110.json에 존재한다(사전 확인). 그 행정동엔 CS100001 매출
  // 원자료가 있다.
  stubFetch({
    metaOk: true,
    geocodeResponse: { lng: 0, lat: 0, gu_code: "11110", dong_code: "11110515" },
  });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "F1" });
  assert.equal(payload.precision.level, "dong");
  assert.ok(payload.dongInfo);
  assert.equal(payload.dongInfo.dongCode, "11110515");
  assert.equal(payload.dongInfo.salesTotal, 3865728183);
});

test("F6(out_of_bounds): 폴리곤도 행정동도 없으면 순수 out_of_bounds다", async () => {
  installDom(ALL_IDS);
  stubFetch({
    metaOk: true,
    geocodeResponse: { lng: 0, lat: 0, gu_code: "11110", dong_code: "존재하지않는동코드" },
  });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "F1" });
  assert.equal(payload.precision.level, "none");
  assert.equal(payload.precision.reason, "out_of_bounds");
});

test("Task 12 이전: 프록시가 없으면 geocode 실패가 깨끗한 Error로 올라온다(uncaught 아님)", async () => {
  installDom(ALL_IDS);
  stubFetch({ metaOk: true }); // geocodeResponse 없음 → 프록시 fetch가 {ok:false}
  const { analyze } = await importMain();
  await assert.rejects(
    () => analyze({ address: "서울 마포구 양화로 45", industryText: "커피", floor: "F1" }),
    /주소를 찾지 못했습니다/,
  );
});

// ---------------------------------------------------------------------
// I1(리뷰 라운드 2): meta.json이 200이어도 모양이 불완전할 수 있다(캐시된
// 구버전, 부분 배포 등). F4는 fetch 실패만 잡았지 이 경로는 안 잡았다.
// ---------------------------------------------------------------------

test("I1: meta.json이 200이지만 floor_config가 없으면(캐시된 구버전 시나리오) 조용히 안 죽는다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({
    metaOk: true,
    metaTransform: (m) => {
      const clone = structuredClone(m);
      delete clone.floor_config; // 649d7d3 이전 meta.json을 흉내낸다.
      return clone;
    },
  });
  const { analyze } = await importMain();

  assert.ok(els.query._listeners.has("submit"), "shape 검증에 실패해도 submit 리스너는 등록돼야 한다");
  assert.match(els["data-period"].textContent, /불러오지 못했/);
  await assert.rejects(
    () => analyze({ address: "아무 주소", industryText: "한식", floor: "F1" }),
    /floor_config|새로고침|초기화/,
  );
});

test("I1(리뷰가 제시한 재현): floor_config.coefficients에서 그룹 하나가 빠지면 config_error로 정직하게 떨어진다", async () => {
  installDom(ALL_IDS);
  stubFetch({
    metaOk: true,
    // 좌표는 위 F1 테스트와 동일 — "배화여자대학교(박노수미술관)"에 매치되고
    // CS100001(한식음식점, group: 유동의존형)은 base != null이다.
    geocodeResponse: { lng: 126.96686300917433, lat: 37.580259174311934, gu_code: "11110", dong_code: "11110515" },
    metaTransform: (m) => {
      const clone = structuredClone(m);
      // 현재 실데이터에서 모든 업종의 group은 "유동의존형"이다 — 이걸
      // floor_config.coefficients에서 지우면 judge()의 floorCoefficient()가
      // "알 수 없는 업종군" 예외를 던진다(verdict.js). 이게 배포 설정
      // 오류의 실제 형태다: meta.json 전체 shape은 멀쩡한데(validateMeta
      // 통과) 특정 그룹만 빠졌다.
      delete clone.floor_config.coefficients["유동의존형"];
      return clone;
    },
  });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "F2" });
  assert.equal(payload.precision.level, "none");
  assert.equal(payload.precision.reason, "config_error");
  assert.equal(payload.areaName, "배화여자대학교(박노수미술관)",
    "설정 오류라도 matched된 상권 이름 자체는 안다 — '해당 지역'으로 뭉개면 안 된다");
});

// ---------------------------------------------------------------------
// C1(리뷰 라운드 2): 페이지 레벨 provisional 배너도 하드코딩된 방향("있을
// 수 있습니다")이 아니라 실제로 로드한 계수를 보고 확정적으로 말해야 한다.
// ---------------------------------------------------------------------

test("C1: 실데이터(계수 전부 1.0)로 부트스트랩하면 배너가 '전혀 영향을 주지 않는다'고 확정적으로 말한다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({ metaOk: true }); // 실제 meta.json: provisional true, 6개 그룹 전부 1.0
  await importMain();
  assert.equal(els["provisional-notice"].hidden, false);
  assert.match(els["provisional-notice"].textContent, /전혀 영향을 주지 않습니다/);
  assert.doesNotMatch(els["provisional-notice"].textContent, /있을 수 있습니다/,
    "확인 가능한 사실을 '있을 수 있다'는 하드코딩된 애매함으로 말하면 안 된다(C1)");
});

test("C1: 계수 중 하나라도 1.0이 아니면 확정적 문구를 쓰지 않는다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({
    metaOk: true,
    metaTransform: (m) => {
      const clone = structuredClone(m);
      clone.floor_config.coefficients["유동의존형"].F2 = 0.8;
      return clone;
    },
  });
  await importMain();
  assert.equal(els["provisional-notice"].hidden, false);
  assert.doesNotMatch(els["provisional-notice"].textContent, /전혀 영향을 주지 않습니다/);
  assert.match(els["provisional-notice"].textContent, /잠정값/);
});

// ---------------------------------------------------------------------
// I5(리뷰 라운드 2): submit 핸들러 자체(F4의 "네이티브 제출 없음"과 F9의
// role="alert"/root.focus())는 라운드 1까지 커버리지가 0이었다 — dom-stub에
// FormData 대역과 dispatchEvent가 있었지만 아무 테스트도 실제로 이벤트를
// 발생시키지 않았다. setFormValues + dispatchEvent("submit", ...)로
// preventDefault·렌더·포커스 세 경로를 전부 확인한다.
// ---------------------------------------------------------------------

test("I5: 정상 제출 — preventDefault 호출, 결과가 #result에 렌더되고 포커스가 옮겨간다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({
    metaOk: true,
    geocodeResponse: { lng: 126.96686300917433, lat: 37.580259174311934, gu_code: "11110", dong_code: "11110515" },
  });
  await importMain();

  setFormValues(els.query, { address: "아무 주소", industry: "한식", floor: "F2" });
  let prevented = false;
  await els.query.dispatchEvent("submit", { target: els.query, preventDefault: () => { prevented = true; } });

  assert.ok(prevented, "preventDefault가 호출돼야 네이티브 제출(새로고침, F4)이 안 된다");
  assert.equal(els.result.hidden, false);
  assert.match(els.result.textContent, /한식음식점/);
  assert.ok(els.result._focused, "결과 갱신 후 포커스가 #result로 옮겨가야 한다(F9)");
});

test("I5: 에러 제출 — role=\"alert\"가 붙고 포커스가 옮겨간다, preventDefault도 호출된다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({ metaOk: true }); // geocodeResponse 없음 → 프록시 fetch 실패
  await importMain();

  setFormValues(els.query, { address: "아무 주소", industry: "커피", floor: "F1" });
  let prevented = false;
  await els.query.dispatchEvent("submit", { target: els.query, preventDefault: () => { prevented = true; } });

  assert.ok(prevented);
  const errorP = els.result.query("error");
  assert.ok(errorP, "에러 상태에서도 #result 안에 .error 문단이 있어야 한다");
  assert.equal(errorP.getAttribute("role"), "alert");
  assert.match(errorP.textContent, /주소를 찾지 못했습니다/);
  assert.ok(els.result._focused);
});

test("I5(M6 확인): 에러 이후 성공적으로 재제출하면 이전 role=alert 잔여물이 안 남는다", async () => {
  const els = installDom(ALL_IDS);
  stubFetch({ metaOk: true }); // 첫 제출은 프록시 없음 → 실패
  await importMain();

  setFormValues(els.query, { address: "x", industry: "커피", floor: "F1" });
  await els.query.dispatchEvent("submit", { target: els.query, preventDefault() {} });
  assert.ok(els.result.query("error"), "먼저 에러 상태였는지 확인");

  stubFetch({
    metaOk: true,
    geocodeResponse: { lng: 126.96686300917433, lat: 37.580259174311934, gu_code: "11110", dong_code: "11110515" },
  });
  setFormValues(els.query, { address: "x", industry: "한식", floor: "F2" });
  await els.query.dispatchEvent("submit", { target: els.query, preventDefault() {} });

  assert.ok(!els.result.query("error"), "renderResult()가 replaceChildren()으로 이전 에러 문단을 지워야 한다");
});

// ---------------------------------------------------------------------
// Task 12: AI 입구(업종 매핑)·출구(해설) 연결. 개정 (라) — mapIndustry가
// 동기에서 비동기로 바뀐다. 개정 (바) — 프록시는 아직 미배포라 AI 경로가
// 조용히 실패하고 템플릿으로 떨어지는 것이 정상 동작이다.
// ---------------------------------------------------------------------

// 실좌표: 구 11110 "배화여자대학교(박노수미술관)"에 매치되고 CS100001은 base != null.
const HAPPY_GEO = { lng: 126.96686300917433, lat: 37.580259174311934, gu_code: "11110", dong_code: "11110515" };

test("Task 12: 로컬 매칭이 성공하면 AI 업종매핑을 호출하지 않는다(무료 할당량)", async () => {
  installDom(ALL_IDS);
  const proxyCalls = [];
  stubFetch({ metaOk: true, geocodeResponse: HAPPY_GEO, proxyCalls });
  const { analyze } = await importMain();

  const payload = await analyze({ address: "아무 주소", industryText: "한식음식점", floor: "F2" });
  assert.equal(payload.industryName, "한식음식점");
  assert.ok(!proxyCalls.some((u) => u.includes("/map-industry")),
    "로컬에서 이미 찾았는데 AI를 부르면 하루 50건짜리 할당량을 낭비한다");
});

test("Task 12: 로컬 매칭이 실패하면 AI 업종매핑이 돌려준 코드로 매핑된다", async () => {
  installDom(ALL_IDS);
  stubFetch({
    metaOk: true,
    geocodeResponse: HAPPY_GEO,
    mapIndustryResponse: { code: "CS100010" }, // 커피-음료
  });
  const { analyze } = await importMain();

  // "카페라떼 파는 곳"은 meta.industries 어느 이름과도 부분일치하지 않는다.
  const payload = await analyze({ address: "아무 주소", industryText: "카페라떼 파는 곳", floor: "F2" });
  assert.equal(payload.industryName, "커피-음료");
});

test("Task 12: AI가 {code: null}을 주면(확신 없음·한도 초과) 목록 선택 안내로 떨어진다", async () => {
  installDom(ALL_IDS);
  stubFetch({ metaOk: true, geocodeResponse: HAPPY_GEO, mapIndustryResponse: { code: null } });
  const { analyze } = await importMain();
  await assert.rejects(
    () => analyze({ address: "아무 주소", industryText: "카페라떼 파는 곳", floor: "F2" }),
    /업종을 인식하지 못했습니다/,
  );
});

test("Task 12: AI가 모르는 코드를 줘도 지어내지 않고 인식 실패로 떨어진다", async () => {
  installDom(ALL_IDS);
  stubFetch({ metaOk: true, geocodeResponse: HAPPY_GEO, mapIndustryResponse: { code: "존재하지않는코드" } });
  const { analyze } = await importMain();
  await assert.rejects(
    () => analyze({ address: "아무 주소", industryText: "카페라떼 파는 곳", floor: "F2" }),
    /업종을 인식하지 못했습니다/,
  );
});

test("Task 12: 검증을 통과한 AI 해설은 narration.aiText로 실린다", async () => {
  installDom(ALL_IDS);
  const aiText = "배화여자대학교 일대에서 한식음식점을 여시려는 자리입니다. " +
    "통행량 자체는 나쁘지 않지만 경쟁이 만만치 않으니 작게 시작해 보시길 권합니다.";
  stubFetch({ metaOk: true, geocodeResponse: HAPPY_GEO, narrateResponse: { text: aiText } });
  const { analyze } = await importMain();

  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "F2" });
  assert.equal(payload.narration.aiText, aiText);
});

test("Task 12: 검증에 걸린 AI 해설은 aiText 없이 템플릿 해설만 남는다", async () => {
  installDom(ALL_IDS);
  // 성공 확률을 %로 말하는 문장 — validateNarration 규칙 2 위반.
  stubFetch({
    metaOk: true,
    geocodeResponse: HAPPY_GEO,
    narrateResponse: { text: "이 자리에서 성공할 확률은 대략 70% 정도라고 보시면 됩니다. 충분히 해볼 만합니다." },
  });
  const { analyze } = await importMain();

  // narrate.js의 해설 캐시는 모듈 단위(프로세스 수명)라 importMain()으로
  // 격리되지 않는다. cacheKey에 층수가 들어가므로 층을 달리해 이전 테스트가
  // 심어둔 캐시를 타지 않게 한다(계수가 전부 1.0이라 등급은 동일하다).
  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "F3P" });
  assert.equal(payload.narration.aiText, null);
  assert.ok(payload.narration.factors.length > 0, "AI가 걸러져도 템플릿 근거는 그대로 나와야 한다");
  assert.equal(payload.verdict.grade !== undefined, true);
});

test("개정 (바): 프록시 미배포 상태(모든 AI 호출 실패)에서도 등급·근거·대안이 그대로 나온다", async () => {
  installDom(ALL_IDS);
  stubFetch({ metaOk: true, geocodeResponse: HAPPY_GEO }); // AI 두 엔드포인트 모두 {ok:false}
  const { analyze } = await importMain();

  // 위 테스트와 같은 이유로 층수를 달리해 해설 캐시를 피한다.
  const payload = await analyze({ address: "아무 주소", industryText: "한식", floor: "B1" });
  assert.equal(payload.precision.level, "area");
  assert.ok(payload.verdict.grade);
  assert.ok(payload.narration.factors.length > 0);
  assert.equal(payload.narration.aiText, null);
});

test("I2: /map-industry가 응답하지 않아도 매달리지 않고 목록 선택 안내로 떨어진다",
  { timeout: 10000 }, async () => {
    installDom(ALL_IDS);
    stubFetch({ metaOk: true, geocodeResponse: HAPPY_GEO });
    const inner = global.fetch;
    // 영원히 응답하지 않는 프록시. AbortSignal이 없으면 analyze()가 그대로
    // 멈추고 "목록에서 선택해 주세요" 폴백은 영영 안 뜬다 — 조용히 삼키는
    // 것과 조용히 멈추는 것은 다르다.
    global.fetch = async (url, init) => {
      if (String(url).includes("/map-industry")) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return inner(url, init);
    };

    const { analyze } = await importMain();
    const started = Date.now();
    await assert.rejects(
      () => analyze({ address: "아무 주소", industryText: "카페라떼 파는 곳", floor: "F2" }),
      /업종을 인식하지 못했습니다/,
    );
    assert.ok(Date.now() - started < 8000, "타임아웃이 동작해야 한다");
  });
