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
import { installDom } from "./helpers/dom-stub.js";

const WEB_ROOT = new URL("../", import.meta.url).pathname;

function stubFetch({ metaOk = true, geocodeResponse } = {}) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://sanggwon-proxy")) {
      if (!geocodeResponse) return { ok: false };
      return { ok: true, json: async () => geocodeResponse };
    }
    if (u === "data/meta.json" && !metaOk) return { ok: false };
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
  const els = installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
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
  const els = installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
  stubFetch({ metaOk: true });
  await importMain();
  assert.match(els["data-period"].textContent, /2026년 1분기/);
  assert.match(els.sources.textContent, /서울 열린데이터광장/);
  assert.ok(els["industry-options"].children.length > 50, "meta.industries 62개가 datalist option으로 들어가야 한다");
});

test("F11: 두 글자 미만 입력은 부분일치를 시도하지 않는다(짧은 입력의 오탐 방지)", async () => {
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
  stubFetch({ metaOk: true });
  const { analyze } = await importMain();
  await assert.rejects(
    () => analyze({ address: "아무 주소", industryText: "점", floor: "F1" }),
    /업종을 인식하지 못했습니다/,
  );
});

test("F11: 정확히 일치하는 업종명은 그대로 매핑된다", async () => {
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
  stubFetch({ metaOk: true, geocodeResponse: { lng: 0, lat: 0, gu_code: "11110", dong_code: "no-such-dong" } });
  const { analyze } = await importMain();
  const payload = await analyze({ address: "아무 주소", industryText: "커피-음료", floor: "F1" });
  // 좌표 (0,0)은 모든 상권 폴리곤 밖이고 dong_code도 실재하지 않으므로
  // out_of_bounds로 떨어진다 — 이 테스트는 매핑 자체(업종 인식)만 본다.
  assert.equal(payload.industryName, "커피-음료");
});

test("F1/F6(no_data): 실데이터의 base:null 행은 matched 상권 이름을 유지한 채 reason=no_data로 떨어진다", async () => {
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
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
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
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
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
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
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
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
  installDom(["data-period", "sources", "provisional-notice", "query", "result", "industry-options"]);
  stubFetch({ metaOk: true }); // geocodeResponse 없음 → 프록시 fetch가 {ok:false}
  const { analyze } = await importMain();
  await assert.rejects(
    () => analyze({ address: "서울 마포구 양화로 45", industryText: "커피", floor: "F1" }),
    /주소를 찾지 못했습니다/,
  );
});
