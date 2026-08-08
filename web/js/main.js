// 화면 진입점. 스펙 10.2 "AI가 완전히 죽어도 판정은 정상 출력된다"를 구조로
// 강제한다 — 이 파일에는 AI 호출이 없다. Task 12는 문장 품질만 더한다.
//
// ⚠️ 2026-08-08 개정 블록 반영:
//  (가) 자산은 web/data/meta.json 하나에서만 온다 (data/domain/*은 브라우저가
//      도달 못 한다).
//  (나) 창업 필터(필터 ①)는 폐기됐다 — startupFilter 자산 없음, 화면에 자격
//      관련 태그/경고/각주를 붙이지 않는다.
//  (다) recommend()는 {recommendations, skipped}를 반환한다. skipped는 조용히
//      버리지 않고 console.warn으로 남긴다.
//  (라) judge()는 entry.base===null이거나 group/floor가 floorTable에 없으면
//      던진다 — analyze()가 잡아서 🔴 "분석 불가"로 떨어뜨린다.

import { matchArea, resolvePrecision } from "./locate.js";
import { judge, FLOOR_LABELS } from "./verdict.js";
import { recommend } from "./alternatives.js";
import { templateNarration } from "./narrate.js";
import { renderResult } from "./render.js";

const PROXY = "https://sanggwon-proxy.<계정>.workers.dev";  // Task 12에서 실제 주소로 교체

const NONE_PRECISION = { level: "none", badge: "🔴", label: "분석 불가" };

const cache = new Map();
const loadJson = async (path) => {
  if (!cache.has(path)) cache.set(path, fetch(path).then((r) => (r.ok ? r.json() : null)));
  return cache.get(path);
};

const meta = await loadJson("data/meta.json");
document.getElementById("data-period").textContent = `데이터 기준: ${meta.period_label}`;
document.getElementById("sources").textContent = `출처: ${meta.sources.join(" / ")}`;

// 개정 (가): 실제 assets 구성. data/domain/*.json fetch는 브라우저에서
// 도달 불가(web/이 서비스 루트)이므로 쓰지 않는다. startupFilter 없음 —
// 개정 (나): 창업 필터(필터 ①)는 폐기됐다.
const assets = {
  groups: Object.fromEntries(meta.industries.map((i) => [i.code, i.group])),
  floorTable: meta.floor_config.coefficients,
  warnBelow: meta.floor_config.warn_below,
  minCoefficient: meta.floor_config.min_coefficient,
};

// 업종 매핑: Task 12까지는 이름 부분일치 폴백만 쓴다 (스펙 10.2 입구 폴백).
function mapIndustry(text) {
  const q = text.trim();
  return meta.industries.find((i) => i.name.includes(q) || q.includes(i.name)) ?? null;
}

async function geocode(address) {
  const res = await fetch(`${PROXY}/geocode?q=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error("주소를 찾지 못했습니다. 도로명 또는 지번으로 다시 입력해 주세요.");
  return res.json();   // { lng, lat, gu_code, dong_code }
}

export async function analyze({ address, industryText, floor }) {
  const industry = mapIndustry(industryText);
  if (!industry) throw new Error("업종을 인식하지 못했습니다. 목록에서 선택해 주세요.");

  // Task 12 이전이므로 프록시가 없다 — geocode()는 여기서 실패하는 게
  // 정상이다(스펙 10.2). 실패는 위로 던져서 submit 핸들러가 메시지를 보여준다.
  const { lng, lat, gu_code: gu, dong_code: dongCode } = await geocode(address);
  const [boundary, scores, dongData] = await Promise.all([
    loadJson(`data/boundary/${gu}.json`),
    loadJson(`data/score/${gu}.json`),
    loadJson(`data/dong/${gu}.json`),
  ]);

  const matched = boundary ? matchArea({ lng, lat }, boundary) : null;
  const precision = resolvePrecision({ area: matched, dongData, dongCode });
  const base = {
    precision, industryName: industry.name, floorLabel: FLOOR_LABELS[floor],
    areaName: matched?.name ?? "해당 지역", verdict: null, narration: null, alternatives: [],
  };
  if (precision.level !== "area") return base;

  const area = scores.areas[matched.code];
  const entry = area?.industries?.[industry.code];
  if (!entry || entry.base == null) {
    return { ...base, precision: NONE_PRECISION };
  }

  // 개정 (라): judge()는 entry.base===null이거나 group/floor가 floorTable에
  // 없으면 던진다. 위에서 entry.base는 미리 걸렀지만, group/floor 매핑 결함은
  // 여기서만 잡을 수 있다 — 잡지 않으면 페이지가 죽고, 삼키면 없는 등급을
  // 지어내는 셈이 된다.
  let verdict;
  try {
    verdict = judge({
      entry, cuts: meta.grade_cuts[industry.code], group: assets.groups[industry.code],
      floor, floorTable: assets.floorTable, warnBelow: assets.warnBelow,
    });
  } catch (err) {
    console.error("judge() 실패 — 분석 불가로 표시:", err.message);
    return { ...base, precision: NONE_PRECISION };
  }

  const narration = templateNarration({
    ...verdict, industryName: industry.name, areaName: area.name, floor,
  });

  // 개정 (다): 배열이 아니라 {recommendations, skipped}다. skipped는
  // 조용히 버리지 않는다 — console.warn으로 남긴다(브리핑이 사전 승인한
  // 최소 처리).
  const { recommendations, skipped } = recommend({
    area, meta, assets, floor, askedCode: industry.code,
  });
  if (skipped.length) {
    console.warn(`대안 후보 ${skipped.length}건이 판정 실패로 제외됨:`, skipped);
  }

  return { ...base, areaName: area.name, verdict, narration, alternatives: recommendations };
}

document.getElementById("query").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const root = document.getElementById("result");
  try {
    renderResult(root, await analyze({
      address: form.get("address"),
      industryText: form.get("industry"),
      floor: form.get("floor"),
    }));
  } catch (error) {
    root.hidden = false;
    root.replaceChildren();
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = error.message;
    root.append(p);
  }
});
