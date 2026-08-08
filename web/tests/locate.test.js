import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pointInPolygon, distanceMeters, matchArea, resolvePrecision } from "../js/locate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readBoundary = (gu) =>
  JSON.parse(readFileSync(path.join(__dirname, `../data/boundary/${gu}.json`), "utf8"));

const SQUARE = [[126.9, 37.5], [127.0, 37.5], [127.0, 37.6], [126.9, 37.6], [126.9, 37.5]];

test("pointInPolygon: 내부 판정", () => {
  assert.equal(pointInPolygon([126.95, 37.55], SQUARE), true);
});

test("pointInPolygon: 외부 판정", () => {
  assert.equal(pointInPolygon([127.5, 37.55], SQUARE), false);
});

test("distanceMeters: 서울시청↔광화문은 대략 1km 미만", () => {
  const d = distanceMeters([126.9780, 37.5665], [126.9769, 37.5759]);
  assert.ok(d > 900 && d < 1200, `실제 ${d}m`);
});

test("matchArea: polygon 모드", () => {
  const boundary = { mode: "polygon", areas: [
    { code: "A1", name: "테스트상권", bbox: [126.9, 37.5, 127.0, 37.6], rings: [[SQUARE]] },
  ]};
  assert.equal(matchArea({ lng: 126.95, lat: 37.55 }, boundary).code, "A1");
  assert.equal(matchArea({ lng: 128.0, lat: 37.55 }, boundary), null);
});

test("matchArea: 구멍 안의 점은 상권 밖이다", () => {
  const outer = [[126.90, 37.50], [127.10, 37.50], [127.10, 37.70], [126.90, 37.70], [126.90, 37.50]];
  const hole  = [[126.95, 37.55], [127.05, 37.55], [127.05, 37.65], [126.95, 37.65], [126.95, 37.55]];
  const boundary = { mode: "polygon", areas: [
    { code: "H1", name: "구멍상권", bbox: [126.90, 37.50, 127.10, 37.70], rings: [[outer, hole]] },
  ]};
  assert.equal(matchArea({ lng: 126.92, lat: 37.52 }, boundary).code, "H1");  // 외곽 안, 구멍 밖
  assert.equal(matchArea({ lng: 127.00, lat: 37.60 }, boundary), null);        // 구멍 안
});

test("matchArea: polygon 외 모드는 조용히 넘기지 않고 던진다", () => {
  const boundary = { mode: "circle", areas: [] };
  assert.throws(() => matchArea({ lng: 126.95, lat: 37.55 }, boundary), /polygon/);
});

test("matchArea: 겹칠 때 더 가까운 중심(면적가중 centroid)을 고른다", () => {
  // "중심"은 외곽 링의 첫 꼭짓점이 아니라 면적가중 centroid다. WIDE는 점을
  // 한쪽 귀퉁이에 걸친 넓은 상권이라 centroid가 점에서 멀고(~22km),
  // NARROW는 점을 중심에 품은 작은 상권이라 centroid가 점과 거의 일치한다(~0).
  // (예전에 링의 첫 꼭짓점을 "중심"으로 쓰던 구현에서는 이 두 사각형이
  //  실제 상권 중첩 패턴 — 광역 상권이 좁은 상권을 품는 경우 — 을 제대로
  //  대표하지 못해 우연히 정답이 맞았을 뿐이었다.)
  const wide   = [[126.90, 37.50], [127.50, 37.50], [127.50, 37.60], [126.90, 37.60], [126.90, 37.50]];
  const narrow = [[126.94, 37.54], [126.96, 37.54], [126.96, 37.56], [126.94, 37.56], [126.94, 37.54]];
  const boundary = { mode: "polygon", areas: [
    { code: "WIDE",   name: "넓은상권", bbox: [126.90, 37.50, 127.50, 37.60], rings: [[wide]] },
    { code: "NARROW", name: "좁은상권", bbox: [126.94, 37.54, 126.96, 37.56], rings: [[narrow]] },
  ]};
  assert.equal(matchArea({ lng: 126.95, lat: 37.55 }, boundary).code, "NARROW");
});

test("matchArea: 실데이터 — 세 상권이 만나는 꼭짓점에서 면적 중심이 가장 가까운 쪽을 고른다", () => {
  // 종로구 실경계: [126.968482, 37.581383]는 세 상권 폴리곤이 동시에 공유하는
  // 꼭짓점이다(3110008 배화여자대학교/박노수미술관, 3120002 서촌/경복궁역,
  // 3130001 통인시장 — 74개 상권 전체를 스캔해 확인). 면적가중 centroid 기준
  // 거리는 3130001 ~162m, 3110008 ~171m, 3120002 ~375m로 3130001이 가장 가깝다.
  // (외곽 링의 첫 꼭짓점을 "중심"으로 쓰던 이전 구현은 이 점에서 3120002를 잘못 골랐다.
  //  이 셋 중 두 상권만 비교하면 3110008이 이기지만, 실제로는 세 번째 상권이 더 가깝다 —
  //  그래서 이 테스트는 "두 후보끼리" 비교가 아니라 전체 boundary 파일을 그대로 읽어
  //  matchArea가 스스로 모든 후보를 훑게 한다.)
  const boundary = readBoundary("11110");
  const m = matchArea({ lng: 126.968482, lat: 37.581383 }, boundary);
  assert.equal(m.code, "3130001");
});

test("matchArea: 실데이터 — 북촌(안국역) 구멍 중심은 상권 밖이다", () => {
  // 3120007(북촌/안국역)은 구멍 2개를 가진 실제 폴리곤. 첫 번째 구멍의 면적가중
  // centroid는 구멍 안(=상권 밖)이고, 종로구 74개 상권 중 이 좌표를 덮는 다른
  // 상권도 없어 결과는 null이어야 한다.
  const boundary = readBoundary("11110");
  const m = matchArea({ lng: 126.9855402943207, lat: 37.57966211010833 }, boundary);
  assert.equal(m, null);
});

test("resolvePrecision: 상권 안이면 🟢", () => {
  const r = resolvePrecision({ area: { code: "A1" }, dongData: null, dongCode: null });
  assert.deepEqual([r.level, r.badge], ["area", "🟢"]);
});

test("resolvePrecision: 상권 밖 + 행정동 데이터 있으면 🟡", () => {
  const r = resolvePrecision({
    area: null, dongCode: "11440510",
    dongData: { dongs: { "11440510": { industries: {} } } },
  });
  assert.deepEqual([r.level, r.badge], ["dong", "🟡"]);
});

test("resolvePrecision: 아무 데이터도 없으면 🔴", () => {
  const r = resolvePrecision({ area: null, dongCode: "11440510", dongData: { dongs: {} } });
  assert.deepEqual([r.level, r.badge], ["none", "🔴"]);
});

test("resolvePrecision: 상권 밖일 때 인근 상권으로 몰래 대체하지 않는다", () => {
  const r = resolvePrecision({ area: null, dongCode: null, dongData: null });
  assert.equal(r.level, "none");
});
