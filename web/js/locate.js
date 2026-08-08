// 좌표 → 상권 매칭과 분석 정밀도 판정. 스펙 10.3.
//
// 상권 밖 주소에 인근 상권 데이터를 조용히 갖다 쓰는 것은 거짓말이다.
// "모른다"고 말할 수 있어야 신뢰를 얻는다 — 이 파일이 그 원칙을 집행한다.

const EARTH_RADIUS_M = 6371000;

export function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Ray casting. 경계선 위의 점은 내부로 친다.
//
// 먼저 점이 링의 꼭짓점과 정확히 겹치는지 확인한다. 표준 ray-casting은 점이
// 정확히 꼭짓점 위에 있을 때(인접한 두 변의 교차 판정이 동시에 걸리며) 판정이
// 꼬일 수 있다 — 실 데이터에서 인접한 두 상권이 경계 꼭짓점을 공유하는 경우
// 한쪽은 내부, 다른 쪽은 외부로 판정되는 비대칭이 실제로 관측됐다. 꼭짓점은
// 명백히 "경계 위"이므로 별도로 먼저 처리해 이 비대칭을 없앤다.
export function pointInPolygon([lng, lat], ring) {
  for (const [vx, vy] of ring) {
    if (vx === lng && vy === lat) return true;
  }

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function inBbox([lng, lat], [minLng, minLat, maxLng, maxLat]) {
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}

// Shoelace 공식으로 단일 링(외곽선)의 부호 있는 면적과 중심을 구한다.
// 뒤집힌(반시계/시계) 링 모두에서 동작하도록 면적은 부호 있는 값을 반환한다.
function ringCentroid(ring) {
  let signedArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  signedArea /= 2;
  if (signedArea === 0) {
    // 퇴화한 링(면적 0 — 중복 정점 등). 정점 평균으로 대체한다.
    const n = ring.length - 1 || 1;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return { area: 0, center: [sx / n, sy / n] };
  }
  return {
    area: Math.abs(signedArea),
    center: [cx / (6 * signedArea), cy / (6 * signedArea)],
  };
}

// 상권 하나의 "중심"을 구한다. 여러 파트(비연결 폴리곤)로 이뤄진 경우
// 각 파트 외곽링의 centroid를 그 파트의 면적으로 가중 평균한다. 구멍은
// (포함 판정에는 쓰이지만) 중심 계산에서는 무시한다 — 근사치로 충분하고,
// 큰 폴리곤에 뚫린 작은 구멍이 중심을 크게 흔들지 않는다.
//
// 첫 꼭짓점을 "중심"으로 쓰던 이전 구현은 폴리곤이 길쭉하거나 여러 파트로
// 나뉜 경우 실제 중심에서 수백 미터씩 벗어났다 — 상권이 서로 겹치는 실
// 데이터(광역 상권이 좁은 상권을 품는 경우 등)에서 잘못된 상권을 골랐다.
function areaCentroid(rings) {
  let totalArea = 0;
  let cx = 0;
  let cy = 0;
  for (const [outer] of rings) {
    const { area, center } = ringCentroid(outer);
    totalArea += area;
    cx += center[0] * area;
    cy += center[1] * area;
  }
  if (totalArea === 0) {
    // 모든 파트가 퇴화한 경우 — 파트 centroid를 단순 평균한다.
    const n = rings.length || 1;
    let sx = 0;
    let sy = 0;
    for (const [outer] of rings) {
      const { center } = ringCentroid(outer);
      sx += center[0];
      sy += center[1];
    }
    return [sx / n, sy / n];
  }
  return [cx / totalArea, cy / totalArea];
}

// 폴리곤 전용. Task 3이 분기 A(폴리곤)로 확정됐고 원 근사 경로에는 실제로
// 흐르는 데이터가 없다 — 그 경로는 구현하지 않는다. mode가 "polygon"이
// 아니면 조용히 빈 결과를 내는 대신 즉시 던져서, 포맷이 바뀌면 여기서 터지게 한다.
//
// 여러 상권에 걸치면 (면적가중 centroid 기준으로) 더 가까운 쪽을 택한다.
export function matchArea({ lng, lat }, boundary) {
  if (!boundary || !Array.isArray(boundary.areas)) return null;
  if (boundary.mode !== "polygon") {
    throw new Error(
      `matchArea: 지원하지 않는 boundary.mode "${boundary.mode}" — "polygon"만 구현되어 있다`
    );
  }

  const point = [lng, lat];
  let best = null;
  let bestDistance = Infinity;

  for (const area of boundary.areas) {
    if (area.bbox && !inBbox(point, area.bbox)) continue;

    // rings: 상권 하나가 여러 폴리곤(part)으로 구성될 수 있다.
    // part[0]=외곽링, part[1:]=구멍. 외곽 안에 있어도 구멍 안이면 밖이다.
    const hit = area.rings.some(
      ([outer, ...holes]) =>
        pointInPolygon(point, outer) && !holes.some((h) => pointInPolygon(point, h))
    );
    if (!hit) continue;

    const center = areaCentroid(area.rings);
    const d = distanceMeters(point, center);
    if (d < bestDistance) {
      bestDistance = d;
      best = { code: area.code, name: area.name };
    }
  }
  return best;
}

const PRECISION = {
  area: { badge: "🟢", label: "상권 단위 분석" },
  dong: { badge: "🟡", label: "행정동 단위 분석" },
  none: { badge: "🔴", label: "분석 불가" },
};

// 정밀도 3단계 판정. area가 있으면(폴리곤 매치) 상권 단위, 없으면 행정동
// 데이터가 실제로 존재하는지 확인한 뒤에만 행정동 단위, 그마저 없으면
// 분석 불가. 상권 밖 좌표에 가까운 상권을 임의로 대입하지 않는다.
export function resolvePrecision({ area, dongData, dongCode }) {
  if (area) return { level: "area", ...PRECISION.area };
  if (dongCode && dongData?.dongs?.[dongCode]) {
    return { level: "dong", ...PRECISION.dong, note: "해상도가 낮습니다" };
  }
  return { level: "none", ...PRECISION.none };
}
