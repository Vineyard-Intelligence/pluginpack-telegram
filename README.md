# pluginpack-telegram

텔레그램 읽기 전용 정찰 VINEYARD 플러그인 팩 — tgpeek 게이트웨이를 통해 **가입 없이** 수집합니다.
플러그인 6개가 게이트웨이 엔드포인트와 **1:1 대응**하므로, AI 에이전트와 분석가 모두 필요한 조작만 골라 실행할 수 있습니다.

## 플러그인 ↔ 엔드포인트

| 플러그인 | 식별자 | 입력 | 엔드포인트 | 생성물 |
|---|---|---|---|---|
| **Telegram Search** | `run.vineyard.plugins.telegram_search` | 전역 + `params.query` | `/search` | `telegram.user/channel/group` (검색 결과) |
| **Telegram Resolve** | `run.vineyard.plugins.telegram_resolve` | `web.url` (t.me 핸들, `t.me/s/` 포함) / `telegram.user`·`channel`·`group` / `identity.handle` | `/resolve` | 채팅/유저 노드 **정보만** (about·멤버수·플래그). URL·handle 입력 → 노드 생성 + `links to`/`same as` 증거 엣지, telegram.\* 노드 입력 → **in-place 정제** (updateNode) |
| **Telegram Invite Link** | `run.vineyard.plugins.telegram_invite_link` | `web.url` (초대 링크) | `/invite-link` | **분석 전용** — 채팅 노드 + `invite_hash` + `peek`/`expires` (게시글은 Telegram Posts가 peek으로 처리) |
| **Telegram Posts** | `run.vineyard.plugins.telegram_posts` | `web.url`(초대) / `telegram.channel` / `telegram.group` | `/posts` | `telegram.post` + `posted in`/`replied to` |
| **Telegram Participants** | `run.vineyard.plugins.telegram_participants` | `telegram.group` | `/participants` | `telegram.user` + `participant of`/`admin of` |
| **Telegram Phone Lookup** | `run.vineyard.plugins.telegram_phone_lookup` | `identity.phone_number` | `/phone-lookup` | `telegram.user` + `same as` 엣지 (번호→계정 귀속) |

## 동작 흐름

```
Telegram Search ──▶ telegram.channel/group 노드 ──▶ Telegram Posts / Telegram Participants
Telegram Resolve (t.me/<handle> URL) ──────────────┘
Telegram Invite Link (초대 URL): 분석 ──▶ peek 가능하면 Telegram Posts가 게시글 수집
Telegram Phone Lookup (identity.phone_number 노드) ──▶ telegram.user + same as
```

- 모든 그래프 쓰기는 **스테이징**(capture:true) → analyst 리뷰 → 커밋
- 노드 생성은 `key`(예: `telegram:telegram.channel:<id>`)로 중복 생성 방지
- `username`은 대표 핸들 하나, `usernames`엔 활성 상태인 전체 핸들이 줄바꿈으로 들어감 —
  텔레그램의 컬렉터블/복수 유저네임 계정은 대표 핸들 외에 여러 개를 더 가질 수 있음 (tgpeek 0.3.0+ 필요)
- 비텔레그램 URL / 타입 불일치 입력은 **no-op** (아무것도 생성·수정하지 않음)
- "login"은 플러그인 범위 밖 — 세션은 게이트웨이 운영자가 `tgpeek login`으로 관리
- 용어: 텔레그램 표준 용어인 **participant**만 사용 (그래프 엣지 `participant_of`/`admin_of`)
- **Phone Lookup**: `contacts.resolvePhone` 기반 — 번호가 미가입이거나 상대가 전화번호 조회를 숨겼으면 결과 없음(설계상 구분 불가). 게이트웨이가 텔레그램 공식 요구(3초/1회 디바운스)와 1시간 캐시를 적용.

## 구성 (scopes.config)

Vineyard의 **Run plugins 다이얼로그 → 각 플러그인의 Settings**에서 설정합니다. 값은 브라우저에
저장되고, 플러그인은 **자기 매니페스트가 선언한 키만** 전달받습니다.

| 키 | 타입 | 적용 플러그인 |
|---|---|---|
| `gateway_token` | string, **secret** | 전체 |
| `posts_limit` | number | posts |
| `participants_limit` | number | posts, participants |

`telegram_search`/`telegram_resolve`/`telegram_phone_lookup`은 limit config를 사용하지 않습니다 (search는 `params.limit`).

### 토큰은 `X-Tgpeek-Token`으로 갑니다 — `Authorization`이 아닙니다

호스트 브리지는 **모든** 플러그인 요청에서 `authorization`·`cookie` 헤더를 제거합니다. 플러그인이
분석가의 자격증명을 제3자에게 전달할 수 없게 하는 설계이고, 그 규칙이 옳습니다. 그래서 예외를
만드는 대신 게이트웨이 쪽에 문을 하나 더 냈습니다 — tgpeek은 같은 토큰을 `X-Tgpeek-Token`
헤더로도 받습니다(`gateway/server.py`의 `TOKEN_HEADER`). curl·CLI용 `Authorization: Bearer`는
그대로 동작합니다.

**tgpeek 게이트웨이를 이 변경 이후 버전으로 올려야 합니다.** 이전 버전은 `Authorization`만
받으므로 브라우저 경로가 전부 401입니다.

### `gateway_url`은 없습니다 (의도적)

게이트웨이 오리진은 매니페스트가 `http://127.0.0.1:8787`로 고정하고, `endpointCovers`는 포트까지
포함한 파싱된 오리진으로 비교하며, 설치 게이트가 분석가에게 보여주는 것도 바로 그 엔드포인트입니다.
설정 가능한 base URL은 매니페스트만으로는 동작할 수 없습니다 — allowlist 검사(프론트엔드)와
CORS 워이버(데스크탑 셸)가 서로 다른 게이트라, 사용자가 CORS를 등록해도 allowlist가 여전히 거부하고,
뚫으려면 `scopes.network` 문법 자체를 확장해야 합니다. **팩 하나 때문에 15개 팩이 공유하는 published
스키마를 늘릴 이유는 없습니다** (다른 팩은 전부 공개·고정 호스트를 씁니다).

게이트웨이는 Vineyard 전용 서비스이므로 **기본 포트 8787, `127.0.0.1`에 띄우십시오.**
다른 주소가 필요해지면 그때 `scopes.network` 문법 확장(스키마 + SPEC + registry 선배포)까지
묶어서 처리하는 게 순서입니다.

## 배포 전 필수 (웹 빌드)

플러그인 `ctx.net.fetch`는 매니페스트 `scopes.network`에 선언된 엔드포인트만 통과합니다
(`plugins/net-allowlist.ts`의 `endpointCovers`가 파싱된 오리진 + 경로 세그먼트 경계로 비교).
별도의 하드코딩된 호스트 목록은 없습니다 — 매니페스트가 곧 allowlist입니다.

또한 https 페이지에서 루프백(`http://127.0.0.1`)으로 가는 요청은 Chrome의 Private Network
Access 검사를 받습니다. 게이트웨이는 프리플라이트에 `Access-Control-Allow-Private-Network: true`를
답하므로 통과하지만, 이 역시 위의 tgpeek 최신 버전이 필요합니다.

별도로 `net-allowlist.ts`에 호스트를 추가할 필요는 없습니다 — 매니페스트가 곧 allowlist입니다.
게이트웨이 주소를 바꾸려면 여섯 플러그인의 `scopes.network[0].endpoint`를 모두 고치고 재발행해야 합니다
(위 `gateway_url` 절 참조).

게이트웨이는 `tgpeek serve --token <TGPEEK_GATEWAY_TOKEN>`로 실행합니다
(세션은 사전에 `tgpeek login`으로 생성; 게이트웨이 자체는 재로그인하지 않음).

## 개발 테스트

```bash
# 번들 기능 테스트 — JavaScriptCore 셸 (macOS, node 미설치 환경)
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m test-plugin.mjs
# => PASS 87 / 87 (search / resolve / invite_link 분석 / posts / participants / phone_lookup)
```

`test-plugin.mjs`는 가짜 `ctx`(graph/net)로 여섯 플러그인의 `run()`을 호출해
가드·게이트웨이 페이로드·노드/엣지 스테이징·증거 체인·no-op 규칙을 검증합니다.

## 배포

`publish-packs.sh pluginpack-telegram` → 출력된 커밋 SHA를
`registry/registry/community-pluginpacks.json`에 고정 후 registry CI 검증.
`typepack-telegram`(telegram.user/channel/group/post 타입, `participant_of` 등 엣지)도 함께 배포해야 합니다.

## 라이선스

MIT. tgpeek(MIT)과 짝을 이룹니다. Telegram-X(GPLv3) 코드는 복사하지 않고
호출 시퀀스(로직)만 참고했습니다.
