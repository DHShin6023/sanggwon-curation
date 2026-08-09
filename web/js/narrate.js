// 판정 결과 → 문장. AI 없이도 완결되는 템플릿 경로.
// Task 12에서 AI 해설이 추가되지만 이 함수는 항상 폴백으로 살아 있다.
//
// FLOOR_LABELS, GRADE_MEANING은 verdict.js가 실제로 export한다(2026-08-08 확인).
import { FLOOR_LABELS, GRADE_MEANING } from "./verdict.js";

const PATTERN_TEXT = {
  // 「말립니다」는 결과 예측이라 쓰지 않는다(2026-08-09 사상 정리). 뒤 문장은
  // 살릴 가치가 있는 도메인 지식이라 버리지 않고 **궁합 서술**로 바꿨다.
  함정상권: "통행량은 많은데 소비로 이어지지 않는 패턴입니다. " +
            "테이크아웃 위주 저단가 구조와는 결이 맞지만, 좌석 회전을 기대하는 " +
            "모델과는 잘 맞지 않는 자리입니다.",
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

// ── AI 해설 (출구). 실패하면 조용히 null을 반환하고 호출부가 템플릿으로 떨어진다. ──
// OpenRouter는 유료 크레딧 키를 쓴다(2026-08-09 결정). 호출 1건이 곧 지출이므로
// 캐싱은 선택이 아니라 필수다. 같은 (상권·업종·층수·등급)은 문장이 같아도 된다.

export function cacheKey(result) {
  return [result.areaName, result.industryName, result.floor, result.grade,
          (result.patterns ?? []).join("|")].join("::");
}

// ── AI에게 건네는 payload (입력 쪽 정리) ─────────────────────────────
//
// I1(리뷰 1라운드): 우리가 모델에게 %가 든 payload를 주고서 %가 든 출력을
// 거부하고 있었다. rankLabel()의 네 갈래는 전부 "상위 25% 이내"처럼 %를 담고,
// 그게 judge() → narrationInput → 워커로 그대로 갔다. 그 결과 **payload를
// 정확히 인용한 문장일수록 거부되고, 아무 수치도 대지 않는 모호한 문장만
// 통과**했다 — 인센티브가 정확히 거꾸로였고, 조용히 실패하는 설계라 아무
// 신호도 남지 않았다.
//
// 고치는 방향은 "검증을 느슨하게"가 아니라 "입력에서 %를 걷어내기"다.
// ⚠️ 화면에 나가는 값은 하나도 바뀌지 않는다 — rankLabel()도 render.js도
// 그대로고, 이 변환은 **AI payload 전용**이다.
const RANK_FOR_AI = {
  "상위 25% 이내": "상위 4분의 1 이내",
  "상위 50% 이내": "상위 절반 이내",
  "하위 50%": "하위 절반",
  "하위 25%": "하위 4분의 1",
};

const HAS_PERCENT = /%|퍼센트|확률/;

// 중첩된 문자열까지 훑는다 — 나중에 %를 담은 필드가 하나 더 생겨도 같은
// 사고가 조용히 반복되지 않게 하는 방어선이다(현재 실데이터에서 %를 담은
// 필드는 rank 하나뿐임을 1,650개 상권·62개 업종으로 확인했다).
function containsPercent(value, depth = 0) {
  if (depth > 6) return false;
  if (typeof value === "string") return HAS_PERCENT.test(value);
  if (Array.isArray(value)) return value.some((v) => containsPercent(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).some((v) => containsPercent(v, depth + 1));
  }
  return false;
}

export function aiPayload(result) {
  const out = {};
  for (const [key, value] of Object.entries(result ?? {})) {
    if (key === "rank" && typeof value === "string") {
      const moved = RANK_FOR_AI[value];
      if (moved) { out.rank = moved; continue; }
      // 모르는 표기다. %가 없으면 그대로 두고, 있으면 안전하게 옮길 방법이
      // 없으므로 싣지 않는다 — 모델이 그걸 인용하는 순간 문장 전체가
      // 거부되기 때문이다. 조용히 넘어가지 않고 개발자에게 신호를 남긴다.
      if (!HAS_PERCENT.test(value)) out.rank = value;
      else console.warn(`aiPayload: 모르는 rank 표기라 AI payload에서 뺐다 — "${value}" (RANK_FOR_AI에 매핑을 추가할 것)`);
      continue;
    }
    if (containsPercent(value)) {
      console.warn(`aiPayload: "${key}" 필드에 %/퍼센트/확률이 있어 AI payload에서 뺐다 — 이 필드도 %-없는 표현으로 옮길 것`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

const MIN_LEN = 20;
const MAX_LEN = 600;

// M1: 모델은 payload에서 등급을 문자열로 받으므로 '상' / 「상」 / "중상" /
// (상) 처럼 인용부호나 괄호로 감싸 쓰는 게 오히려 자연스럽다. 감싼 형태가
// 규칙 3을 통째로 빠져나가던 걸 막는다.
// N5(리뷰 라운드 2): 처음 넓힐 때 ASCII 따옴표·소괄호·대괄호·낫표만 넣었더니
// **마크다운 볼드가 통과했다** — `**상** 등급`. 모델에게 강조하지 말라고 한 적이
// 없으니 이건 예외적 출력이 아니라 **가장 흔한 출력 형태**다. 전각·CJK 괄호
// (《》【】〈〉（）)와 백틱·언더바도 같이 뚫려 있었다.
//
// 감싸는 문자는 0개 이상 허용한다(`?`가 아니라 `*`) — `**`처럼 두 글자짜리를
// 잡으려면 필요하다. 문장부호만 모아둔 클래스라 과매칭 위험은 없다.
const GRADE_QUOTE = `["'\`*_‘’“”「」『』〈〉《》【】()\\[\\]（）＜＞<>]`;
const GRADE_CLAIM = new RegExp(
  `(?<![가-힣])${GRADE_QUOTE}*\\s*(중상|중하|상|하)\\s*${GRADE_QUOTE}*\\s*등급`, "g");

// 단위가 붙은 숫자만 본다. "억원"·"만원"을 "원"보다 앞에 둬야 잘리지 않는다.
const NUMBER_WITH_UNIT = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(억원|만원|원|명|개|배)/g;
const UNIT_SCALE = { 억원: 1e8, 만원: 1e4, 원: 1, 명: 1, 개: 1, 배: 1 };

// payload 안에 실제로 들어 있는 수를 전부 긁어모은다. 중첩 객체(axes 등)도
// 훑되 순환 참조에 걸리지 않게 깊이를 제한한다.
function collectNumbers(value, out = new Set(), depth = 0) {
  if (depth > 6) return out;
  if (typeof value === "number" && Number.isFinite(value)) out.add(value);
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out, depth + 1);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out, depth + 1);
  }
  return out;
}

// AI가 돌려준 문장을 화면에 올리기 전에 코드로 다시 본다. 통과하면 (trim된)
// 문장을, 하나라도 어기면 null을 돌려준다 — 호출부는 null을 받으면 조용히
// 템플릿 해설로 떨어진다(스펙 11, 사용자에게 오류를 노출하지 않는다).
//
// 프롬프트는 검증이 아니다. "지어내지 마라"라고 시스템 프롬프트에 쓰는 것과
// 지어낸 문장을 걸러내는 것은 다른 일이고, 여기가 이 서비스에서 생성모델이
// 직접 문장을 만드는 유일한 지점이라 여기서 못 막으면 막을 곳이 없다.
//
// ⚠️ 이 검사의 한계 — 잡지 못하는 것을 잡는다고 읽지 말 것.
//   규칙 4(지어낸 수치)는 **단위가 붙은 아라비아 숫자**(원/만원/억원/명/개/배)만
//   본다. 즉 매출·점포수·인구 같은 통계 날조는 잡지만, 다음은 전혀 못 잡는다:
//     · 단위 없는 숫자 ("상위 30" 같은 표현)
//     · 한글 수사 ("마흔 곳", "세 배")
//     · 위 목록에 없는 단위 (층·건·년·평 등)
//     · 숫자가 아닌 사실의 날조 ("이 골목은 최근 재개발이 확정됐습니다")
//     · payload에 우연히 같은 수가 있는 경우 (예: 백분위 92를 "92개"라고 써도 통과)
//   반대 방향의 오탐도 있다. payload에서 파생됐지만 그대로는 들어 있지 않은
//   정당한 수(예: 점포수 차이, 계산된 배수)는 거부되어 템플릿으로 떨어진다 —
//   틀린 문장을 보여주는 쪽보다 낫다고 보고 이 방향을 택했다.
//   규칙 3(등급 모순)은 **「등급」이라는 낱말에 바로 붙은 형태만** 본다.
//   등급 낱말 앞뒤를 감싸는 문장부호는 GRADE_QUOTE에 모아둔 것만 벗겨낸다.
//   아래는 못 잡는 예이며 **이 목록은 전부가 아니다**:
//     · 어순이 뒤집힌 형태 (「등급은 상입니다」) — 잡으려면 「등급은 상권
//       평균보다」류를 오탐하게 되어 오탐을 피하는 쪽을 택했다
//     · 「등급」이라는 낱말 없이 단정하는 형태 (「이 자리는 상입니다」)
//     · 등급을 에둘러 말하는 형태 (「추천드립니다」, 「말리고 싶습니다」) —
//       규칙 3은 낱말만 보고 뜻은 보지 않는다
//     · GRADE_QUOTE에 없는 문장부호로 감싼 형태
//   ⚠️ 마지막 항목이 실제로 터졌다(N5): 처음엔 ASCII 따옴표·괄호만 넣어서
//   마크다운 볼드 `**상** 등급`이 그대로 통과했다. **"감싼 형태는 잡는다"고
//   뭉뚱그려 쓰지 말 것** — 잡는 건 GRADE_QUOTE에 열거된 문자뿐이고, 새 표기가
//   나오면 또 뚫린다. 규칙 3은 최후 방어선이 아니라 흔한 사고를 거르는 체다.
export function validateNarration(text, result) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return null;

  // 규칙 2 — 확률·퍼센트. 이 서비스는 "성공 확률"을 계산하지 않는다.
  // 모델이 그런 수를 말하면 그건 전부 지어낸 것이다(스펙 프롬프트 규칙 2).
  if (/%|퍼센트|확률/.test(trimmed)) return null;

  // 규칙 3 — 등급 모순. 판정은 룰엔진이 하고 AI는 그걸 설명만 한다.
  // 맨 includes("상")은 「이 상권은」·「기대 이상」·「상황」을 전부 오탐한다.
  // 「등급」이라는 낱말에 바로 붙은 형태만 등급 단정으로 본다.
  // 앞에 한글이 붙은 경우(「최상 등급」)는 별개의 낱말이므로 제외한다.
  // 긴 후보(중상·중하)를 짧은 후보(상·하)보다 먼저 둬야 「중상 등급」이
  // 「상 등급」으로 잘못 잘리지 않는다.
  for (const [, claimed] of trimmed.matchAll(GRADE_CLAIM)) {
    if (claimed !== result?.grade) return null;
  }

  // 규칙 4 — 지어낸 수치. 아래 "이 검사의 한계" 주석을 반드시 함께 읽을 것.
  const known = collectNumbers(result);
  for (const [, digits, unit] of trimmed.matchAll(NUMBER_WITH_UNIT)) {
    const shown = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(shown)) return null;
    const scale = UNIT_SCALE[unit];
    // 표기된 자릿수만큼만 반올림 오차를 허용한다. "1.2억원"은 소수 첫째
    // 자리까지 쓴 표기이므로 ±0.05억원, "1,200만원"은 ±0.5만원까지 같은
    // 값으로 본다 — money()가 실제로 하는 반올림을 그대로 되짚는 폭이다.
    const decimals = (digits.split(".")[1] ?? "").length;
    const tolerance = scale / 10 ** decimals / 2;
    const value = shown * scale;
    let supported = false;
    for (const n of known) {
      if (Math.abs(n - value) <= tolerance) { supported = true; break; }
    }
    if (!supported) return null;
  }

  return trimmed;
}

const memory = new Map();

// Node에서는 `globalThis.localStorage`를 읽기만 해도 ExperimentalWarning이
// stderr로 나온다(--localstorage-file 미지정). 캐시는 브라우저 전용 관심사라
// window가 있을 때만 접근한다 — 테스트는 window/localStorage 대역을 직접
// 세팅해서 이 경로를 그대로 탄다.
function storage() {
  if (typeof globalThis.window === "undefined") return null;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;   // Safari 프라이빗 모드 등에서 접근 자체가 던진다
  }
}

export async function aiNarration(result, { endpoint, timeoutMs = 4000 } = {}) {
  const key = cacheKey(result);
  if (memory.has(key)) return memory.get(key);

  // 모델에게 실제로 건네는 payload. 검증도 이 payload를 기준으로 한다 —
  // 모델이 본 것과 우리가 대조하는 것이 달라지면 안 된다(I1).
  const payload = aiPayload(result);

  const store = storage();
  // localStorage는 배포를 건너 살아남는다 — 검증 규칙이 생기거나 바뀌기 전에
  // 저장된 문장이 그대로 화면에 올라가면 검증을 넣은 의미가 없다. 읽을 때도
  // 다시 통과시킨다.
  const storageKey = `narr:${key}`;
  const raw = store?.getItem(storageKey) ?? null;
  const stored = validateNarration(raw, payload);
  if (stored) { memory.set(key, stored); return stored; }
  // M3: 재검증에 떨어진 항목은 지운다. 안 지우면 규칙이 바뀐 뒤에도 그 자리에
  // 남아 매번 읽히고 매번 거부돼, 그 (상권·업종·층수·등급) 조합은 영영 캐시
  // 적중 없이 매번 모델을 부르게 된다 — 유료 키에서는 그대로 반복 지출이다.
  if (raw !== null) {
    try { store?.removeItem(storageKey); } catch { /* 용량·권한 문제는 무시 */ }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // 워커는 한도 초과·모델 사망 시 429가 아니라 200 {text: null}로 응답한다
    // (개정 (나)3/(다)) — 여기서 새 분기를 만들지 않고 기존 폴백을 그대로 탄다.
    const { text } = await res.json();
    // 반환 직전에 반드시 검증한다. 캐시에는 통과한 문장만 넣는다(개정 (가)).
    const valid = validateNarration(text, payload);
    if (!valid) return null;
    memory.set(key, valid);
    // 저장 실패가 문장을 죽이면 안 된다. 사파리 프라이빗 모드는 setItem에서
    // QuotaExceededError를 던지고, 이 캐시는 비우는 코드가 없어 오래 쓰면
    // 한도에 닿는다. 그런데 이 시점의 valid는 **이미 크레딧을 치르고 받아
    // 검증까지 통과한 문장**이다 — 아래 catch로 흘려보내면 다음 화면에
    // 폴백이 뜨고, 그 크레딧은 아무것도 못 산 게 된다. 캐싱은 부가 기능이므로
    // 실패해도 반환은 그대로 한다.
    try { store?.setItem(`narr:${key}`, valid); } catch { /* 캐시 못 써도 문장은 살린다 */ }
    return valid;
  } catch {
    return null;   // 네트워크·타임아웃·파싱 실패 전부 여기로. 사용자에게 노출하지 않는다.
  } finally {
    clearTimeout(timer);
  }
}
