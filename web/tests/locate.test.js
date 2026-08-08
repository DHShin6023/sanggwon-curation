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

test("pointInPolygon: 실데이터 — 세 상권이 공유하는 꼭짓점의 경계 판정은 보장되지 않는다(현재 동작 기록)", () => {
  // 종로구 실경계: [126.968482, 37.581383]는 세 상권 폴리곤(3110008 배화여자대학교/
  // 박노수미술관, 3120002 서촌/경복궁역, 3130001 통인시장)이 동시에 공유하는 정확한
  // 꼭짓점이다. shapely로 대조하면 셋 다 covers=true·contains=false — 완전히 경계 위다.
  // locate.js의 pointInPolygon 문서에 적었듯 이런 정확한 경계 케이스는 판정을 보장하지
  // 않는다: 표준 ray-casting이 부동소수점 특성상 세 링 중 어느 것을 "내부"로 셀지
  // 일관되지 않게 판단한다. 이 테스트는 "이게 정답"이라고 주장하는 게 아니라, 현재
  // 동작을 회귀 감지용으로 고정해 두는 characterization test다 — 값이 갑자기 바뀌면
  // (예: 알고리즘을 건드렸는데 의도치 않게 결과가 달라지면) 여기서 걸린다.
  const boundary = readBoundary("11110");
  const areas = Object.fromEntries(boundary.areas.map((a) => [a.code, a]));
  const point = [126.968482, 37.581383];
  assert.equal(pointInPolygon(point, areas["3110008"].rings[0][0]), false);
  assert.equal(pointInPolygon(point, areas["3120002"].rings[0][0]), true);
  assert.equal(pointInPolygon(point, areas["3130001"].rings[0][0]), false);
});

test("matchArea: 실데이터 — 넓은 관광특구가 좁은 상권을 품을 때도 면적 중심이 더 가까운 쪽을 고른다", () => {
  // [127.014788, 37.572226]는 3001494(종로·청계 관광특구)와 3120017(동묘앞역/동묘) 두
  // 상권 폴리곤 "내부"에 완전히 걸친다 — 경계가 아니라 진짜 겹치는 영역이다(shapely
  // contains=true 둘 다). 면적가중 centroid 기준 정답은 3120017(~50m)이고 3001494는
  // 훨씬 멀다(~1.9km). 광역 관광특구가 좁은 상권을 통째로 품는, 이 데이터셋에서
  // 구조적으로 흔한 패턴을 그대로 보여주는 사례라 vertex 케이스와 달리 pointInPolygon의
  // 경계 처리와 무관하게 matchArea의 일반 경로(내부 판정 → centroid tie-break)를
  // 그대로 지나간다. 첫 꼭짓점을 중심 프록시로 쓰던 이전 구현은 3001494를 잘못 골랐다.
  const boundary = readBoundary("11110");
  const m = matchArea({ lng: 127.014788, lat: 37.572226 }, boundary);
  assert.equal(m.code, "3120017");
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
