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

// 2026-08-09: 여기 있던 타임아웃 예산 계약 두 건과 그 헬퍼(num/narrateSrc/
// workerSrc)는 삭제했다. "워커→OpenRouter가 브라우저→워커보다 짧아야 한다"는
// 규칙이었는데, 그건 **유료 호출이 버려지는 걸 막으려던 것**이다. AI 두
// 엔드포인트를 걷어내면서 OpenRouter 호출 자체가 없어져 지킬 대상이 사라졌다.
// 남은 브라우저→워커 호출은 /geocode 하나뿐이고, 카카오는 건당 과금이 아니라
// 무료 할당량이라 같은 규칙이 적용되지 않는다(worker/README.md 참고).

// ── 배포 경로 계약 ──────────────────────────────────────────────────
//
// GitHub Pages는 프로젝트 저장소를 **하위 경로**로 서비스한다:
//   https://dhshin6023.github.io/sanggwon-curation/
// 그래서 자원 경로가 "/data/meta.json"처럼 슬래시로 시작하면 도메인 루트를
// 가리켜 404가 난다. 상대경로("data/meta.json")여야 한다.
//
// 이 결함은 **로컬에서는 절대 안 잡힌다** — 로컬 서버는 web/를 루트로 띄우니
// 절대경로도 잘 동작한다. 배포해야만 드러나고, 그때는 사이트 전체가 죽는다.
// 그래서 소스를 직접 읽어 고정한다.

const jsSources = ["js/main.js", "js/render.js", "js/locate.js", "js/verdict.js",
                   "js/alternatives.js", "js/narrate.js"]
  .map((f) => [f, fs.readFileSync(fileURLToPath(new URL(f, root)), "utf8")]);

test("자원 경로는 상대경로여야 한다 — Pages 하위 경로에서 깨지지 않게", () => {
  const offenders = [];

  for (const [name, src] of jsSources) {
    // fetch("/...") / loadJson("/...") 형태만 본다. 워커 주소(${PROXY}/geocode)는
    // 절대 URL이라 해당 없다.
    for (const m of src.matchAll(/(?:fetch|loadJson)\(\s*["'`]\/[^"'`]*/g)) {
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  for (const m of htmlSrc.matchAll(/\b(?:src|href)=["']\/[^"']*/g)) {
    offenders.push(`index.html: ${m[0]}`);
  }

  assert.deepEqual(offenders, [],
    `슬래시로 시작하는 경로는 Pages 하위 경로에서 404가 난다(로컬에서는 멀쩡하다): ${offenders.join(", ")}`);
});

test("이 계약이 실제로 뭔가 보고 있는지 — 검사 대상 소스가 비어 있지 않다", () => {
  assert.ok(jsSources.every(([, src]) => src.length > 0));
  assert.match(mainSrc, /loadJson\("data\/meta\.json"\)/,
    "meta.json을 상대경로로 읽는 지점이 사라졌다면 이 계약의 정규식도 확인할 것");
});
