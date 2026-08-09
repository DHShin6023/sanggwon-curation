// I4(리뷰 라운드 2): dom-stub.js가 모르는 id도 조용히 새 노드를 만들어주던
// 버전에서는, index.html에서 요소 하나를 지워도(예: <datalist
// id="industry-options"> 삭제, <p id="provisional-notice"> 삭제) main.test.js
// 9개가 전부 초록불이었다 — 스텁이 구현과 항상 합의하도록 맞춰져 있어서
// index.html이 실제로 그 id를 제공하는지는 아무도 확인하지 않았기 때문이다.
//
// 이 테스트는 정적 텍스트 검사만 한다(진짜 DOM 파서가 아니다) — main.js
// 소스에서 `document.getElementById("...")` 문자열 리터럴을 전부 뽑고,
// index.html 소스에서 `id="..."`를 전부 뽑아, 전자가 후자의 부분집합인지
// 확인한다. jsdom 없이도 "코드가 참조하는 id가 마크업에 실제로 있다"는
// 최소한의 계약은 지킨다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const mainSrc = fs.readFileSync(fileURLToPath(new URL("js/main.js", root)), "utf8");
const htmlSrc = fs.readFileSync(fileURLToPath(new URL("index.html", root)), "utf8");

function idsReferencedByMain() {
  const ids = new Set();
  const re = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of mainSrc.matchAll(re)) ids.add(m[1]);
  return ids;
}

function idsDefinedInHtml() {
  const ids = new Set();
  const re = /\bid=["']([^"']+)["']/g;
  for (const m of htmlSrc.matchAll(re)) ids.add(m[1]);
  return ids;
}

test("main.js가 getElementById로 찾는 id는 index.html에 최소 1개 이상 있어야 한다", () => {
  const referenced = idsReferencedByMain();
  const defined = idsDefinedInHtml();
  assert.ok(referenced.size > 0, "이 테스트가 실제로 뭔가 검사하고 있는지 확인 — main.js에서 getElementById 호출을 못 찾았다면 정규식이 깨진 것");
  const missing = [...referenced].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `index.html에 없는 id를 main.js가 찾고 있다: ${missing.join(", ")}`);
});

test("index.html에는 datalist#industry-options와 p#provisional-notice가 있다(F11/F2의 실제 앵커)", () => {
  const defined = idsDefinedInHtml();
  assert.ok(defined.has("industry-options"));
  assert.ok(defined.has("provisional-notice"));
});

// ── 타임아웃 예산 계약 ──────────────────────────────────────────────
//
// 워커→OpenRouter 타임아웃이 브라우저→/narrate 타임아웃보다 **작아야** 한다.
// 크면 브라우저가 먼저 포기한 뒤에도 워커가 호출을 끝내서 크레딧은 나가고
// 문장은 아무도 못 받는다 — 캐시에도 안 남으니 같은 질문에 다음에 또 지불한다.
// 실제로 그 상태로 구현돼 있었다(워커 10초 > 브라우저 4초).
//
// 두 값이 서로 다른 파일에 상수로 박혀 있어서, 한쪽만 만져도 아무 테스트도
// 깨지지 않고 조용히 역전된다. 위 id 계약과 같은 이유로 소스를 직접 읽어 잡는다.
const narrateSrc = fs.readFileSync(fileURLToPath(new URL("js/narrate.js", root)), "utf8");
const workerSrc = fs.readFileSync(
  fileURLToPath(new URL("../worker/src/index.js", root)), "utf8");

function num(src, re, label) {
  const m = src.match(re);
  assert.ok(m, `${label}을(를) 소스에서 못 찾았다 — 상수 이름이 바뀌었으면 이 정규식도 고칠 것`);
  return Number(m[1]);
}

// N1: 이 계약이 처음엔 /narrate 쌍만 고정해서, **/map-industry 쌍이 3000 대
// 3000으로 사실상 역전된 채 통과했다.** OpenRouter를 부르는 브라우저 진입점은
// 둘이므로 둘 다 건다.
const modelTimeout = () => num(workerSrc, /MODEL_TIMEOUT_MS\s*=\s*(\d+)/, "worker의 MODEL_TIMEOUT_MS");

test("워커→OpenRouter 타임아웃은 브라우저→/narrate 타임아웃보다 짧아야 한다", () => {
  const browser = num(narrateSrc, /timeoutMs\s*=\s*(\d+)/, "narrate.js의 timeoutMs 기본값");
  const worker = modelTimeout();
  assert.ok(worker < browser,
    `워커(${worker}ms)가 브라우저(${browser}ms)보다 오래 기다리면 받지도 못할 응답에 크레딧을 쓴다`);
});

test("워커→OpenRouter 타임아웃은 브라우저→/map-industry 타임아웃보다도 짧아야 한다", () => {
  const mainSrcLocal = fs.readFileSync(fileURLToPath(new URL("js/main.js", root)), "utf8");
  const browser = num(mainSrcLocal, /MAP_INDUSTRY_TIMEOUT_MS\s*=\s*(\d+)/, "main.js의 MAP_INDUSTRY_TIMEOUT_MS");
  const worker = modelTimeout();
  assert.ok(worker < browser,
    `/map-industry도 OpenRouter를 부른다 — 워커(${worker}ms) >= 브라우저(${browser}ms)면 `
    + "크레딧은 나가고 결과는 버려진다. 이쪽은 캐시조차 없어 매번 반복된다");
});
