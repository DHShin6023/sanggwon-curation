# sanggwon-proxy

카카오·OpenRouter 키 은닉용 프록시. **판정 로직은 여기 없다** — 등급·근거·대안은
전부 `web/js/`의 룰엔진이 만든다. 이 워커가 죽어도 서비스는 죽지 않아야 한다.

## 엔드포인트

| 경로 | 메서드 | 입력 | 출력 |
|---|---|---|---|
| `/geocode` | GET | `?q=주소` | `{lng, lat, gu_code, dong_code, address}` / 404 |
| `/map-industry` | POST | `{text, candidates}` | `{code}` 또는 `{code: null}` |
| `/narrate` | POST | `{payload}` | `{text}` 또는 `{text: null}` |

`gu_code`(5자리)·`dong_code`(8자리)는 **행정동 코드**(ADSTRD_CD)다. 카카오
주소검색의 `b_code`는 법정동이라 쓰면 안 된다 — `web/data/dong/*.json`의 키와
코드 체계가 달라 🟡 행정동 폴백이 통째로 죽는다. 자세한 건 `src/index.js`의
지오코딩 절 주석 참고.

## 배포

```bash
npx wrangler login

# 1) 일 한도 카운터용 KV를 만들고, 출력된 id를 wrangler.toml에 채운다
npx wrangler kv namespace create RATE

# 2) 키는 secret으로만 넣는다 (wrangler.toml·코드에 절대 넣지 않는다)
npx wrangler secret put KAKAO_REST_KEY
npx wrangler secret put OPENROUTER_KEY

# 3) 배포
npx wrangler deploy
```

배포 후 출력되는 `*.workers.dev` 주소를 `web/js/main.js`의 `PROXY` 상수에 넣는다.
그 전까지는 `<계정>` 리터럴이 박혀 있어 **AI 경로 전체가 조용히 실패하고 템플릿
해설로 떨어진다 — 이게 정상 동작이다**(등급·근거·대안은 그대로 나온다).

### 모델 id를 반드시 확인할 것

코드의 기본값 `google/gemini-2.0-flash-exp:free`는 2024년 프리뷰 모델이라 지금
살아 있다고 가정하지 않는다. **배포 시 OpenRouter에서 현행 무료 모델을 확인해
`MODEL`을 지정할 것** (`wrangler.toml`의 `[vars]` 또는
`npx wrangler secret put MODEL`).

모델이 죽어 있으면 `askModel()`이 `null`을 반환하고 `/narrate`는 `{text: null}`을
돌려주며 프론트는 템플릿 해설로 떨어진다 — 서비스는 죽지 않는다. 이 폴백은
`web/tests/worker.test.js`의 "개정 (다)" 테스트가 고정하고 있다.

## 남용 방지 (2026-08-09 신동환 결정)

CORS는 브라우저만 막고 curl은 못 막는다. workers.dev 주소가 알려지면 무료
할당량을 남이 태울 수 있다.

1. **Origin 검사** — `ALLOWED_ORIGINS`에 없으면 `403`. Origin 헤더가 없는
   요청(curl 기본)도 403이다.
2. **AI 일 한도(KV)** — `rate:{ip}:{YYYY-MM-DD}` IP당 30건/일,
   `rate:global:{YYYY-MM-DD}` 전체 400건/일. 초과하면 `429`가 아니라
   **`200 {text: null}` / `200 {code: null}`** 로 답한다. 프론트에 새 분기를
   만들지 않고 기존 폴백을 그대로 타게 하려는 것이다.
3. **한도 초과 시 KV에 쓰지 않는다**(읽기만). 무료 KV는 쓰기 1,000건/일이라
   요청마다 쓰면 한도 장치가 보호 대상보다 먼저 죽는다.
4. **KV 오류·미바인딩 시** `/geocode`는 통과시키고 AI 두 엔드포인트는 건너뛴다.
   등급이 나와야 하므로 싼 쪽을 열고 비싼 쪽을 닫는다.

### 한도가 재는 대상은 AI 두 엔드포인트뿐이다

`/geocode`는 Origin 검사만으로 둔다. 지오코딩이 막히면 등급 자체가 안 나오는데
개정 (나)3·5가 "한도 초과·KV 사고 시에도 등급·근거는 그대로 나와야 한다"고
못박았기 때문이고, 실제로 희소한 자원은 OpenRouter(무료 50 RPD)지 카카오(10만/일)가
아니기 때문이다. 세 엔드포인트를 전부 세면 분석 1건당 KV 쓰기가 3~6회라
쓰기 한도(1,000/일)가 먼저 터진다.

**한계**: 카운터는 read-then-write라 원자적이지 않고 KV는 최종 일관성이다.
동시 요청이 몰리면 한도를 조금 넘겨 셀 수 있다 — 정확한 계량기가 아니라
"하루치를 한 명이 통째로 태우는 것"을 막는 장치다.

## AI 출력 검증은 여기가 아니라 클라이언트에 있다

`/narrate`의 시스템 프롬프트는 "지어내지 마라"라고 말할 뿐이고 **프롬프트는
검증이 아니다**. 돌아온 문장은 `web/js/narrate.js`의 `validateNarration()`이
다시 거르고, 걸리면 템플릿 해설로 떨어진다. 검증을 클라이언트에 둔 이유는
폴백 경로가 거기 있고 배포 없이 `node --test`로 검증되기 때문이다(개정 (가)).

## 테스트

```bash
node --test web/tests/worker.test.js
```

테스트 파일이 `web/tests/`에 있는 이유는 이 프로젝트의 공식 실행 명령이
`for f in web/tests/*.test.js; do node --test "$f"; done` 하나뿐이라서다.
다른 디렉터리에 두면 아무도 안 돌린다. 네트워크는 타지 않는다(카카오·
OpenRouter는 fetch 스텁, KV는 fakeKV).
