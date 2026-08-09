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

### 모델 id를 반드시 지정할 것

**OpenRouter는 유료(선불 크레딧) 키를 쓴다** — 2026-08-09 신동환 결정. 무료
티어의 품질로는 해설 기능이 의미가 없다는 판단이고, 사용량이 늘면 그때
재검토한다.

코드의 기본값 `google/gemini-2.0-flash-exp:free`는 그 결정 **이전에** 박힌
2024년 프리뷰 모델이라 살아 있다고 가정하지 않는다. 유료 키를 쓰는 이상
이 기본값은 의도한 설정이 아니라 **지정을 안 했을 때 조용히 템플릿으로
떨어지게 두는 안전판**일 뿐이다.

**배포 시 OpenRouter 대시보드에서 쓸 모델의 정확한 id를 확인해 `MODEL`을
반드시 지정할 것** (`wrangler.toml`의 `[vars]` 또는
`npx wrangler secret put MODEL`). 여기에 특정 모델 id를 적어두지 않는 이유는
그게 이 문서가 확인할 수 없는 사실이기 때문이다 — 대시보드에 뜨는 값을 그대로
복사해 넣는다.

배포 전에 OpenRouter 대시보드에서 **크레딧 상한(hard limit)도 함께 걸어둘 것.**
아래 일 한도는 이 워커를 거친 호출만 세므로, 키가 새면 그 한도 밖에서 쓰인다.

모델이 죽어 있으면 `askModel()`이 `null`을 반환하고 `/narrate`는 `{text: null}`을
돌려주며 프론트는 템플릿 해설로 떨어진다 — 서비스는 죽지 않는다. 이 폴백은
`web/tests/worker.test.js`의 "개정 (다)" 테스트가 고정하고 있다.

## 남용 방지 (2026-08-09 신동환 결정)

CORS는 브라우저만 막고 curl은 못 막는다. workers.dev 주소가 알려지면 남이 이
프록시로 카카오 할당량을 태우고 **OpenRouter 크레딧을 대신 쓰게** 할 수 있다.
유료 키를 쓰므로 남용의 결과는 "서비스 정지"가 아니라 **청구**다.

1. **Origin 검사** — `ALLOWED_ORIGINS`에 없으면 `403`. Origin 헤더가 없는
   요청(curl 기본)도 403이다.
2. **AI 일 한도(KV)** — `rate:{ip}:{YYYY-MM-DD}` IP당 30건/일,
   `rate:global:{YYYY-MM-DD}` 전체 `GLOBAL_DAILY_LIMIT`건/일(기본 100).
   초과하면 `429`가 아니라
   **`200 {text: null}` / `200 {code: null}`** 로 답한다. 프론트에 새 분기를
   만들지 않고 기존 폴백을 그대로 타게 하려는 것이다.
3. **한도 초과 시 KV에 쓰지 않는다**(읽기만). 무료 KV는 쓰기 1,000건/일이라
   요청마다 쓰면 한도 장치가 보호 대상보다 먼저 죽는다.
4. **KV 오류·미바인딩 시** `/geocode`는 통과시키고 AI 두 엔드포인트는 건너뛴다.
   등급이 나와야 하므로 싼 쪽을 열고 비싼 쪽을 닫는다.

### 한도가 재는 대상은 AI 두 엔드포인트뿐이다

`/geocode`는 Origin 검사만으로 둔다. 지오코딩이 막히면 등급 자체가 안 나오는데
개정 (나)3·5가 "한도 초과·KV 사고 시에도 등급·근거는 그대로 나와야 한다"고
못박았기 때문이고, 비싼 쪽은 건당 크레딧이 나가는 OpenRouter지 카카오(10만/일
무료)가 아니기 때문이다. 세 엔드포인트를 전부 세면 분석 1건당 KV 쓰기가 3~6회라
쓰기 한도(1,000/일)가 먼저 터진다.

**한계**: 카운터는 read-then-write라 원자적이지 않고 KV는 최종 일관성이다.
동시 요청이 몰리면 한도를 조금 넘겨 셀 수 있다 — 정확한 계량기가 아니라
"하루치를 한 명이 통째로 태우는 것"을 막는 장치다.

### `GLOBAL_DAILY_LIMIT`을 어떻게 정할 것인가

유료 키를 쓰므로 **이 값은 할당량 보호 장치가 아니라 지출 상한**이다. 세 가지가
서로 묶여 있다.

| 묶인 것 | 관계 |
|---|---|
| **비용** | `하루 최대 지출 ≈ GLOBAL_DAILY_LIMIT × 호출당 단가`. 단가는 모델마다 다르므로 코드가 정할 수 없다 — 그래서 `env`로 뺐다. |
| **KV 쓰기** | `spend()` 1회 = KV 쓰기 **2회**(IP 카운터 + 전역 카운터). 무료 KV는 쓰기 **1,000건/일**이므로 `GLOBAL_DAILY_LIMIT × 2 ≤ 1,000`, 즉 **500이 상한**이다. 넘기면 한도 장치가 보호 대상보다 먼저 죽는다. |
| **체감 품질** | 한도에 닿으면 그날 남은 방문자는 전부 템플릿 해설을 본다(등급·근거·대안은 그대로). 서비스가 멈추는 게 아니라 해설만 밋밋해진다. |

기본값 **100**은 출발점이다. 실제 트래픽과 모델 단가를 보고 조정한다:

```toml
# wrangler.toml
[vars]
GLOBAL_DAILY_LIMIT = "100"
```

캐시가 이 한도를 크게 아껴준다. 같은 (상권·업종·층수·등급) 조합은 문장을
재사용하므로(`web/js/narrate.js`의 `cacheKey`), 100건은 "방문자 100명"이 아니라
"**서로 다른 조합** 100개"에 가깝다.

`IP_DAILY_LIMIT`(30)은 코드 상수로 뒀다. 한 사람이 하루에 30개 넘는 서로 다른
자리를 볼 일이 흔치 않고, 이 값을 낮추는 건 남용 방지지 지출 조절이 아니라서다.
지출을 줄이려면 `GLOBAL_DAILY_LIMIT` 쪽을 내린다.

### 권장 배포 단계 — `/geocode`에 Cloudflare Rate Limiting Rules

`/geocode`는 위에 적은 이유로 KV 한도를 재지 않고 **Origin 검사만** 걸려 있다.
그런데 Origin 헤더는 `curl -H "Origin: https://dhshin6023.github.io"` 한 줄로
위조되므로, 작정한 상대에게는 카카오 할당량(10만/일)이 사실상 열려 있다.

코드로 막지 않은 이유는 KV 카운터를 여기까지 확장하면 쓰기 한도가 먼저 터지기
때문이다. 제대로 된 해법은 Cloudflare가 무료로 주는 **Rate Limiting Rules**로,
KV 쓰기를 한 건도 쓰지 않는다.

대시보드 → Security → WAF → Rate limiting rules 에서:

- **매칭**: `URI Path equals /geocode`
- **기준**: IP당 `1분에 20건` 정도(정상 사용자는 주소 하나에 1건을 쓴다)
- **동작**: Block, 10분

이건 콘솔에서 하는 배포 시점 결정이라 코드 범위 밖이다. **필수는 아니지만
공개 후에는 걸어두는 걸 권한다.**

### 업스트림 타임아웃

브라우저 `fetch`에도 워커 `fetch`에도 기본 타임아웃이 없다. 없으면 업스트림이
멈출 때 "조용히 폴백"이 아니라 **"조용히 멈춤"**이 된다 — 화면이 아무 변화 없이
서 있고 사용자는 뭐가 잘못됐는지 알 수 없다.

| 구간 | 한도 | 정의 위치 |
|---|---|---|
| 브라우저 → `/narrate` | 4초 | `web/js/narrate.js` `timeoutMs` |
| └ 워커 → OpenRouter | **3초** | `src/index.js` `MODEL_TIMEOUT_MS` |
| 브라우저 → `/map-industry` | 3초 | `web/js/main.js` `MAP_INDUSTRY_TIMEOUT_MS` |
| └ 워커 → 카카오 | 5초 | `src/index.js` `KAKAO_TIMEOUT_MS` |

모두 초과하면 그 경로만 폴백으로 떨어진다(업종은 「목록에서 선택해 주세요」,
해설은 템플릿). 등급·근거·대안은 어느 경우에도 그대로 나온다.

**⚠️ 안쪽(워커→OpenRouter)이 바깥쪽(브라우저→`/narrate`)보다 작아야 한다.**
반대가 되면 브라우저가 먼저 포기한 뒤에도 워커는 호출을 끝내서 **크레딧은 나가고
문장은 아무도 못 받는다** — 클라이언트가 버렸으니 캐시에도 안 남아 같은 질문에
다음에 또 지불한다. 둘 중 하나를 고칠 때는 반드시 같이 본다.

`/map-industry` 쌍은 이 규칙이 뒤집혀 있는데(3초 < 5초) **의도한 것이다.** 카카오
주소검색은 건당 과금이 아니라 무료 할당량(10만/일)이라, 버려지는 호출의 대가가
"크레딧"이 아니라 "할당량 1건"이다. 사용자를 5초씩 세워두는 쪽이 더 비싸다.

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
