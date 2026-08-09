# 상권 큐레이션

주소·층수·업종을 입력하면 그 조합의 적합도를 4단계로 판정하고, 그 자리에 더 맞는
업종을 1안·2안으로 제시하는 웹서비스. 서울 단독.

**이 서비스는 결정해주지 않는다. 현장에 나가기 전에 후보를 걸러준다.**

## 데이터 갱신 (분기 1회)

분기마다 GitHub Actions가 자동 실행한다. 수동으로 돌리려면:

1. `.env` 에 `SEOUL_API_KEY` 설정 (data.seoul.go.kr 에서 발급)
2. `set -a && . ./.env && set +a`
3. `.venv/bin/python -m etl.build` — API 캐시를 새로 받으려면 `data/raw/*.parquet` 삭제
4. `web/data/` 변경분을 커밋

## 테스트

```bash
.venv/bin/python -m pytest etl/tests/ -v            # ETL

# 웹 — 파일별로 돌린다. `node --test web/tests/` 디렉터리형은 Node 26에서
# ERR_MODULE_NOT_FOUND로 깨진다.
for f in web/tests/*.test.js; do node --test "$f"; done
```

> `pytest etl/tests/test_build.py` 는 추적 파일인 `web/data/meta.json` 을 덮어쓴다.
> 돌린 뒤 `git checkout web/data/meta.json` 으로 되돌릴 것.

## 출처

- **서울 열린데이터광장 상권분석서비스** — [공공누리 제1유형](https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do)
  (출처표시, 상업적 이용 및 변경 가능). `data/raw/seoul_area_shp/` 의 상권영역
  SHP도 같은 데이터셋의 첨부파일이다.
- **카카오 로컬 API** — 주소 좌표 변환

## 라이선스

이 저장소의 **코드는 저작권을 유보한다**(All rights reserved). 소스는 공개돼 있지만
복사·수정·재배포에는 별도 허락이 필요하다. 업종군 분류, 축가중치, 층수계수는
공공데이터에서 산출된 값이 아니라 작성자의 현장 경험을 정리한 것이다.

위 **공공데이터는 각 출처의 이용조건**(공공누리 제1유형)을 따르며, 이 저장소의
코드 라이선스와 무관하게 그대로 유효하다.
