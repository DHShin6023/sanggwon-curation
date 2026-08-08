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
export function pointInPolygon([lng, lat], ring) {
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

// 폴리곤 전용. Task 3이 분기 A(폴리곤)로 확정됐고 원 근사 경로에는 실제로
// 흐르는 데이터가 없다 — 그 경로는 구현하지 않는다. mode가 "polygon"이
// 아니면 조용히 빈 결과를 내는 대신 즉시 던져서, 포맷이 바뀌면 여기서 터지게 한다.
//
// 여러 상권에 걸치면 (외곽 링의 첫 꼭짓점을 기준으로) 더 가까운 쪽을 택한다.
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

    const center = area.rings[0][0][0];
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
