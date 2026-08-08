// payload -> DOM. 순수 렌더링만 한다 — 데이터를 새로 계산하거나 지어내지 않는다.
//
// precision.level이 "area"가 아니면 payload.verdict/narration은 없다(main.js
// 계약). 브리핑 원안 예시는 `precision.level === "none"`만 조기 반환하고 그
// 외(=="dong")에는 그대로 흘려보내 verdict.grade 참조에서 TypeError가
// 났다 — 여기서는 verdict 유무로 분기해 "dong"도 안전하게 그린다.
//
// ⚠️ 리뷰 라운드 1 반영(상세는 task-11-report.md):
//  F1 채점 풀(골목/전통시장/광역)을 화면에 밝힌다 — 등급은 같은 종류 상권
//     안에서만 비교된다(etl/build.py의 area_type 주석과 동일 취지).
//  F5 🟡 행정동 단위는 절대 🔴 분석 불가로 이어지지 않는다.
//  F6 🔴 분석 불가는 원인(범위 밖/업종 데이터 없음/설정 오류)별로 다른
//     문장을 쓴다.
//  F7 대안 0건도 "왜 0건인지"를 말한다 — 섹션 자체를 지우지 않는다.
//  F8 대안 헤딩은 실제로 더 나은지 확인한 뒤에만 "더 맞는 업종"이라고 한다.
//  F9 heading 순서(h1→h2→h3)를 맞추고, 결과 갱신 시 포커스를 옮길 수 있게
//     #result를 항상 포커스 가능한 상태로 채운다(포커스 이동 자체는
//     main.js가 한다).

import { THIN_POOL, money } from "./narrate.js";

const KIND_MARK = { positive: "✓", negative: "✗", caution: "⚠" };

const AREA_TYPE_LABEL = { alley: "골목상권", market: "전통시장", metro: "광역상권" };

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

function renderFactors(root, factors) {
  const list = el("ul", "factors");
  for (const f of factors) {
    list.append(el("li", `factor ${f.kind}`, `${KIND_MARK[f.kind] ?? ""} ${f.text}`));
  }
  root.append(list);
}

function renderFloorNotes(root, narration) {
  // floorBasis: 경고 발동 여부와 무관하게 항상 존재한다(F2) — 층수가
  // 등급 계산에 관여했다는 사실과 그 계산이 휴리스틱이라는 사실은 항상
  // 알려야 한다. floorNote(실제 경고)가 있으면 그 아래 함께 보여준다.
  const box = el("div", `floor-note ${narration.floorNote?.severity ?? "info"}`);
  if (narration.floorNote) {
    box.append(el("h3", null, "층수 경고"), el("p", null, narration.floorNote.text));
  } else {
    box.append(el("h3", null, "층수 보정 안내"));
  }
  box.append(el("p", "basis", narration.floorBasis.text));
  root.append(box);
}

function renderPatternNotes(root, patternNotes) {
  for (const p of patternNotes) {
    // detected: "이 경고가 붙었다" / unknown: "확인할 데이터가 없었다".
    // 서로 다른 진술이라 클래스와 제목을 다르게 붙인다 — 후자를 "경고
    // 없음"으로 뭉개지 않는다(프로젝트 표준 원칙).
    const isUnknown = p.status === "unknown";
    const box = el("div", `pattern-note ${isUnknown ? "unknown" : "detected"}`);
    box.append(
      el("h3", null, isUnknown ? `확인 못한 패턴 · ${p.name}` : `감지된 패턴 · ${p.name}`),
      el("p", null, p.text),
    );
    root.append(box);
  }
}

function altPoolAndPatternNotes(alt) {
  const notes = [];
  if (typeof alt.poolSize === "number" && alt.poolSize < THIN_POOL) {
    notes.push(`표본 ${alt.poolSize}개 기준 — 참고용으로만 보십시오.`);
  }
  if (alt.patternsUnknown?.length) {
    notes.push(`일부 패턴(${alt.patternsUnknown.join(", ")})은 데이터 부족으로 확인하지 못했습니다.`);
  }
  return notes;
}

// F7 — 대안 0건: "다른 업종 자체가 없다" / "있었지만 판정 실패로 다 빠졌다" /
// "확인했지만 이 자리엔 더 나은 게 없었다"는 서로 다른 사실이다. skipped가
// console.warn으로만 남으면 화면엔 흔적이 없다 — 여기서 최소한 개수라도
// 보여준다.
function emptyAlternativesNote(ctx) {
  if (!ctx || ctx.otherCount === 0) {
    return "이 상권에는 비교할 다른 업종 데이터가 없습니다.";
  }
  if (ctx.skippedCount > 0) {
    return `이 상권의 다른 업종 ${ctx.otherCount}개 중 ${ctx.skippedCount}개는 데이터 부족·설정 결측으로 ` +
      "판정하지 못했고, 나머지는 이 자리에 추천할 만큼 적합하지 않았습니다.";
  }
  return `다른 업종 ${ctx.otherCount}개를 확인했지만, 이 자리에 더 나은 대안은 없었습니다.`;
}

function renderAlternatives(root, payload) {
  const { alternatives, alternativesContext, verdict, industryName } = payload;
  const section = el("section", "alternatives");

  // F8: recommend()는 top-2를 점수순으로만 뽑는다 — 물으신 업종보다 점수가
  // 낮아도 후보에 오를 수 있다(중앙고등학교 실사례: 한식 "상" 대비 대안이
  // 중상·중하). 모든 대안이 실제로 더 높은 점수일 때만 "더 맞는 업종"이라고
  // 부른다. 그렇지 않으면 중립적인 제목을 쓰고, 낮은 카드마다 표시한다.
  const allBetter = alternatives.length > 0 && alternatives.every((a) => a.score > verdict.score);
  section.append(el("h2", null, allBetter ? "이 자리에 더 맞는 업종" : "이 상권의 다른 업종"));

  if (!alternatives.length) {
    section.append(el("p", "note", emptyAlternativesNote(alternativesContext)));
    root.append(section);
    return;
  }

  alternatives.forEach((alt, i) => {
    const card = el("div", "alt-card");
    card.append(
      el("h3", null, `${i + 1}안 · ${alt.name} (${alt.grade})`),
      el("p", null, alt.reason),
    );
    if (alt.score <= verdict.score) {
      card.append(el(
        "p", "alt-note caution",
        `참고: 물으신 ${industryName}(${verdict.grade})보다 점수가 낮습니다.`,
      ));
    }
    for (const note of altPoolAndPatternNotes(alt)) {
      card.append(el("p", "alt-note", note));
    }
    if (alt.warning) {
      card.append(el("p", `alt-note ${alt.warning.severity}`, alt.warning.message));
    }
    section.append(card);
  });
  root.append(section);
}

// F6: 🔴 분석 불가의 세 가지 원인.
const NONE_REASON_TEXT = {
  out_of_bounds: "이 주소는 상권 폴리곤과 행정동 데이터 양쪽 다 범위 밖입니다. " +
    "제공 데이터 범위 밖이라 판정을 만들어내지 않습니다.",
  no_data: (areaName) => `${areaName} 상권은 찾았지만, 이 업종의 경쟁점 데이터가 없어 등급을 매길 수 없습니다.`,
  config_error: "설정 오류로 이 업종·층수 조합을 판정할 수 없습니다. 없는 데이터를 지어내지 않기 위해 결과를 보여드리지 않습니다.",
};

export function renderResult(root, payload) {
  root.replaceChildren();
  root.hidden = false;

  const { precision, narration, verdict, alternatives = [], areaName, floorLabel, industryName, areaType, dongInfo } = payload;

  const head = el("div", "verdict-head");
  head.append(
    el("p", "precision", `${precision.badge} ${precision.label}`),
    el("p", "context", `${areaName} · ${floorLabel} · ${industryName}`),
  );
  if (precision.note) head.append(el("p", "precision-note", precision.note));

  // F9: 결과 영역 전체를 아우르는 h2. h1(페이지 제목) 다음 레벨이 곧바로
  // h3(층수/패턴 상자)로 건너뛰던 문제를 없앤다.
  head.append(el("h2", "result-heading", "분석 결과"));

  // verdict가 없다는 것은 precision.level이 "area"가 아니라는 뜻이다
  // (main.js가 area가 아니면 verdict/narration을 만들지 않는다).
  if (!verdict || !narration) {
    if (precision.level === "dong") {
      // F5: 🟡 행정동 단위는 절대 🔴 분석 불가로 이어지지 않는다. 상권
      // 폴리곤 밖이라 등급은 못 매기지만, 행정동 원자료(있으면)는 보여준다.
      head.append(el(
        "p", "note",
        "이 주소는 상권 폴리곤 밖이라 상권 단위 등급을 매길 수 없습니다. " +
        "대신 행정동 전체의 원자료를 참고로 보여드립니다(등급이 아닙니다).",
      ));
      if (dongInfo) {
        const moneyText = money(dongInfo.salesTotal);
        head.append(el(
          "p", "dong-fact",
          moneyText
            ? `${dongInfo.guName} 일대(행정동 ${dongInfo.dongCode})에서 ${industryName} 총매출(월)은 약 ${moneyText}입니다.`
            : `${dongInfo.guName} 일대(행정동 ${dongInfo.dongCode})에는 ${industryName} 매출 데이터가 없습니다.`,
        ));
      }
    } else {
      // precision.level === "none". reason으로 세 원인을 구분한다(F6).
      const reason = precision.reason ?? "out_of_bounds";
      const text = NONE_REASON_TEXT[reason];
      head.append(el("p", "grade none", "분석 불가"));
      head.append(el("p", "note", typeof text === "function" ? text(areaName) : (text ?? NONE_REASON_TEXT.out_of_bounds)));
    }
    root.append(head);
    return;
  }

  head.append(
    el("p", `grade grade-${verdict.grade}`, `${verdict.grade} · ${verdict.meaning}`),
    el("p", "rank", `이 상권 ${industryName} 중 ${verdict.rank}`),
  );

  // F1: 등급은 같은 종류의 상권(골목/전통시장/광역) 안에서만 비교된다 —
  // etl/build.py가 이 사실을 위해 area_type을 실어 보낸다. 화면이 이걸
  // 말하지 않으면 골목상권의 "상"과 광역상권의 "상"을 같은 크기로 오해한다.
  if (areaType) {
    const label = AREA_TYPE_LABEL[areaType] ?? areaType;
    head.append(el(
      "p", "area-type",
      `채점 풀: ${label} — 이 등급은 ${label}끼리 안에서의 순위입니다. ` +
      "상권 종류가 다르면 절대 매출 규모가 다릅니다.",
    ));
  }
  root.append(head);

  renderFactors(root, narration.factors);
  renderFloorNotes(root, narration);
  renderPatternNotes(root, narration.patternNotes);
  renderAlternatives(root, payload);
}
