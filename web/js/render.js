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

// F1/F8이 "상"·"중상"만 실제로 대안으로 내놓을 만한 등급이라고 취급한다.
// verdict.js의 GRADE_MEANING이 "중하"를 「약점이 뚜렷한 자리」, "하"를
// 「이 업종과는 잘 맞지 않는 자리」라고 말하는데, 그런 등급을 "더 맞는 업종"
// 이라고 부르면 화면 두 곳이 서로 모순된다(I2).
const GOOD_GRADES = new Set(["상", "중상"]);

// F7/M1 — 대안 0건. 원안(라운드 1)은 세 갈래였는데, 리뷰가 지적한 대로
// recommend()의 실제 알고리즘에서 그중 하나는 애초에 일어날 수 없다:
// judge()가 성공한 후보는 반드시 scored에 들어가고 slice(0, limit)이 그걸
// 그대로 돌려주므로, "판정엔 성공했는데 top-2에 못 들어 0건"이라는 상태는
// 존재하지 않는다(scored가 비면 항상 추천도 0건, scored가 안 비면 추천도
// 있다). 그 갈래(원안의 "확인했지만 더 나은 대안은 없었다")를 없애고,
// 알고리즘이 실제로 만들 수 있는 두 갈래만 남긴다:
//  - skippedCount >= otherCount: 전부 판정 실패(설정 결측 등)로 제외됨.
//  - skippedCount < otherCount: 나머지는 판정엔 성공했지만 alternatives.js의
//    filterByFloor가 이 층 적합도 기준(minCoefficient) 미달로 조용히
//    뺐다는 뜻이다 — "안 맞았다"가 아니라 "이 층 기준 미달"이 정확하다.
//    현재 배포된 층수 계수가 전부 1.0이라(잠정값) 이 갈래는 실데이터로는
//    아직 안 밟히지만, 알고리즘상 가능한 상태라 문구를 남겨둔다.
function emptyAlternativesNote(ctx) {
  if (!ctx || ctx.otherCount === 0) {
    return "이 상권에는 비교할 다른 업종 데이터가 없습니다.";
  }
  if (ctx.skippedCount >= ctx.otherCount) {
    return `이 상권의 다른 업종 ${ctx.otherCount}개는 모두 데이터 부족·설정 결측으로 판정하지 못해 ` +
      "대안을 추천할 수 없습니다.";
  }
  const remainder = ctx.otherCount - ctx.skippedCount;
  return ctx.skippedCount > 0
    ? `이 상권의 다른 업종 ${ctx.otherCount}개 중 ${ctx.skippedCount}개는 판정 실패로 제외됐고, ` +
      `나머지 ${remainder}개는 이 층 적합도 기준을 통과하지 못해 대안으로 추천되지 않았습니다.`
    : `이 상권의 다른 업종 ${ctx.otherCount}개는 이 층 적합도 기준을 통과하지 못해 대안으로 추천되지 않았습니다.`;
}

function renderAlternatives(root, payload) {
  const { alternatives, alternativesContext, verdict, industryName } = payload;
  const section = el("section", "alternatives");

  // I2(리뷰 라운드 2): F8은 "asked보다 점수가 높은가"만 봤는데, 그 조건은
  // 후보가 "중하"·"하"여도 만족될 수 있다(실측: 청계산원터골/한식음식점은
  // "하"·score 28.66인데, 대안으로 뜨는 커피-음료·운동/경기용품도 둘 다
  // "하"이면서 점수만 조금 더 높다 — "더 맞는 업종"이라고 부르면 verdict.js
  // 자신의 GRADE_MEANING(「잘 맞지 않는 자리」)과 모순된다). "더 맞는 업종"이라는
  // 헤딩은 상/중상 등급이면서 동시에 asked보다 점수가 높은 후보가 하나라도
  // 있을 때만 쓴다.
  const hasGenuinelyBetter = alternatives.some((a) => GOOD_GRADES.has(a.grade) && a.score > verdict.score);
  section.append(el("h2", null, hasGenuinelyBetter ? "이 자리에 더 맞는 업종" : "이 상권의 다른 업종"));

  if (!alternatives.length) {
    section.append(el("p", "note", emptyAlternativesNote(alternativesContext)));
    root.append(section);
    return;
  }

  // I2: 대안 전부가 중하·하이면(청계산원터골류 — 127개 상권이 "전부 하"다,
  // 흔한 경우다) "다른 업종도 없다"로 뭉개지 않고 그 자체를 정직하게
  // 말한다. asked 자신도 안 좋은 등급이면(GRADE_MEANING이 이미 그렇게
  // 말하고 있으니) 더 강하게, 대안만 안 좋으면 담담하게.
  const allWeak = alternatives.every((a) => !GOOD_GRADES.has(a.grade));
  if (allWeak) {
    const askedAlsoWeak = !GOOD_GRADES.has(verdict.grade);
    section.append(el(
      "p", "note",
      askedAlsoWeak
        ? "물으신 업종뿐 아니라 이 상권의 다른 업종들도 대부분 중하·하 등급입니다 — " +
          "측정 가능한 지표로는 이 자리가 어떤 업종에도 특별히 좋아 보이지 않습니다."
        : "이 상권의 다른 업종들은 물으신 업종보다 등급이 낮습니다(중하·하). 참고용으로만 보십시오.",
    ));
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
    } else if (!GOOD_GRADES.has(alt.grade)) {
      card.append(el(
        "p", "alt-note caution",
        `참고: 이 업종도 등급은 ${alt.grade}입니다 — 이 자리에서 뚜렷하게 나은 선택은 아닙니다.`,
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
// M2(리뷰 라운드 2): reason이 없거나 모르는 값이면 예전엔 out_of_bounds로
// 조용히 떨어졌다 — "이 주소는 범위 밖입니다"라는 구체적인(그리고 틀릴 수
// 있는) 주장을 기본값으로 깔아둔 셈이라 F6이 고치려던 것과 같은 종류의
// 결함이었다. 모르면 모른다고 말한다.
const NONE_REASON_FALLBACK = "이 요청을 분석하지 못한 정확한 이유를 확인할 수 없습니다. " +
  "없는 원인을 지어내지 않기 위해 판정을 만들어내지 않습니다.";

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
      // reason이 없거나 알 수 없는 값이면 NONE_REASON_FALLBACK으로
      // 떨어진다 — out_of_bounds를 기본값으로 가정하지 않는다(M2).
      const text = precision.reason ? NONE_REASON_TEXT[precision.reason] : undefined;
      const message = typeof text === "function" ? text(areaName) : (text ?? NONE_REASON_FALLBACK);
      head.append(el("p", "grade none", "분석 불가"));
      head.append(el("p", "note", message));
    }
    root.append(head);
    return;
  }

  head.append(
    el("p", `grade grade-${verdict.grade}`, `${verdict.grade} · ${verdict.meaning}`),
    // I6(리뷰 라운드 2): "이 상권 {업종} 중 {rank}"는 틀린 문장이었다.
    // etl/engine/scoring.py의 grade_cuts()가 industry_code로만 묶고
    // area_type으로는 안 쪼갠다(docstring: "상권종류로는 더 쪼개지
    // 않는다") — 즉 등급컷·순위는 이 상권 하나가 아니라 서울 전역의
    // 같은 업종을 대상으로 매겨진다.
    el("p", "rank", `${industryName} 기준(서울 전역, 같은 업종) ${verdict.rank}`),
  );

  // F1/I6: area-type 문장은 위 rank 문장과 짝을 이뤄야 모순이 안 생긴다.
  // 왜 "서울 전역 기준 하나"로 매겨도 공정한가 하면 — grade_cuts()가
  // 기준으로 삼는 base_score를 이루는 6개 축 자체가 이미 (업종 ×
  // 상권종류) 풀 안에서의 백분위이기 때문이다(etl/engine/axes.py). 그래서
  // "순위는 전역 기준, 그 순위를 만드는 세부 지표는 같은 상권종류 안에서
  // 비교"라는 두 문장이 동시에 참이다. 절대 매출 규모가 상권종류마다
  // 다르다는 사실은 그대로 남긴다.
  if (areaType) {
    const label = AREA_TYPE_LABEL[areaType] ?? areaType;
    head.append(el(
      "p", "area-type",
      `이 순위의 바탕이 된 유동인구·경쟁 등 세부 지표는 ${label} 안에서만 비교한 값입니다 — ` +
      "그래야 상권 종류가 달라도 하나의 등급 기준으로 공정합니다. " +
      "상권 종류가 다르면 절대 매출 규모는 다릅니다.",
    ));
  }
  root.append(head);

  // Task 12: AI 해설. narrate.js의 validateNarration()을 통과한 문장만 여기
  // 도달한다(통과 못 하면 main.js가 aiText를 안 싣는다). AI가 죽었거나 아직
  // 배포 전이면 aiText 자체가 없고, 그때는 아무것도 그리지 않는다 — "AI
  // 해설 없음" 같은 빈 자리도 남기지 않는다.
  //
  // 고지를 함께 붙이는 이유: 이 페이지의 다른 모든 문장은 룰엔진이 만든
  // 것이고 이 문단만 생성모델이 쓴 것이다. 어느 쪽인지 구분되지 않으면
  // 사용자는 AI 문장까지 계산 결과로 읽는다.
  if (narration.aiText) {
    const box = el("div", "ai-narration");
    box.append(
      el("p", null, narration.aiText),
      // M2: 이전 문구(「등급과 근거 수치는 AI가 아니라 규칙으로 계산된
      // 값입니다」)는 AI 문단 바로 밑에 붙어 있어서 **그 문단 안의 수치를
      // 우리가 보증한다**는 뜻으로 읽혔다. 보증 대상은 이 페이지가 직접
      // 계산해 아래에 표시하는 등급·근거이지 AI가 문장 안에 쓴 수가 아니다.
      // 둘이 어긋나면 어느 쪽이 맞는지도 명시한다.
      el("p", "ai-narration-note",
        // N8: 등급은 이 상자보다 **위**(head)에 그려지므로 「아래 값이 맞다」로
        // 뭉뚱그리면 정작 사용자가 제일 신경 쓰는 값을 안 가리킨다.
        "※ 위 문단은 AI가 쓴 요약입니다. 판정 등급과 근거 항목은 AI와 무관하게 " +
        "규칙으로 계산됩니다. 이 문단이 그 값들과 다르게 말하면 " +
        "규칙으로 계산된 쪽이 맞습니다."),
    );
    root.append(box);
  }

  renderFactors(root, narration.factors);
  renderFloorNotes(root, narration);
  renderPatternNotes(root, narration.patternNotes);
  renderAlternatives(root, payload);
}
