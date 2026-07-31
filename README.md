# SK렌터카 재고 알림 봇

`https://rent.skdirect.co.kr/short-rent/car-list`에서 설정한 일정의 `commontunnel` API 응답을 주기적으로 확인하고, 지정 차량의 `avblCrnfCnt`가 `MIN_AVAILABLE_COUNT` 이상이 되면 Discord로 알립니다.

## 설정

1. Node.js 20 이상을 사용합니다.
2. `.env.example`을 `.env`로 복사합니다.
3. 알림 방식을 설정합니다. Discord 웹훅이면 `DISCORD_WEBHOOK_URL`, Discord 봇이면 `DISCORD_BOT_TOKEN`과 `DISCORD_CHANNEL_ID`, Telegram 봇이면 `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`를 넣습니다.
4. 브라우저에서 원하는 일정으로 `car-list`를 연 뒤 DevTools Network에서 `commontunnel` 요청을 찾습니다.
5. 해당 요청의 Request Payload 전체를 JSON으로 복사해서 `SKR_REQUEST_BODY_JSON`에 넣습니다. `commontunnel` 요청 본문 최상위에는 `prxyId`가 있어야 합니다. 본문이 크면 `request-body.json` 파일로 저장하고 `SKR_REQUEST_BODY_FILE=./request-body.json`을 사용합니다.
6. 필요하면 같은 Network 요청의 헤더를 `SKR_HEADERS_JSON`에 추가합니다.

## 실행

```bash
npm start
```

Discord 알림만 테스트하려면 SK렌터카 API를 호출하지 않는 테스트 명령을 사용합니다.

```bash
npm run test:discord
```

Telegram 알림만 테스트하려면 다음 명령을 사용합니다.

```bash
npm run test:telegram
```

봇은 이전 상태를 `STATE_FILE`에 저장합니다. 재고가 `0`에서 `1` 이상으로 바뀌는 전환에 알림을 보내며, `NOTIFY_ON_START_IF_AVAILABLE=true`이면 시작 시점에 이미 재고가 있어도 한 번 알립니다.
`REFRESH_REQUEST_TIMESTAMPS=true`이면 요청 직전 `param` 안의 `rsvReqsDtm`과 최상위 `updateCallback`을 현재 시각으로 갱신합니다.
대상 차량을 찾지 못하면 `DEBUG_RESPONSE_FILE=./last-response.json`을 설정한 뒤 다시 실행해서 실제 응답을 저장해 확인할 수 있습니다.

## 대상 차량 기본값

- 지점: 제주지점 (`TARGET_BRNH_ID=000012`)
- 차량 ID: `2600000001091`
- 차량명: `2027 그랜저(GN7)가솔린 캘리그래피`

## 운영 팁

`POLL_INTERVAL_MS`를 너무 짧게 두면 사이트에 부담을 줄 수 있습니다. 기본값은 60초입니다.
