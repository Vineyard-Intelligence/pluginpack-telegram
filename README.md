# pluginpack-telegram

텔레그램 읽기 전용 정찰 VINEYARD 플러그인 팩 — tgpeek 게이트웨이를 통해 **가입 없이** 수집합니다.
플러그인 5개가 게이트웨이 엔드포인트와 **1:1 대응**하므로, AI 에이전트와 분석가 모두 필요한 조작만 골라 실행할 수 있습니다.

## 플러그인 ↔ 엔드포인트

| 플러그인 | 식별자 | 입력 | 엔드포인트 | 생성물 |
|---|---|---|---|---|
| **Telegram Search** | `run.vineyard.plugins.telegram_search` | 전역 + `params.query` | `/search` | `telegram.user/channel/group` (검색 결과) |
| **Telegram Resolve** | `run.vineyard.plugins.telegram_resolve` | `web.url` (t.me 핸들) | `/resolve` | 채팅/유저 노드 **정보만** (about·멤버수·플래그) + `links to` 증거 엣지 |
| **Telegram Invite Link** | `run.vineyard.plugins.telegram_invite_link` | `web.url` (초대 링크) | `/invite-link` | 기본=분석(채팅 노드 + `invite_hash` + `peek`/`expires`), `params.collect_mode=true`=전체 수집(게시글+참여자) |
| **Telegram Posts** | `run.vineyard.plugins.telegram_posts` | `web.url`(초대) / `telegram.channel` / `telegram.group` | `/posts` | `telegram.post` + `posted in`/`replied to` |
| **Telegram Participants** | `run.vineyard.plugins.telegram_participants` | `telegram.group` | `/participants` | `telegram.user` + `participant of`/`admin of` |

## 동작 흐름

```
Telegram Search ──▶ telegram.channel/group 노드 ──▶ Telegram Posts / Telegram Participants
Telegram Resolve (t.me/<handle> URL) ──────────────┘
Telegram Invite Link (초대 URL): 분석 ──▶ (peek 가능하면) collect_mode=true로 전체 수집
```

- 모든 그래프 쓰기는 **스테이징**(capture:true) → analyst 리뷰 → 커밋
- 노드 생성은 `key`(예: `telegram:telegram.channel:<id>`)로 중복 생성 방지
- 비텔레그램 URL / 타입 불일치 입력은 **no-op** (아무것도 생성·수정하지 않음)
- "login"은 플러그인 범위 밖 — 세션은 게이트웨이 운영자가 `tgpeek login`으로 관리
- 용어: 텔레그램 표준 용어인 **participant**만 사용 (그래프 엣지 `participant_of`/`admin_of`)

## 구성 (scopes.config)

| 키 | 타입 | 적용 플러그인 |
|---|---|---|
| `gateway_url` | url | 전체 (기본 `http://127.0.0.1:8787`) |
| `gateway_token` | string, **secret** | 전체 |
| `posts_limit` | number | invite_link(collect 모드), posts |
| `participants_limit` | number | invite_link(collect 모드), posts, participants |

`telegram_search`/`telegram_resolve`는 limit config를 사용하지 않습니다 (search는 `params.limit`).

## 배포 전 필수 (웹 빌드)

플러그인 `ctx.net.fetch`는 매니페스트 `scopes.network` 엔드포인트 + 프론트엔드
`plugins/net-allowlist.ts`(`endpointCovers`) **양쪽**의 허용이 필요합니다.

- 게이트웨이 origin(기본 `http://127.0.0.1:8787`)을 `net-allowlist.ts`에 추가
- 게이트웨이 URL을 바꾸면 다섯 플러그인의 매니페스트 `scopes.network[0].endpoint`도 함께 변경

게이트웨이는 `tgpeek serve --token <TGPEEK_GATEWAY_TOKEN>`로 실행합니다
(세션은 사전에 `tgpeek login`으로 생성; 게이트웨이 자체는 재로그인하지 않음).

## 개발 테스트

```bash
# 번들 기능 테스트 — JavaScriptCore 셸 (macOS, node 미설치 환경)
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m test-plugin.mjs
# => PASS 60 / 60 (search / resolve / invite_link 분석+collect / posts / participants)
```

`test-plugin.mjs`는 가짜 `ctx`(graph/net)로 다섯 플러그인의 `run()`을 호출해
가드·게이트웨이 페이로드·노드/엣지 스테이징·증거 체인·no-op 규칙을 검증합니다.

## 배포

`publish-packs.sh pluginpack-telegram` → 출력된 커밋 SHA를
`registry/registry/community-pluginpacks.json`에 고정 후 registry CI 검증.
`typepack-telegram`(telegram.user/channel/group/post 타입, `participant_of` 등 엣지)도 함께 배포해야 합니다.

## 라이선스

MIT. tgpeek(MIT)과 짝을 이룹니다. Telegram-X(GPLv3) 코드는 복사하지 않고
호출 시퀀스(로직)만 참고했습니다.
