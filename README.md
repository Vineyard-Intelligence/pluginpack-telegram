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

- 모든 그래프 쓰기는 **스테이징** → analyst 리뷰 → 커밋
- 노드 생성은 `key`(예: `telegram:telegram.channel:<id>`)로 중복 생성 방지
- `username`은 대표 핸들 하나, `usernames`엔 활성 상태인 전체 핸들이 줄바꿈으로 들어감 —
  텔레그램의 컬렉터블/복수 유저네임 계정은 대표 핸들 외에 여러 개를 더 가질 수 있음 (tgpeek 0.3.0+ 필요)
- 비텔레그램 URL / 타입 불일치 입력은 **no-op** (아무것도 생성·수정하지 않음)
- "login"은 플러그인 범위 밖 — 세션은 게이트웨이 운영자가 `tgpeek login`으로 관리
- 용어: 텔레그램 표준 용어인 **participant**만 사용 (그래프 엣지 `participant_of`/`admin_of`)
- **Phone Lookup**: 번호가 미가입이거나 상대가 전화번호 조회를 숨겼으면 결과 없음(둘은 구분 불가). 게이트웨이가 1시간 캐시를 적용하고 동일 번호 동시 조회는 1회로 합칩니다.

## 파라미터

이 팩은 **설정(scopes.config)이 없습니다.** 수집 상한은 실행할 때마다 정하는 값이므로
**Run plugins 다이얼로그의 pre-run 폼**에서 받는 파라미터입니다.

| 플러그인 | 파라미터 | 비고 |
|---|---|---|
| `telegram_search` | `query` (필수), `limit` | 1–50, 기본 20 |
| `telegram_posts` | `limit` | 채팅당 최대 포스트 수. 비우면 전체 |
| `telegram_participants` | `limit` | 그룹당 최대 참가자 수. 비우면 전체 |

`telegram_resolve`/`telegram_invite_link`/`telegram_phone_lookup`은 파라미터가 없습니다.

**2.2.0에서 `posts_limit`/`participants_limit` 설정이 사라졌습니다** — 각 플러그인의 `limit`
파라미터를 쓰십시오.

## 게이트웨이는 `ctx.service`로 부릅니다 (2.0.0)

이 팩은 게이트웨이 주소도 토큰도 설정하지 않습니다. `scopes.services: ["telegram"]`을 선언하고
앱이 분석가의 Vineyard 로그인으로 호출합니다.

```js
await ctx.service("telegram", "resolve", { method: "POST", body: JSON.stringify({ target }) });
```

세션이 만료되면 **401**, 플랜/권한 문제면 **403**이 돌아옵니다.

### 1.x 에서 올라오는 경우

`gateway_token` 설정값은 **버려도 됩니다**. 남아 있어도 팩이 읽지 않습니다. 설치 화면의
권한 표시도 바뀝니다 — 엔드포인트 URL과 "Secret config" 대신 **`Vineyard telegram`** 한 줄입니다.

## 실패는 실패로 끝납니다 (2.1.0)

| 상황 | 결과 |
|---|---|
| 하나도 못 가져왔는데 오류가 있음 | **실패** — 첫 오류 메시지가 그대로 실행 행에 빨간색으로 |
| 일부 성공, 일부 실패 | 성공 — 단, 요약에 `— first error: …`로 실제 메시지가 붙음 |
| 401 / 403 | **즉시 중단** — 죽은 세션은 나머지 노드에도 죽어 있음 |
| 결과가 없을 뿐 오류는 없음 | 성공 (`skipped`) |
| `ctx.service` 자체가 없음 | 실패 — 빈 결과가 아니라 망가진 설치입니다 |

## 서버 쪽 요구사항

게이트웨이 세션은 운영자가 사전에 `tgpeek login`으로 만들어 둡니다(게이트웨이 자체는 재로그인하지
않음). 게이트웨이가 공개 https 엔드포인트(`auxiliary.vineyard.run`)이므로 웹 앱과 데스크탑 앱
모두에서 동작합니다.

## 개발 테스트

```bash
# 번들 기능 테스트
node test-plugin.mjs
# => PASS 216 / 216 (search / resolve / invite_link 분석 / posts / participants / phone_lookup)
```

`test-plugin.mjs`는 가짜 `ctx`(graph/net)로 여섯 플러그인의 `run()`을 호출해
가드·게이트웨이 페이로드·노드/엣지 스테이징·증거 체인·no-op 규칙을 검증합니다.

## 배포

`typepack-telegram`(telegram.user/channel/group/post 타입, `participant_of` 등 엣지)도 함께 배포해야 합니다.

## 라이선스

MIT. tgpeek(MIT)과 짝을 이룹니다. Telegram-X(GPLv3) 코드는 복사하지 않고
호출 시퀀스(로직)만 참고했습니다.
