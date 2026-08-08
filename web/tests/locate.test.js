import test from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon, distanceMeters, matchArea, resolvePrecision } from "../js/locate.js";

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

test("matchArea: 겹칠 때 더 가까운 중심을 고른다", () => {
  const near = [[126.90, 37.50], [127.10, 37.50], [127.10, 37.70], [126.90, 37.70], [126.90, 37.50]];
  const far  = [[126.70, 37.40], [127.30, 37.40], [127.30, 37.75], [126.70, 37.75], [126.70, 37.40]];
  const boundary = { mode: "polygon", areas: [
    { code: "FAR",   name: "넓은상권", bbox: [126.70, 37.40, 127.30, 37.75], rings: [[far]] },
    { code: "CLOSE", name: "좁은상권", bbox: [126.90, 37.50, 127.10, 37.70], rings: [[near]] },
  ]};
  assert.equal(matchArea({ lng: 126.95, lat: 37.55 }, boundary).code, "CLOSE");
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
