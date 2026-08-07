// Functional test harness for pluginpack-telegram/dist/pack.mjs (5 plugins).
// Run: jsc -m pluginpack-telegram/test-plugin.mjs
import pack from "./dist/pack.mjs";

const [searchPlugin, resolvePlugin, inviteLinkPlugin, postsPlugin, participantsPlugin] = pack.plugins;
const ok = [];
const fail = [];
function check(name, cond) { (cond ? ok : fail).push(name); }

function makeGraph(nodeById, createdNodes, createdEdges) {
  return {
    async get(id) { return nodeById[id] || null; },
    async createNode(draft) {
      const node = { id: `n${createdNodes.length + 1}`, type: draft.type, data: draft.data, key: draft.key };
      createdNodes.push(node);
      return node;
    },
    async createEdge(edge) { createdEdges.push(edge); },
  };
}

// respond(body, auth) -> response payload; path is the request path.
function makeNet(respond) {
  return {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const auth = (init.headers && init.headers.Authorization) || null;
      return { ok: true, status: 200, async text() { return "{}"; }, async json() { return respond(path, body, auth); } };
    },
  };
}

// ---------------------------------------------------------------- search
{
  const createdNodes = [];
  const createdEdges = [];
  const ctx = {
    input: { selection: [] },
    params: { query: "python", limit: 10 },
    config: { gateway_token: "tok" },
    graph: makeGraph({}, createdNodes, createdEdges),
    net: makeNet((path, body, auth) => {
      check("search path=/search", path === "/search");
      check("search auth header", auth === "Bearer tok");
      check("search query passed", body.query === "python");
      check("search limit passed", body.limit === 10);
      return {
        results: [
          { id: 100, kind: "channel", username: "pyc", title: "Py Channel" },
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
  check("search: group node (supergroup→group)", createdNodes.some(n => n.type === "telegram.group" && n.data.username === "pyg"));
  check("search: bot→user.is_bot", createdNodes.some(n => n.type === "telegram.user" && n.data.username === "pybot" && n.data.is_bot === true));
  check("search: user node", createdNodes.some(n => n.type === "telegram.user" && n.data.username === "pyuser"));
}

// --------------------------------------------------------------- resolve
{
  const createdNodes = [];
  const createdEdges = [];
  const ctx = {
    input: { selection: ["u1", "u2", "u3"] },
    config: { gateway_token: "tok" },
    graph: makeGraph({
      u1: { id: "u1", type: "web.url", data: { url: "https://t.me/pythonkr" } },
      u2: { id: "u2", type: "web.url", data: { url: "https://t.me/+AbCdEfGh" } },
      u3: { id: "u3", type: "web.url", data: { url: "https://example.com/x" } },
    }, createdNodes, createdEdges),
    net: makeNet((path, body) => {
      check("resolve path=/resolve", path === "/resolve");
      check("resolve target=URL 그대로", body.target === "https://t.me/pythonkr");
      return { id: 1554525468, kind: "channel", username: "pythonkr", display_name: "Python Korea", about: "파이썬", participants_count: 99999, verified: false };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await resolvePlugin.run(ctx);
  check("resolve processed=1", result.counts.processed === 1);
  check("resolve collected=1", result.counts.collected === 1);
  check("resolve skipped=2 (invite + non-tg no-op)", result.counts.skipped === 2);
  check("resolve errors=0", result.counts.errors === 0);
  const chat = createdNodes.find(n => n.type === "telegram.channel");
  check("resolve: chat node", !!chat);
  check("resolve: about stored", chat && chat.data.about === "파이썬");
  check("resolve: participants_count stored", chat && chat.data.participants_count === 99999);
  check("resolve: links_to evidence edge", createdEdges.some(e => e.from === "u1" && e.label === "links to"));
}

// ----------------------------------------------------- invite_link (분석)
{
  const createdNodes = [];
  const createdEdges = [];
  const ctx = {
    input: { selection: ["i1", "i2", "i3"] },
    config: { gateway_token: "tok" },
    params: {},
    graph: makeGraph({
      i1: { id: "i1", type: "web.url", data: { url: "https://t.me/+AbCdEfGh" } },
      i2: { id: "i2", type: "web.url", data: { url: "https://t.me/pythonkr" } },
      i3: { id: "i3", type: "web.url", data: { url: "https://example.com/x" } },
    }, createdNodes, createdEdges),
    net: makeNet((path, body) => {
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
{
  const createdNodes = [];
  const createdEdges = [];
  const ctx = {
    input: { selection: ["i1"] },
    config: { gateway_token: "tok", posts_limit: 5, participants_limit: 10 },
    params: { collect_mode: true },
    graph: makeGraph({ i1: { id: "i1", type: "web.url", data: { url: "https://t.me/+AbCdEfGh" } } }, createdNodes, createdEdges),
    net: makeNet((path, body) => {
      check("invite collect path=/invite-link", path === "/invite-link");
      check("invite collect is_collect_mode=true", body.is_collect_mode === true);
      check("invite collect limit=5", body.limit === 5);
      return {
        source: "invite",
        info: { kind: "group", title: "Test Group", participants_count: 5, username: "testgroup", megagroup: true, peek: true, expires: 9999999999 },
        posts: [
          { id: 10, text: "hello", date: "2026-01-01T00:00:00+00:00", views: 3 },
          { id: 11, text: "reply", reply_to_msg_id: 10 },
        ],
        participants: [
          { user_id: 111, username: "alice", first_name: "Alice", is_admin: true },
          { user_id: 222, username: "bob", first_name: "Bob", is_bot: false },
        ],
        participants_available: false,
        peeked: true,
        expires: 9999999999,
      };
    }),
    progress: { set() {} },
    signal: { aborted: false },
  };

  const result = await inviteLinkPlugin.run(ctx);
  check("invite collect processed=1", result.counts.processed === 1);
  check("invite collect collected=1", result.counts.collected === 1);
  const group = createdNodes.find(n => n.type === "telegram.group");
  check("invite collect: group node", !!group);
  check("invite collect: invite_hash", group && group.data.invite_hash === "AbCdEfGh");
  check("invite collect: peek=true stored", group && group.data.peek === true);
  check("invite collect: posted_in x2", createdEdges.filter(e => e.label === "posted in").length === 2);
  check("invite collect: replied_to", createdEdges.some(e => e.label === "replied to"));
  check("invite collect: participant_of x2", createdEdges.filter(e => e.label === "participant of").length === 2);
  check("invite collect: admin_of x1", createdEdges.filter(e => e.label === "admin of").length === 1);
}

// ----------------------------------------------------------------- posts
{
  const createdNodes = [];
  const createdEdges = [];
  const calls = [];
  const ctx = {
    input: { selection: ["ch1", "grp1", "iv1", "other"] },
    config: { gateway_token: "tok" },
    graph: makeGraph({
      ch1: { id: "ch1", type: "telegram.channel", data: { telegram_id: 111111, username: "chan1" } },
      grp1: { id: "grp1", type: "telegram.group", data: { telegram_id: 222222, username: "" } },
      iv1: { id: "iv1", type: "web.url", data: { url: "https://t.me/+ZzZz" } },
      other: { id: "other", type: "web.url", data: { url: "https://example.com/x" } },
    }, createdNodes, createdEdges),
    net: makeNet((path, body) => {
      calls.push([path, body.target]);
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
    config: { gateway_token: "tok", participants_limit: 50 },
    graph: makeGraph({
      grp1: { id: "grp1", type: "telegram.group", data: { telegram_id: 222222, username: "pyg" } },
      ch1: { id: "ch1", type: "telegram.channel", data: { telegram_id: 111111, username: "chan1" } },
    }, createdNodes, createdEdges),
    net: makeNet((path, body) => {
      calls.push([path, body.target]);
      check("participants path=/participants", path === "/participants");
      check("participants limit=50", body.participants_limit === 50);
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

console.log("pack:", pack.manifest.identifier, "| plugins:", pack.plugins.map(p => p.manifest.identifier.split(".").pop()).join(","));
console.log(`PASS ${ok.length} / ${ok.length + fail.length}`);
// Exit non-zero on failure, or the harness reports a red result with a green exit code and
// nothing that runs it automatically ever notices.
if (fail.length) {
  console.error("FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
