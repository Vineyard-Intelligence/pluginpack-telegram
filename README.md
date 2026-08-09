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
- **Phone Lookup**: `contacts.resolvePhone` 기반 — 번호가 미가입이거나 상대가 전화번호 조회를 숨겼으면 결과 없음(설계상 구분 불가). 게이트웨이가 1시간 캐시를 적용하고 동일 번호 동시 조회는 1회로 합칩니다. 텔레그램이 권고하는 3초 간격은 강제 사항이 아니라 기본 꺼짐(실제 제한은 FLOOD_WAIT이고 Telethon이 처리).

## 구성 (scopes.config)

Vineyard의 **Run plugins 다이얼로그 → 각 플러그인의 Settings**에서 설정합니다. 값은 브라우저에
저장되고, 플러그인은 **자기 매니페스트가 선언한 키만** 전달받습니다.

| 키 | 타입 | 적용 플러그인 |
|---|---|---|
| `posts_limit` | number | posts |
| `participants_limit` | number | posts, participants |

`telegram_search`/`telegram_resolve`/`telegram_phone_lookup`은 limit config를 사용하지 않습니다 (search는 `params.limit`).

**2.0.0에서 `gateway_token`이 사라졌습니다.** 분석가가 공용 서버 비밀을 들고 있을 이유가 없어졌습니다 —
아래를 보십시오.

## 게이트웨이는 `ctx.service`로 부릅니다 (2.0.0)

이 팩은 **주소를 모릅니다.** `scopes.network`도 `gateway_token`도 없고, 대신
`scopes.services: ["telegram"]` 하나를 선언합니다.

```js
await ctx.service("telegram", "resolve", { method: "POST", body: JSON.stringify({ target }) });
```

일어나는 일:

1. 호스트가 `SERVICES` 테이블에서 주소를 꺼내고 **분석가의 Vineyard 토큰**을 붙입니다. 팩은 목적지도
   자격증명도 표현할 수 없습니다 — 그게 이 호출에 신원을 실어도 되는 이유입니다.
2. auxiliary 게이트웨이가 그 토큰을 `api.vineyard.run`에 인트로스펙션합니다. 실패하면 **401**이
   그대로 돌아옵니다(세션 만료), 플랜/권한 문제면 **403**.
3. 인증이 끝난 뒤에야 게이트웨이가 `Authorization`을 **tgpeek의 베어러 토큰으로 교체**합니다.
   분석가의 토큰은 게이트웨이에서 멈추고 tgpeek까지 가지 않습니다.

그래서 예전에 분석가마다 하나씩 들고 있던 게이트웨이 토큰은 이제 **서버 한 곳**에만 있습니다.
팩이 토큰을 보내려 해도 게이트웨이가 덮어쓰므로, 되돌리는 건 순수한 다운그레이드입니다.

**어느 팩이 이 서비스를 쓸 수 있는지는 앱이 정합니다** — 호스트 브리지의 서비스 테이블에
`run.vineyard.pluginpacks.telegram`이 명시돼 있습니다. tgpeek은 운영자의 전화번호 인증 계정으로
돌기 때문에, "분석가가 회원인가"와는 별개의 질문입니다.

### 1.x 에서 올라오는 경우

`gateway_token` 설정값은 **버려도 됩니다**. 남아 있어도 팩이 읽지 않습니다. 설치 화면의
권한 표시도 바뀝니다 — 엔드포인트 URL과 "Secret config" 대신 **`Vineyard telegram`** 한 줄입니다.

## 서버 쪽 요구사항

`auxiliary.vineyard.run`의 `/telegram/*` 라우트가 tgpeek 게이트웨이로 갑니다(프리픽스는 Traefik이
벗겨서 전달 — 게이트웨이는 `/search`, `/phone-lookup` 처럼 루트에서 서빙). 인증 체인과 CORS는
게이트웨이가 담당하므로 팩 쪽에서 신경 쓸 것이 없습니다: `auxiliary/data/traefik_configs/dynamic/`의
`mw_aux_chain_tgpeek` 참조.

세션은 사전에 `tgpeek login`으로 만들어 둡니다(게이트웨이 자체는 재로그인하지 않음).

프록시/게이트웨이가 응답해야 하는 것:

- **CORS** — Traefik의 `mw_cors`가 체인 맨 앞에서 처리합니다. 프리플라이트는 인증 앞에 서 있어야
  합니다: 프리플라이트에는 자격증명이 실리지 않으므로 forwardAuth 뒤에 두면 401로 끝나고 실제
  요청이 아예 발생하지 않습니다.
- **HTTPS** — 앱이 https이므로 http 엔드포인트는 mixed content로 차단됩니다.

루프백을 쓰던 시절 필요했던 Chrome의 Private Network Access 처리
(`Access-Control-Allow-Private-Network`)는 **더 이상 해당 없습니다** — 공개 https 오리진끼리의
요청이라 PNA 검사 대상이 아닙니다. 게이트웨이가 그 헤더를 계속 보내도 무해합니다.

덤으로, 공개 https 엔드포인트가 되면서 **웹 빌드에서도 동작합니다** — 루프백 주소는 배포된 웹
앱에서 사실상 쓸 수 없었으므로, 이전에는 데스크탑 전용에 가까웠습니다.

## 개발 테스트

```bash
# 번들 기능 테스트 — JavaScriptCore 셸 (macOS, node 미설치 환경)
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m test-plugin.mjs
# => PASS 106 / 106 (search / resolve / invite_link 분석 / posts / participants / phone_lookup)
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
