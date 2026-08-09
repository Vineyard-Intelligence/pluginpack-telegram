// Functional test harness for pluginpack-telegram/dist/pack.mjs (5 plugins).
// Run: jsc -m pluginpack-telegram/test-plugin.mjs
import { readFileSync } from "node:fs";
import pack from "./dist/pack.mjs";

// Runs under BOTH node and the jsc shell, because each is missing what the other provides: jsc has
// print/quit and no console/process, node the reverse. Pinning either one has broken this harness
// twice — once with console.log under jsc, once with print under node — and both times it threw
// AFTER every assertion had run, so the pass count was never printed and the failure looked like a
// pack bug. The plugin code under test calls console.warn on its error paths, so `console` is
// shimmed rather than merely avoided here.
const say = typeof console !== "undefined" ? (m) => console.log(m) : print;
const die = () => (typeof process !== "undefined" ? process.exit(1) : quit(1));
if (typeof console === "undefined") {
  globalThis.console = { log: print, warn: print, error: print, info: print, debug: print };
}

const [searchPlugin, resolvePlugin, inviteLinkPlugin, postsPlugin, participantsPlugin, phoneLookupPlugin] = pack.plugins;
const ok = [];
const fail = [];
function check(name, cond) { (cond ? ok : fail).push(name); }

function makeGraph(nodeById, createdNodes, createdEdges, updatedNodes) {
  return {
    async get(id) { return nodeById[id] || null; },
    async createNode(draft) {
      const node = { id: `n${createdNodes.length + 1}`, type: draft.type, data: draft.data, key: draft.key };
      createdNodes.push(node);
      return node;
    },
    async updateNode(id, data) { updatedNodes.push({ id, data }); },
    async createEdge(edge) { createdEdges.push(edge); },
  };
}

// respond(path, body) -> response payload.
//
// There is no `auth` argument any more, and that is the point: the pack holds no credential. The
// analyst's Vineyard token is attached by the host, and the auxiliary gateway swaps it for
// tgpeek's own only after authenticating that analyst — so the strongest thing this harness can
// assert about credentials is that the pack sends NONE.
// The pack no longer knows an address. It names a SERVICE, and the host resolves it — so what the
// harness asserts changed with it: that the name is "telegram" and nothing else, that the path is
// service-relative (no leading slash to climb out of the mount with), and that the pack sends no
// credential of its own. There is no token for it to send any more; the gateway attaches tgpeek's
// after authenticating the analyst, and a pack that still tried would be sending a header the
// gateway overwrites.
function makeService(respond) {
  return async (name, path, init) => {
    check(`service is "telegram", not ${name}`, name === "telegram");
    check(`path is service-relative: ${path}`, !path.startsWith("/") && !path.includes(".."));
    const headers = init?.headers || {};
    const sent = Object.keys(headers).map((k) => k.toLowerCase());
    check("pack sends no Authorization of its own", !sent.includes("authorization"));
    check("pack sends no legacy gateway token", !sent.includes("x-tgpeek-token"));
    const body = JSON.parse(init.body);
    // Assertions below stay written as "/search" — the leading slash is the harness's, not the
    // pack's, so an accidental absolute path in the pack still fails the check above.
    return { ok: true, status: 200, async text() { return "{}"; }, async json() { return respond("/" + path, body, null); } };
  };
}

// ---------------------------------------------------------------- search
{
  const createdNodes = [];
  const createdEdges = [];
  const ctx = {
    input: { selection: [] },
    params: { query: "python", limit: 10 },
    graph: makeGraph({}, createdNodes, createdEdges),
    service: makeService((path, body, auth) => {
      check("search path=/search", path === "/search");
      check("search query passed", body.query === "python");
      check("search limit passed", body.limit === 10);
      return {
        results: [
          { id: 100, kind: "channel", username: "pyc", usernames: ["pyc", "pychannel"], title: "Py Channel" },
          { id: 200, kind: "supergroup", username: "pyg", title: "Py Group" },
          { id: 300, kind: "bot", username: "pybot", title: "Py Bot", is_bot: true },
          { id: 400, kind: "user", username: "pyuser", title: "Py User" },
        ],
      };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await searchPlugin.run(ctx);
  check("search collected=4", result.counts.collected === 4);
  check("search errors=0", result.counts.errors === 0);
  check("search: channel node", createdNodes.some(n => n.type === "telegram.channel" && n.data.username === "pyc"));
  check(
    "search: multi-username joined one-per-line",
    createdNodes.some(n => n.type === "telegram.channel" && n.data.usernames === "pyc\npychannel"),
  );
  check(
    "search: single/absent usernames -> field omitted",
    createdNodes.find(n => n.data.username === "pyg").data.usernames === undefined,
  );
  check("search: group node (supergroup→group)", createdNodes.some(n => n.type === "telegram.group" && n.data.username === "pyg"));
  check("search: bot→user.is_bot", createdNodes.some(n => n.type === "telegram.user" && n.data.username === "pybot" && n.data.is_bot === true));
  check("search: user node", createdNodes.some(n => n.type === "telegram.user" && n.data.username === "pyuser"));
}

// --------------------------------------------------------------- resolve
{
  const createdNodes = [];
  const createdEdges = [];
  const updatedNodes = [];
  const calls = [];
  const ctx = {
    input: { selection: ["u1", "u2", "u3", "u4", "tg1", "hd1", "hd2"] },
    graph: makeGraph({
      u1: { id: "u1", type: "web.url", data: { url: "https://t.me/pythonkr" } },
      u2: { id: "u2", type: "web.url", data: { url: "https://t.me/+AbCdEfGh" } },
      u3: { id: "u3", type: "web.url", data: { url: "https://example.com/x" } },
      u4: { id: "u4", type: "web.url", data: { url: "https://t.me/s/HanaResearch" } },
      tg1: { id: "tg1", type: "telegram.user", data: { telegram_id: 500, username: "lightuser" } },
      hd1: { id: "hd1", type: "identity.handle", data: { handle: "@somehandle" } },
      hd2: { id: "hd2", type: "identity.handle", data: { handle: "not a handle!!" } },
    }, createdNodes, createdEdges, updatedNodes),
    service: makeService((path, body) => {
      check("resolve path=/resolve", path === "/resolve");
      calls.push(body.target);
      if (body.target === "pythonkr") {
        return {
          id: 1554525468, kind: "channel", username: "pythonkr", usernames: ["pythonkr"],
          display_name: "Python Korea", about: "파이썬", participants_count: 99999, verified: false,
        };
      }
      if (body.target.toLowerCase() === "hanaresearch") {
        return { id: 1147595657, kind: "channel", username: "HanaResearch", display_name: "하나증권 리서치", about: "리서치", participants_count: 24475, verified: false };
      }
      if (body.target === "lightuser") {
        return { id: 500, kind: "user", username: "lightuser", display_name: "Light User", about: "full bio", participants_count: null, is_bot: false };
      }
      return { id: 900, kind: "user", username: "somehandle", display_name: "Some Handle" };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await resolvePlugin.run(ctx);
  check("resolve processed=4", result.counts.processed === 4);
  check("resolve collected=4", result.counts.collected === 4);
  check("resolve skipped=3 (invite URL, non-tg URL, invalid handle)", result.counts.skipped === 3);
  check("resolve errors=0", result.counts.errors === 0);
  check("resolve: URL → 추출된 username 전달", calls.includes("pythonkr") && calls.some(t => t.toLowerCase() === "hanaresearch"));
  check("resolve: telegram.* 노드 → username 전달", calls.includes("lightuser"));
  check("resolve: identity.handle → @ 제거 후 전달", calls.includes("somehandle"));

  const chat = createdNodes.find(n => n.type === "telegram.channel" && n.data.username === "pythonkr");
  check("resolve: chat node (URL 입력)", !!chat);
  check("resolve: about stored", chat && chat.data.about === "파이썬");
  check("resolve: participants_count stored", chat && chat.data.participants_count === 99999);
  check("resolve: links_to evidence edge (URL)", createdEdges.some(e => e.from === "u1" && e.label === "links to"));
  check("resolve: t.me/s/ URL → 노드 생성", createdNodes.some(n => n.type === "telegram.channel" && n.data.username === "HanaResearch"));
  check("resolve: t.me/s/ URL → links_to", createdEdges.some(e => e.from === "u4" && e.label === "links to"));

  const upd = updatedNodes.find(u => u.id === "tg1");
  check("resolve: telegram.* 입력 → updateNode in-place", !!upd);
  check("resolve: updateNode에 bio 채움 (기존 필드 보존)", upd && upd.data.bio === "full bio" && upd.data.telegram_id === 500);

  const hdChat = createdNodes.find(n => n.type === "telegram.user" && n.data.username === "somehandle");
  check("resolve: identity.handle → user 노드 생성", !!hdChat);
  check("resolve: identity.handle → same-as 엣지", createdEdges.some(e => e.label === "same as" && e.from === hdChat.id && e.to === "hd1"));
}

// -------------------------------------------------- resolve 타입 가드 (mismatch)
{
  const createdNodes = [];
  const createdEdges = [];
  const updatedNodes = [];
  const ctx = {
    input: { selection: ["bad_user", "bad_channel", "bad_group", "bot_ok", "bot_rev", "num_ok", "num_bad"] },
    graph: makeGraph({
      // 유형 불일치: 노드 타입과 실제 엔티티 kind가 다름
      bad_user: { id: "bad_user", type: "telegram.user", data: { telegram_id: 1147595657, username: "HanaResearch" } },
      bad_channel: { id: "bad_channel", type: "telegram.channel", data: { telegram_id: 500, username: "lightuser" } },
      bad_group: { id: "bad_group", type: "telegram.group", data: { telegram_id: 300, username: "somehandle" } },
      // user↔bot 전환은 허용 (is_bot 플래그 갱신)
      bot_ok: { id: "bot_ok", type: "telegram.user", data: { telegram_id: 601, username: "botlike" } },
      bot_rev: { id: "bot_rev", type: "telegram.user", data: { telegram_id: 602, username: "humank" } },
      // numeric 폴백: username 없음 + telegram_id만
      num_ok: { id: "num_ok", type: "telegram.channel", data: { telegram_id: 1554525468 } },
      num_bad: { id: "num_bad", type: "telegram.user", data: { telegram_id: 1554525468 } },
    }, createdNodes, createdEdges, updatedNodes),
    service: makeService((path, body) => {
      check("type-guard path=/resolve", path === "/resolve");
      if (body.target === "HanaResearch" || body.target === "1554525468") {
        return { id: 1147595657, kind: "channel", username: "HanaResearch", display_name: "하나증권" };
      }
      if (body.target === "lightuser") {
        return { id: 500, kind: "user", username: "lightuser", display_name: "Light" };
      }
      if (body.target === "somehandle") {
        return { id: 300, kind: "user", username: "somehandle", display_name: "Some" };
      }
      if (body.target === "botlike") {
        return { id: 601, kind: "bot", username: "botlike", display_name: "Bot Like", is_bot: true };
      }
      if (body.target === "humank") {
        return { id: 602, kind: "user", username: "humank", display_name: "Human", is_bot: false };
      }
      throw new Error("unexpected target: " + body.target);
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await resolvePlugin.run(ctx);
  check("type-guard processed=7", result.counts.processed === 7);
  check("type-guard collected=3 (bot_ok, bot_rev, num_ok)", result.counts.collected === 3);
  check("type-guard skipped=4 (불일치 3 + num_bad)", result.counts.skipped === 4);
  check("type-guard errors=0", result.counts.errors === 0);

  const updated = updatedNodes.map(u => u.id);
  check("type-guard: user 노드 + 채널 엔티티 → 미갱신", !updated.includes("bad_user"));
  check("type-guard: channel 노드 + user 엔티티 → 미갱신", !updated.includes("bad_channel"));
  check("type-guard: group 노드 + user 엔티티 → 미갱신", !updated.includes("bad_group"));
  check("type-guard: user 노드 + bot 엔티티 → 갱신(is_bot=true)", updated.includes("bot_ok") && updatedNodes.find(u => u.id === "bot_ok").data.is_bot === true);
  check("type-guard: bot 노드 + user 엔티티 → 갱신(is_bot=false)", updated.includes("bot_rev") && updatedNodes.find(u => u.id === "bot_rev").data.is_bot === false);
  check("type-guard: numeric 폴백 채널 → 갱신", updated.includes("num_ok"));
  check("type-guard: numeric 폴백 + 타입 불일치(user 노드 + 채널 id) → 미갱신", !updated.includes("num_bad"));
}

// ----------------------------------------------------- invite_link (분석)
{
  const createdNodes = [];
  const createdEdges = [];
  const ctx = {
    input: { selection: ["i1", "i2", "i3"] },
    params: {},
    graph: makeGraph({
      i1: { id: "i1", type: "web.url", data: { url: "https://t.me/+AbCdEfGh" } },
      i2: { id: "i2", type: "web.url", data: { url: "https://t.me/pythonkr" } },
      i3: { id: "i3", type: "web.url", data: { url: "https://example.com/x" } },
    }, createdNodes, createdEdges),
    service: makeService((path, body) => {
      check("invite analysis path=/invite-link", path === "/invite-link");
      check("invite analysis: no is_collect_mode", !body.is_collect_mode);
      check("invite analysis link=URL", body.link === "https://t.me/+AbCdEfGh");
      return { kind: "group", title: "Secret Group", username: "secretg", participants_count: 12, is_public: false, peek: false, expires: null };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await inviteLinkPlugin.run(ctx);
  check("invite analysis processed=1", result.counts.processed === 1);
  check("invite analysis collected=1", result.counts.collected === 1);
  check("invite analysis skipped=2 (handle + non-tg no-op)", result.counts.skipped === 2);
  const group = createdNodes.find(n => n.type === "telegram.group");
  check("invite analysis: group node", !!group);
  check("invite analysis: invite_hash", group && group.data.invite_hash === "AbCdEfGh");
  check("invite analysis: peek=false stored", group && group.data.peek === false);
  check("invite analysis: links_to", createdEdges.some(e => e.from === "i1" && e.label === "links to"));
}

// ------------------------------------------- invite_link (collect_mode)
// ----------------------------------------------------------------- posts
{
  const createdNodes = [];
  const createdEdges = [];
  const calls = [];
  const ctx = {
    input: { selection: ["ch1", "grp1", "iv1", "other"] },
    params: { limit: 5 },
    graph: makeGraph({
      ch1: { id: "ch1", type: "telegram.channel", data: { telegram_id: 111111, username: "chan1" } },
      grp1: { id: "grp1", type: "telegram.group", data: { telegram_id: 222222, username: "" } },
      iv1: { id: "iv1", type: "web.url", data: { url: "https://t.me/+ZzZz" } },
      other: { id: "other", type: "web.url", data: { url: "https://example.com/x" } },
    }, createdNodes, createdEdges),
    service: makeService((path, body) => {
      calls.push([path, body.target, body]);
      if (body.target === "chan1") {
        return { source: "public", info: { id: 111111, kind: "channel", title: "Chan 1", username: "chan1" }, posts: [{ id: 1, text: "one" }] };
      }
      if (body.target === "222222") {
        return { source: "public", info: { id: 222222, kind: "supergroup", title: "Grp 1" }, posts: [{ id: 2, text: "two" }] };
      }
      return {
        source: "invite",
        info: { kind: "channel", title: "Invite Chan", username: "invchan", peek: true, expires: 42 },
        posts: [{ id: 7, text: "peeked" }],
        peeked: true,
        expires: 42,
      };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await postsPlugin.run(ctx);
  check("posts processed=4", result.counts.processed === 4);
  check("posts collected=3", result.counts.collected === 3);
  check("posts skipped=1 (non-tg url no-op)", result.counts.skipped === 1);
  check("posts errors=0", result.counts.errors === 0);
  check("posts targets: username 우선, numeric fallback, invite URL", calls.some(c => c[0] === "/posts" && c[1] === "chan1") && calls.some(c => c[0] === "/posts" && c[1] === "222222") && calls.some(c => c[0] === "/posts" && c[1] === "https://t.me/+ZzZz"));
  check("posts: post nodes x3", createdNodes.filter(n => n.type === "telegram.post").length === 3);
  check("posts limit=5 from params", calls.every(c => c[2].limit === 5));
  // 회귀 가드: 예전에는 config 블록 하나를 두 플러그인이 공유해서, posts 요청에
  // participants_limit 이, participants 요청에 posts 의 limit 이 같이 실려 나갔다.
  check("posts: participants_limit 안 보냄", calls.every(c => c[2].participants_limit === undefined));
  check("posts: edges to input node (no chat recreate)", createdEdges.some(e => e.label === "posted in" && e.to === "ch1") && createdEdges.some(e => e.label === "posted in" && e.to === "grp1"));
  check("posts: invite chat created + links_to", createdNodes.some(n => n.type === "telegram.channel" && n.data.username === "invchan") && createdEdges.some(e => e.from === "iv1" && e.label === "links to"));
  check("posts: no participant edges", !createdEdges.some(e => e.label === "participant of"));
}

// ---------------------------------------------------------- participants
{
  const createdNodes = [];
  const createdEdges = [];
  const calls = [];
  const ctx = {
    input: { selection: ["grp1", "ch1"] },
    params: { limit: 50 },
    graph: makeGraph({
      grp1: { id: "grp1", type: "telegram.group", data: { telegram_id: 222222, username: "pyg" } },
      ch1: { id: "ch1", type: "telegram.channel", data: { telegram_id: 111111, username: "chan1" } },
    }, createdNodes, createdEdges),
    service: makeService((path, body) => {
      calls.push([path, body.target]);
      check("participants path=/participants", path === "/participants");
      // params.limit 은 이 엔드포인트가 읽는 이름(participants_limit)으로 바뀌어 나가야 한다
      check("participants limit=50", body.participants_limit === 50);
      check("participants: posts 의 limit 안 보냄", body.limit === undefined);
      return {
        info: { id: 222222, kind: "supergroup", title: "Py Group" },
        participants: [
          { user_id: 333, username: "m1", first_name: "M1" },
          { user_id: 444, username: "m2", first_name: "M2", is_admin: true },
        ],
        participants_available: true,
      };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await participantsPlugin.run(ctx);
  check("participants processed=1", result.counts.processed === 1);
  check("participants collected=1", result.counts.collected === 1);
  check("participants skipped=1 (channel)", result.counts.skipped === 1);
  check("participants target=username", calls.some(c => c[1] === "pyg"));
  check("participants: user nodes x2", createdNodes.filter(n => n.type === "telegram.user").length === 2);
  check("participants: participant_of x2", createdEdges.filter(e => e.label === "participant of").length === 2);
  check("participants: admin_of x1", createdEdges.filter(e => e.label === "admin of").length === 1);
}

// ------------------------------------------------------------ phone lookup
{
  const createdNodes = [];
  const createdEdges = [];
  const calls = [];
  const ctx = {
    input: { selection: ["pn1", "pn2", "other"] },
    graph: makeGraph({
      pn1: { id: "pn1", type: "identity.phone_number", data: { number: "+821012345678" } },
      pn2: { id: "pn2", type: "identity.phone_number", data: { number: "+82990000000" } },
      other: { id: "other", type: "web.url", data: { url: "https://example.com" } },
    }, createdNodes, createdEdges),
    service: makeService((path, body) => {
      calls.push([path, body.phone]);
      check("phone path=/phone-lookup", path === "/phone-lookup");
      if (body.phone === "+821012345678") {
        return { found: true, phone: body.phone, info: { id: 555, kind: "user", username: "someone", display_name: "Someone", is_bot: false } };
      }
      return { found: false, phone: body.phone, info: null };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await phoneLookupPlugin.run(ctx);
  check("phone processed=2", result.counts.processed === 2);
  check("phone collected=1", result.counts.collected === 1);
  check("phone skipped=2 (not found + wrong type)", result.counts.skipped === 2);
  check("phone errors=0", result.counts.errors === 0);
  check("phone: user node created", createdNodes.some(n => n.type === "telegram.user" && n.data.username === "someone"));
  check("phone: same-as edge to phone node", createdEdges.some(e => e.label === "same as" && e.from === createdNodes.find(n => n.type === "telegram.user").id && e.to === "pn1"));
}

// -------------------------------------------------------- how a failed run ENDS
// The bug this covers: every plugin caught its per-item errors, counted them, and RETURNED. The
// host renders a returned summary as a green "succeeded" — and when the run staged nothing, the
// toast reads "No changes". So a gateway that was down looked exactly like a handle with no
// Telegram account. What follows pins the three endings apart.
{
  // Minimal service double: fixed status, no assertions — the credential assertions in
  // makeService() are about a request that gets made, and half of these never get that far.
  const failing = (plan) => {
    const calls = [];
    const fn = async (_name, path, init) => {
      calls.push(path);
      const step = plan[Math.min(calls.length - 1, plan.length - 1)];
      return {
        ok: step.status < 400,
        status: step.status,
        async text() { return step.body ?? "gateway down"; },
        async json() { return step.json ?? {}; },
      };
    };
    fn.calls = calls;
    return fn;
  };
  const twoHandles = () => ({
    input: { selection: ["h1", "h2"] },
    graph: makeGraph({
      h1: { id: "h1", type: "identity.handle", data: { handle: "alpha_one" } },
      h2: { id: "h2", type: "identity.handle", data: { handle: "beta_two" } },
    }, [], [], []),
  });
  const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

  // 1. Everything failed -> the run FAILS, carrying the real message. Not "0 resolved".
  {
    const ctx = { ...twoHandles(), service: failing([{ status: 502 }]) };
    const msg = await caught(() => resolvePlugin.run(ctx));
    check("all-fail: run throws instead of returning a green summary", msg !== null);
    check("all-fail: message is the gateway's, not a tally", (msg || "").includes("502"));
    check("all-fail: both items were still attempted", ctx.service.calls.length === 2);
  }

  // 2. Partial -> still a success (one handle DID resolve), but the failure is in the summary
  //    rather than hidden behind a count the analyst cannot act on.
  {
    const ctx = {
      ...twoHandles(),
      service: failing([
        { status: 500, body: "upstream exploded" },
        { status: 200, json: { id: 7, kind: "user", username: "beta_two", display_name: "Beta" } },
      ]),
    };
    const res = await resolvePlugin.run(ctx);
    check("partial: does not throw", !!res);
    check("partial: counts one collected", res.counts.collected === 1 && res.counts.errors === 1);
    check("partial: summary names the error", res.summary.includes("first error") && res.summary.includes("500"));
  }

  // 3. A dead session is dead for the whole selection. Stop at the first 401 instead of spending
  //    the other forty-nine attempts printing the same thing.
  {
    const ctx = { ...twoHandles(), service: failing([{ status: 401 }]) };
    const msg = await caught(() => resolvePlugin.run(ctx));
    check("401: run fails", (msg || "").includes("session expired"));
    check("401: sweep stops at the first one", ctx.service.calls.length === 1);
  }
  {
    const ctx = { ...twoHandles(), service: failing([{ status: 403 }]) };
    const msg = await caught(() => resolvePlugin.run(ctx));
    check("403: run fails and stops", (msg || "").includes("not permitted") && ctx.service.calls.length === 1);
  }

  // 4. THE NEGATIVE. An honest empty answer must stay a success — otherwise the fix trades a
  //    silent failure for a false alarm, which is the worse of the two.
  {
    const nothing = failing([{ status: 200, json: { found: false } }]);
    const ctx = {
      input: { selection: ["p1"] },
      graph: makeGraph({ p1: { id: "p1", type: "identity.phone_number", data: { number: "+821000000000" } } }, [], [], []),
      service: nothing,
    };
    const res = await phoneLookupPlugin.run(ctx);
    check("no-result: a number with no account is NOT a failure", !!res && res.counts.errors === 0);
    check("no-result: it is reported as skipped", res.counts.skipped === 1);
  }
  {
    // Same for a selection this plugin does not handle: nothing attempted, nothing failed.
    const ctx = {
      input: { selection: ["x1"] },
      graph: makeGraph({ x1: { id: "x1", type: "web.url", data: { url: "https://example.com" } } }, [], [], []),
      service: failing([{ status: 200 }]),
    };
    const res = await resolvePlugin.run(ctx);
    check("no-op input: still a success", !!res && res.counts.skipped === 1 && res.counts.errors === 0);
  }

  // 5. Single-shot search has nothing to keep going for — the error just propagates.
  {
    const ctx = { params: { query: "kimsuky" }, graph: makeGraph({}, [], [], []), service: failing([{ status: 503 }]) };
    const msg = await caught(() => searchPlugin.run(ctx));
    check("search: a failed search fails the run", (msg || "").includes("503"));
  }

  // 6. No service at all is a broken install, not an empty answer.
  for (const p of pack.plugins) {
    const ctx = { params: { query: "x" }, input: { selection: [] }, graph: makeGraph({}, [], [], []) };
    const msg = await caught(() => p.run(ctx));
    check(`${p.manifest.identifier.split(".").pop()}: missing ctx.service throws`, (msg || "").includes("ctx.service"));
  }
}

say("pack: " + pack.manifest.identifier + " | plugins: " + pack.plugins.map(p => p.manifest.identifier.split(".").pop()).join(","));

// ---------------------------------------------------------------- the declaration itself
// The JSON manifest is what the registry validates; the bundle's copy is what the worker runs. A
// scope changed in one and not the other is a pack that passes review and then cannot work — and
// this pack has exactly the scope where that matters, because `services` is what decides whether
// the host attaches a credential at all.
{
  const json = JSON.parse(readFileSync(new URL("./plugins/telegram.manifest.json", import.meta.url)));
  check("manifest versions agree", json.version === pack.manifest.version);
  check("member count agrees", json.plugins.length === pack.plugins.length);
  for (let i = 0; i < json.plugins.length; i++) {
    const a = json.plugins[i];
    const b = pack.plugins[i].manifest;
    check(`${a.identifier}: identifiers agree`, a.identifier === b.identifier);
    // Key ORDER is not part of the declaration, so compare on sorted keys — otherwise the check
    // fails on a reordering that changes nothing and stops being trusted.
    const stable = (v) => JSON.stringify(v, (_k, x) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
        : x);
    check(`${a.identifier}: scopes agree`, stable(a.scopes) === stable(b.scopes));
    check(`${a.identifier}: declares the telegram service`, JSON.stringify(a.scopes.services) === '["telegram"]');
    check(`${a.identifier}: declares NO arbitrary egress`, !("network" in a.scopes));
    const cfg = (a.scopes.config || []).map((c) => c.key);
    check(`${a.identifier}: no gateway token to hold`, !cfg.includes("gateway_token"));
  }
}

say(`PASS ${ok.length} / ${ok.length + fail.length}`);

// Exit non-zero on failure, or the harness reports a red result with a green exit code and
// nothing that runs it automatically ever notices.
if (fail.length) {
  say("FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
  die();
}
