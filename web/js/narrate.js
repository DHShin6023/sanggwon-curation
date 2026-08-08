// 판정 결과 → 문장. AI 없이도 완결되는 템플릿 경로.
// Task 12에서 AI 해설이 추가되지만 이 함수는 항상 폴백으로 살아 있다.
//
// FLOOR_LABELS, GRADE_MEANING은 verdict.js가 실제로 export한다(2026-08-08 확인).
import { FLOOR_LABELS, GRADE_MEANING } from "./verdict.js";

const PATTERN_TEXT = {
  함정상권: "통행량은 많은데 소비로 이어지지 않는 패턴입니다. " +
            "테이크아웃 위주 저단가 구조라면 해볼 만하고, 좌석 회전을 기대하는 모델이면 말립니다.",
  침몰상권: "매출은 줄고 폐업은 느는데 점포수는 오히려 늘고 있습니다. 가장 나쁜 조합입니다.",
  포화: "점포 밀도가 최상위권입니다. 신규 진입 여지가 거의 없습니다.",
  블루오션: "배후 수요 대비 공급이 부족합니다. 이 상권에서 드문 신호입니다.",
};

const HIGH = 70;
const LOW = 30;

// 표본이 이 미만이면 등급이 잡음일 수 있다는 사실을 화면이 드러내야 한다
// (개정 블록 (라), poolSize는 등급을 매긴 표본 크기).
const THIN_POOL = 30;

function money(won) {
  if (!won) return null;
  const eok = won / 100000000;
  if (eok >= 1) return `${eok.toFixed(1)}억원`;
  return `${Math.round(won / 10000).toLocaleString()}만원`;
}

export function templateNarration(result) {
  const { axes = {}, industryName, areaName, grade } = result;
  const factors = [];

  const push = (kind, text) => text && factors.push({ kind, text });

  if (axes.footfall >= HIGH) push("positive", `유동인구가 상위권입니다 (상위 ${Math.round(100 - axes.footfall)}%)`);
  if (axes.footfall <= LOW) push("negative", "유동인구가 하위권입니다");
  if (axes.resident >= HIGH) push("positive", "배후 거주인구가 두텁습니다");
  if (axes.worker >= HIGH) push("positive", "직장인구가 많은 자리입니다");

  if (axes.competition <= LOW) {
    push("negative",
      `경쟁이 심합니다. ${industryName}이 이미 ${result.storeCount}개이고 ` +
      `점포당 추정매출은 ${money(result.salesPerStore) ?? "하위권"}입니다`);
  } else if (axes.competition >= HIGH) {
    push("positive", `경쟁 대비 점포당 매출이 양호합니다 (${money(result.salesPerStore) ?? "상위권"})`);
  }

  if (axes.vitality <= LOW) push("caution", "최근 매출 추세와 폐업률이 좋지 않습니다");
  if (axes.vitality >= HIGH) push("positive", "매출 추세와 영업 지속성이 안정적입니다");
  if (axes.fit <= LOW) push("caution", "이 상권의 소비 시간대·연령 구성이 해당 업종과 잘 맞지 않습니다");
  if (axes.fit >= HIGH) push("positive", "상권의 소비 성격이 해당 업종과 잘 맞습니다");

  // poolSize: 얇은 표본(< 30)은 등급 자체가 잡음일 수 있다는 사실을 숨기지
  // 않는다 — brief 개정 (라). 표본 크기를 알 수 없을 때(null)는 "얇다"고
  // 단정하지 않는다 — 그것도 없는 확신을 지어내는 것이다.
  if (typeof result.poolSize === "number" && result.poolSize < THIN_POOL) {
    push("caution", `이 등급은 표본 ${result.poolSize}개를 기준으로 계산됐습니다. 표본이 얇아 참고용으로만 보십시오.`);
  }

  const floorNote = result.warning
    ? {
        severity: result.warning.severity,
        text: result.warning.message,
        basisNote:
          "※ 층수 판단은 공개 데이터가 아니라 현장 경험에 근거한 추정입니다. " +
          "공공데이터에는 층별 매출이 존재하지 않습니다.",
      }
    : null;

  // patterns(경고가 붙음)와 patternsUnknown(확인할 데이터가 없었음)은 서로
  // 다른 진술이다 — 후자를 "경고 없음"으로 뭉개지 않는다. 두 종류를 모두
  // patternNotes에 싣되 status로 구분해서, 렌더 쪽이 시각적으로도 구분할
  // 수 있게 한다.
  const patternNotes = [
    ...(result.patterns ?? [])
      .filter((p) => PATTERN_TEXT[p])
      .map((p) => ({ name: p, text: PATTERN_TEXT[p], status: "detected" })),
    ...(result.patternsUnknown ?? [])
      .map((p) => ({
        name: p,
        text: `"${p}" 패턴 여부를 판단할 데이터가 부족해 확인하지 못했습니다. ` +
              "경고가 없다는 뜻이 아니라, 확인이 안 됐다는 뜻입니다.",
        status: "unknown",
      })),
  ];

  return {
    headline: `${areaName} · ${FLOOR_LABELS[result.floor]} · ${industryName} — ${grade}, ${GRADE_MEANING[grade]}`,
    factors,
    floorNote,
    patternNotes,
  };
}
