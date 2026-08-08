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
.venv/bin/python -m pytest etl/tests/ -v   # ETL
node --test web/tests/                     # 웹
```

## 출처

서울 열린데이터광장 상권분석서비스 (CC BY) / 카카오 로컬 API
