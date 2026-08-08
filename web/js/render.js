// payload -> DOM. 순수 렌더링만 한다 — 데이터를 새로 계산하거나 지어내지 않는다.
//
// precision.level이 "area"가 아니면 payload.verdict/narration은 없다(main.js
// 계약). 브리핑 원안 예시는 `precision.level === "none"`만 조기 반환하고 그
// 외(=="dong")에는 그대로 흘려보내 verdict.grade 참조에서 TypeError가
// 났다 — 여기서는 verdict 유무로 분기해 "dong"도 안전하게 그린다.

const KIND_MARK = { positive: "✓", negative: "✗", caution: "⚠" };
const THIN_POOL = 30;

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

function renderFloorNote(root, floorNote) {
  if (!floorNote) return;
  const box = el("div", `floor-note ${floorNote.severity}`);
  box.append(
    el("h3", null, "층수 경고"),
    el("p", null, floorNote.text),
    el("p", "basis", floorNote.basisNote),
  );
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

export function renderResult(root, payload) {
  root.replaceChildren();
  root.hidden = false;

  const { precision, narration, verdict, alternatives = [], areaName, floorLabel, industryName } = payload;

  const head = el("div", "verdict-head");
  head.append(
    el("p", "precision", `${precision.badge} ${precision.label}`),
    el("p", "context", `${areaName} · ${floorLabel} · ${industryName}`),
  );
  if (precision.note) head.append(el("p", "precision-note", precision.note));

  // verdict가 없다는 것은 precision.level이 "area"가 아니라는 뜻이다
  // (main.js가 area가 아니면 verdict/narration을 만들지 않는다). "none"과
  // "dong"을 문자열로 다시 분기하지 않고 데이터 유무로 판단한다 — 계약이
  // 어긋나면(예: 새 레벨 추가) 여기서도 조용히 넘어가지 않는다.
  if (!verdict || !narration) {
    head.append(el("p", "grade none", "분석 불가"));
    head.append(el(
      "p",
      "note",
      precision.level === "dong"
        ? "이 주소는 상권 폴리곤 밖이라 행정동 단위 데이터만 있습니다. " +
          "업종별 등급을 매길 만큼 정밀하지 않아 판정을 만들어내지 않습니다."
        : "이 주소는 제공 데이터 범위 밖입니다. 판정을 만들어내지 않습니다.",
    ));
    root.append(head);
    return;
  }

  head.append(
    el("p", `grade grade-${verdict.grade}`, `${verdict.grade} · ${verdict.meaning}`),
    el("p", "rank", `이 상권 ${industryName} 중 ${verdict.rank}`),
  );
  root.append(head);

  renderFactors(root, narration.factors);
  renderFloorNote(root, narration.floorNote);
  renderPatternNotes(root, narration.patternNotes);

  if (alternatives.length) {
    const section = el("section", "alternatives");
    section.append(el("h2", null, "이 자리에 더 맞는 업종"));
    alternatives.forEach((alt, i) => {
      const card = el("div", "alt-card");
      card.append(
        el("h3", null, `${i + 1}안 · ${alt.name} (${alt.grade})`),
        el("p", null, alt.reason),
      );
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
}
