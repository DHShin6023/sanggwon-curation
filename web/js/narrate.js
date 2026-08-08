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

// 6개 축의 한글 라벨. I3(리뷰 라운드 2) — 결측 축을 사용자에게 알릴 때 쓴다.
const AXIS_LABEL = {
  footfall: "유동인구", resident: "배후 거주인구", worker: "직장인구",
  competition: "경쟁", vitality: "매출 추세·지속성", fit: "업종 적합도",
};

// 표본이 이 미만이면 등급이 잡음일 수 있다는 사실을 화면이 드러내야 한다
// (개정 블록 (라), poolSize는 등급을 매긴 표본 크기). render.js가 alt-card의
// poolSize를 판단할 때도 같은 기준을 써야 해서 export한다 — 상수를 두 파일에
// 따로 박아두면 나중에 한쪽만 바뀌어 "asked 업종과 대안이 서로 다른 '얇다'
// 기준을 쓰는" 결함이 생긴다(리뷰 지적).
export const THIN_POOL = 30;

const isNum = (v) => typeof v === "number";

// "돈"의 결측(null/undefined)과 "0원"은 다른 사실이다. 예전 `!won` 가드는
// 실제 0원도 "값 없음"으로 접어버렸다 — 지금 실데이터엔 0원 케이스가 없지만
// (검증함) 결측/0을 구분 못 하는 코드는 그 자체로 결함이라 고친다.
export function money(won) {
  if (won == null) return null;
  const eok = won / 100000000;
  if (eok >= 1) return `${eok.toFixed(1)}억원`;
  return `${Math.round(won / 10000).toLocaleString()}만원`;
}

// 한글 체언 뒤 "이/가" 조사. 받침이 있으면 "이", 없으면 "가".
// "커피-음료"(받침 없음)에 하드코딩된 "이"를 붙이면 "커피-음료이"가 되는
// 어색한 문장이 나온다 — 매번 계산한다.
function josaGa(word) {
  if (!word) return "가";
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return "가";
  const hasBatchim = (code - 0xac00) % 28 !== 0;
  return hasBatchim ? "이" : "가";
}

export function templateNarration(result) {
  const { axes = {}, industryName, areaName, grade } = result;
  const factors = [];

  const push = (kind, text) => text && factors.push({ kind, text });

  // 축 값은 entry.axes ?? {}로 넘어오므로 개별 축이 null/undefined일 수
  // 있다 — `null <= 30`이 true라서 가드 없이 비교하면 "확인 안 됨"이
  // "하위권입니다"라는 사실 주장으로 둔갑한다. 모든 축 비교 앞에
  // isNum()을 건다(리뷰 F3).
  if (isNum(axes.footfall) && axes.footfall >= HIGH) {
    // 100은 "상위 0%"로 찍혀 이상하게 읽힌다(실데이터 182건) — 표시상 최소
    // 1%로 내림한다. 계산에 쓰이는 axes.footfall 원값은 그대로 둔다.
    const pct = Math.max(1, Math.round(100 - axes.footfall));
    push("positive", `유동인구가 상위권입니다 (상위 ${pct}%)`);
  }
  if (isNum(axes.footfall) && axes.footfall <= LOW) push("negative", "유동인구가 하위권입니다");
  if (isNum(axes.resident) && axes.resident >= HIGH) push("positive", "배후 거주인구가 두텁습니다");
  if (isNum(axes.worker) && axes.worker >= HIGH) push("positive", "직장인구가 많은 자리입니다");

  if (isNum(axes.competition) && axes.competition <= LOW) {
    // money()가 null이면(매출 결측) "하위권"이라고 지어내지 않는다 — 그
    // 절만 빼고 문장을 만든다(리뷰 F3, money() ?? "하위권" 결함).
    const salesText = money(result.salesPerStore);
    push("negative",
      `경쟁이 심합니다. ${industryName}${josaGa(industryName)} 이미 ${result.storeCount}개입니다` +
      (salesText ? ` (점포당 추정매출 ${salesText})` : ""));
  } else if (isNum(axes.competition) && axes.competition >= HIGH) {
    const salesText = money(result.salesPerStore);
    push("positive", `경쟁 대비 점포당 매출이 양호합니다` + (salesText ? ` (${salesText})` : ""));
  }

  if (isNum(axes.vitality) && axes.vitality <= LOW) push("caution", "최근 매출 추세와 폐업률이 좋지 않습니다");
  if (isNum(axes.vitality) && axes.vitality >= HIGH) push("positive", "매출 추세와 영업 지속성이 안정적입니다");
  if (isNum(axes.fit) && axes.fit <= LOW) push("caution", "이 상권의 소비 시간대·연령 구성이 해당 업종과 잘 맞지 않습니다");
  if (isNum(axes.fit) && axes.fit >= HIGH) push("positive", "상권의 소비 성격이 해당 업종과 잘 맞습니다");

  // 리뷰 라운드 2 I3: null 축을 "하위권"으로 지어내지 않게 된 것(F3)과,
  // 그 축이 아예 없었다는 사실을 조용히 삼키는 것은 다른 문제다.
  // etl/engine/scoring.py의 base_score()는 결측 축을 가중치에서 빼고
  // 나머지 축으로 재정규화한다 — 즉 그 업종에서 가장 중요한 축이 빠진 채
  // 등급이 나왔을 수 있다(실측: 청계산원터골/한식음식점은 유동의존형인데
  // footfall이 null이다). 감지된 패턴 하나엔 상자를 통째로 주면서 이건
  // 안 보여주면 형평에 안 맞는다 — caution factor로 알린다.
  const missingAxes = Object.keys(AXIS_LABEL).filter((key) => !isNum(axes[key]));
  if (missingAxes.length > 0) {
    const labels = missingAxes.map((key) => AXIS_LABEL[key]).join("·");
    push("caution",
      `${labels} 데이터가 없어 그 축을 빼고 나머지 축의 가중치를 다시 배분해 이 등급을 계산했습니다.`);
  }

  // poolSize: 얇은 표본(< 30)은 등급 자체가 잡음일 수 있다는 사실을 숨기지
  // 않는다. 표본 크기를 알 수 없을 때(null)는 "얇다"고 단정하지 않는다 —
  // 그것도 없는 확신을 지어내는 것이다.
  if (isNum(result.poolSize) && result.poolSize < THIN_POOL) {
    push("caution", `이 등급은 표본 ${result.poolSize}개를 기준으로 계산됐습니다. 표본이 얇아 참고용으로만 보십시오.`);
  }

  // floorNote: "경고가 붙었는가"에 대한 진술. 경고가 없으면(계수가
  // warnBelow 이상) null이다 — 이건 유지한다(narrate.test.js가 명시적으로
  // 검증하는 계약이고, "경고 상자"를 보여줄 이유가 없을 때 안 보여주는 것
  // 자체는 옳다).
  const floorNote = result.warning
    ? {
        severity: result.warning.severity,
        text: result.warning.message,
        basisNote:
          "※ 층수 판단은 공개 데이터가 아니라 현장 경험에 근거한 추정입니다. " +
          "공공데이터에는 층별 매출이 존재하지 않습니다.",
      }
    : null;

  // floorBasis: floorNote와는 다른 진술이다 — "경고가 떴는가"가 아니라
  // "층수가 실제로 이 등급에 영향을 줬는가"를 알린다.
  //
  // ⚠️ 리뷰 라운드 2 C1: 1라운드 버전은 "층수는 이 등급 계산에 반영됩니다"를
  // 무조건 참으로 하드코딩했다. 그런데 배포된 floor_config 계수가 6개 그룹
  // 전부 1.0(잠정값)이라, 성공한 모든 판정에서 실제로는 거짓이었다(예: 배화여대
  // /한식음식점은 5개 층 전부 score 59.4786로 동일 — 층수가 아무것도 안
  // 바꾼다). "반영 안 될 수도 있다"는 식으로 하드코딩된 반대쪽 문장을
  // 쓰는 것도 똑같이 틀린 짓이다(신동환이 실계수를 채우면 그때는 거짓이
  // 된다). 그래서 참/거짓 어느 문장도 하드코딩하지 않고, 매번
  // entry.base(층수 적용 전, baseScore)와 verdict.score(적용 후)를 직접
  // 비교해서 판단한다 — 실계수가 배포되면 코드를 안 고쳐도 자동으로
  // 반대 방향 진실을 말하게 된다.
  let floorBasis;
  if (!isNum(result.baseScore)) {
    // baseScore를 안 받은 호출(narrate.test.js의 BASE 픽스처 등)은 층수가
    // 실제로 영향을 줬는지 판단할 데이터가 없다 — "영향 없음"도 "영향
    // 있음"도 지어내지 않고 일반 고지만 한다.
    floorBasis = {
      text:
        `${FLOOR_LABELS[result.floor]} 층수는 이 등급 계산의 입력값 중 하나입니다. ` +
        "층수 보정 계수는 공개 데이터가 아니라 현장 경험에 근거한 휴리스틱 추정입니다.",
    };
  } else if (result.score === result.baseScore) {
    // base*1.0은 부동소수점에서도 정확히 base와 같다 — "계수가 정확히
    // 1.0이라 안 바뀌었다"고 말해도 되는 유일한 조건. baseScore가 0이면
    // 어떤 계수를 곱해도 결과가 0이라 계수를 역산할 수 없다 — 그 경우는
    // "계수가 1.0"이라고 단정하지 않는다.
    floorBasis = result.baseScore !== 0
      ? {
          text:
            `이번 판정에서는 ${FLOOR_LABELS[result.floor]} 층수가 등급에 아무 영향도 주지 않았습니다 ` +
            "(적용된 층수 보정 계수가 1.0입니다). 층수 보정 계수는 공개 데이터가 아니라 현장 경험에 근거한 " +
            "휴리스틱 추정이며, 현재는 잠정값 상태라 대부분의 판정에서 이렇게 나옵니다.",
        }
      : {
          text:
            `${FLOOR_LABELS[result.floor]} 층수가 등급 계산에 미친 영향은 이번 판정에서는 확인할 수 없습니다. ` +
            "층수 보정 계수는 공개 데이터가 아니라 현장 경험에 근거한 휴리스틱 추정입니다.",
        };
  } else {
    const ratio = result.baseScore ? (result.score / result.baseScore).toFixed(2) : null;
    floorBasis = {
      text:
        `${FLOOR_LABELS[result.floor]} 층수가 이 등급 계산에 실제로 반영됐습니다` +
        (ratio ? `(적용된 보정 계수 약 ${ratio}배)` : "") +
        ". 층수 보정 계수는 공개 데이터가 아니라 현장 경험에 근거한 휴리스틱 추정입니다.",
    };
  }

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
    floorBasis,
    patternNotes,
  };
}
