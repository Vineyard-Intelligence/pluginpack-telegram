// Telegram — read-only Telegram reconnaissance via the tgpeek gateway.
//
// Five plugins mirror the gateway endpoints 1:1 so that both the AI agent and
// the analyst can run exactly the operation they need:
//   1. telegram_search       — global launch, keyword search -> telegram.* nodes
//   2. telegram_resolve      — web.url (t.me handle) -> chat/user node (info only)
//   3. telegram_invite_link  — web.url (invite) -> analysis, or full collection
//   4. telegram_posts        — web.url (invite) / channel/group node -> posts
//   5. telegram_participants — telegram.group node -> participant list
//
// Contract notes (read before editing):
// - Graph writes go through the staging store (capture:true at runtime) and are
//   applied by the analyst after review. This pack never writes outside staging.
// - Non-Telegram inputs are a strict no-op: nothing is created or modified.
// - The gateway is reached with ctx.service("telegram", …). The pack names a SERVICE, never a
//   URL: the host holds the address and attaches the analyst's Vineyard credential, so there is
//   no endpoint here to keep in sync and no token for a pack to hold.
// - Terminology: Telegram's canonical term is "participant" — the graph edges
//   are participant_of / admin_of. Never introduce "member".

// No gateway address and no gateway token live in this file any more.
//
// Both used to: the manifest pinned https://auxiliary.vineyard.run/telegram and the analyst pasted
// a shared server secret into `gateway_token`. `ctx.service("telegram", path)` removes both. The
// host owns the address — a pack cannot express a destination at all, which is what makes it safe
// for the call to carry the analyst's own identity — and the auxiliary gateway swaps that identity
// for tgpeek's bearer token only AFTER it has authenticated the analyst against api.vineyard.run.
// So the token every analyst used to hold is now held by one server, and asking for it back would
// be asking for a downgrade.

// ---- Telegram URL patterns -------------------------------------------------
const TG_JOIN_RE = /^(?:https?:\/\/)?(?:t|telegram)\.(?:me|dog)\/(?:joinchat\/|\+)[A-Za-z0-9_-]+(?:[?&#].*)?$/i;
const TG_URI_RE = /^tg:\/\/join\?invite=[A-Za-z0-9_-]+(?:[&#].*)?$/i;
const TG_HANDLE_RE = /^(?:https?:\/\/)?(?:t|telegram)\.(?:me|dog)\/(?:s\/)?([A-Za-z0-9_]+)(?:[?&#].*)?$/i;

// Returns { kind: "invite" | "handle" } when the URL is a supported Telegram
// pattern, otherwise null (caller must treat null as no-op).
function parseTelegramUrl(url) {
  const u = String(url).trim();
  if (TG_JOIN_RE.test(u) || TG_URI_RE.test(u)) return { kind: "invite" };
  if (TG_HANDLE_RE.test(u)) return { kind: "handle" };
  return null;
}

function extractInviteHash(url) {
  const m = String(url).match(/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const q = String(url).match(/tg:\/\/join\?invite=([A-Za-z0-9_-]+)/i);
  return q ? q[1] : null;
}

// Username from a t.me handle URL, including the t.me/s/ web-preview form.
// (Only called after parseTelegramUrl says kind === "handle", so joinchat/+
// URLs never reach it.)
function handleFromUrl(url) {
  const m = String(url).trim().match(/(?:t|telegram)\.(?:me|dog)\/(?:s\/)?([A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
}

// Primary handle of a telegram.* node: `username`, else the first line of `usernames`.
function nodeHandle(data) {
  const u = String((data && data.username) || "").trim();
  if (u) return u;
  const list = (data && data.usernames ? String(data.usernames) : "").split("\n").map((x) => x.trim()).filter(Boolean);
  return list[0] || null;
}

// Telegram username shape: starts with a letter, 3-32 chars, [A-Za-z0-9_].
const HANDLE_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;

// ---- mapping ---------------------------------------------------------------
function kindToType(kind) {
  if (kind === "channel") return "telegram.channel";
  if (kind === "supergroup" || kind === "group") return "telegram.group";
  if (kind === "user" || kind === "bot") return "telegram.user";
  return null;
}

function profileUrl(username) {
  return username ? `https://t.me/${username}` : undefined;
}

// EntityInfo / InviteInfo -> node data for the chat node.
// InviteInfo carries `peek`/`expires` (server-granted temporary read access).
function chatData(type, info, source, url) {
  const isUser = type === "telegram.user";
  const isGroup = type === "telegram.group";
  const data = {
    telegram_id: info.id != null ? info.id : undefined,
    username: info.username ?? undefined,
    // tgpeek's `username` is the primary handle; `usernames` is the full active list, since
    // Telegram's collectible/multi-username feature lets one entity hold several (see r3dbU7z /
    // durov-style accounts). One text field, one per line, matching social.media_urls' shape.
    usernames: Array.isArray(info.usernames) && info.usernames.length ? info.usernames.join("\n") : undefined,
    verified: info.verified ?? false,
    profile_url: profileUrl(info.username),
  };
  if (isUser) {
    data.display_name = info.display_name;
    data.bio = info.about;
    data.is_bot = info.is_bot ?? false;
  } else {
    data.title = info.display_name ?? info.title;
    data.about = info.about;
    data.participants_count = info.participants_count;
    if (info.peek != null) data.peek = info.peek;
    if (info.expires != null) data.expires = info.expires;
  }
  if (isGroup) {
    data.megagroup = info.megagroup ?? info.kind === "supergroup";
    if (source === "invite") {
      const hash = extractInviteHash(url);
      if (hash) data.invite_hash = hash;
    }
  }
  return data;
}

// PeerRef (search result) -> light node data.
function peerData(ref) {
  const type = kindToType(ref.kind);
  if (!type) return null;
  const data = {
    telegram_id: ref.id,
    username: ref.username ?? undefined,
    usernames: Array.isArray(ref.usernames) && ref.usernames.length ? ref.usernames.join("\n") : undefined,
  };
  if (type === "telegram.user") {
    data.display_name = ref.title;
    data.is_bot = ref.is_bot ?? false;
    data.profile_url = profileUrl(ref.username);
  } else {
    data.title = ref.title;
    data.profile_url = profileUrl(ref.username);
  }
  return { type, data };
}

// ---- gateway plumbing ------------------------------------------------------
// No address and no token. `ctx.service("telegram", …)` names a SERVICE; the host holds its URL
// and attaches the analyst's own Vineyard credential, and the gateway in front of tgpeek swaps
// that for tgpeek's bearer token after it has authenticated the analyst. So there is nothing here
// for a pack to configure, and — more to the point — nothing for it to leak. The old
// `gateway_token` asked every analyst to hold a shared server secret; that key is gone.
//
/**
 * The per-run cap is a PARAMETER, not a setting.
 *
 * "How many to pull this time" is a decision the analyst makes at launch, and the pre-run form
 * already collects it — `telegram_search.limit` has always worked that way. It used to live in
 * `scopes.config`, and worse, ONE config block was pasted into both plugins: Posts advertised a
 * participants knob, Participants advertised a posts knob, and each spread the whole object onto
 * the wire, so a "Max posts" value rode along on /participants.
 *
 * The wire names really do differ — /posts reads `limit`, /participants reads `participants_limit`
 * — so the caller names the field it needs. That mismatch belongs here, not in the analyst's form,
 * which is why both plugins expose the same plain `limit` param.
 */
function runLimit(ctx, wireKey) {
  const v = (ctx.params || {}).limit;
  if (v == null || v === "") return {}; // blank = no cap, the gateway returns everything
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? { [wireKey]: n } : {};
}

// `fatal` marks a failure that the rest of the selection cannot recover from — a dead session is
// dead for node 2 through 50 as well, and retrying it forty-nine times just spends the analyst's
// time to print the same message. The per-item catch below re-throws these.
class ServiceError extends Error {
  constructor(message, fatal = false) {
    super(message);
    this.name = "ServiceError";
    this.fatal = fatal;
  }
}

async function postJson(ctx, path, body) {
  const res = await ctx.service("telegram", path.replace(/^\/+/, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    // Not tgpeek refusing — the Vineyard session behind the call ended. Say which.
    throw new ServiceError("your session expired — sign in again and re-run", true);
  }
  if (res.status === 403) {
    throw new ServiceError("this Vineyard account is not permitted to use the Telegram service", true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ServiceError(`telegram service ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// How a run ENDS, and the reason this file has a helper for it.
//
// The host renders a THROWN error in red on the run's row, with its message. A RETURNED summary is
// always a green "succeeded", however grim the text — and when the run staged nothing, the toast
// does not even show the summary, it shows "No changes". So catching every error, counting it, and
// returning `Resolved 0 handle(s); 0 skipped, 3 error(s)` — which is what this pack used to do —
// made a gateway that was down indistinguishable from three handles that simply have no Telegram
// account. Both read as a quiet green success.
//
// Per-item catching stays: one unreachable handle must not abandon the other forty-nine. What
// changes is the ending — if NOTHING was collected and something failed, the run failed, and the
// analyst gets the first real error message rather than a tally. A partial run still succeeds, but
// carries that message in its summary instead of a number nobody can act on.
function finish(summary, counts, firstError) {
  if (firstError && !counts.collected) throw new Error(firstError);
  return { summary: firstError ? `${summary} — first error: ${firstError}` : summary, counts };
}

// Uniform per-item catch: record the first real message, and let a fatal one end the sweep.
function noteError(counts, state, e) {
  if (e && e.fatal) throw e;
  counts.errors++;
  state.firstError ??= e && e.message ? String(e.message) : String(e);
}

// A build with no `ctx.service` cannot reach the gateway at all. That is a broken install, not an
// empty result, so it throws rather than returning a summary nobody would read as a problem.
function requireService(ctx) {
  if (!ctx.service) {
    throw new Error("this Vineyard build does not offer the Telegram service (ctx.service) — update the app");
  }
}

// ---- materialization -------------------------------------------------------
// Create (or reuse) the chat node for an info payload; when a source web.url
// node is given, link it as evidence (links to). info is an EntityInfo or
// InviteInfo dict (flat, as returned by the gateway). ``source`` is "invite"
// for invite-link flows (groups get invite_hash) or "public" otherwise.
//
// ``label`` overrides the edge wording, and exists for one caller: resolving an
// identity.handle. "links to" is evidence wording for a URL that mentions a chat,
// and it is wrong for a handle — see the resolve plugin for why the difference
// matters enough to be a parameter.
async function ensureChat(ctx, sourceNodeId, url, info, source = "public", label = "links to") {
  const type = kindToType(info.kind);
  if (!type) return null;
  const key = info.id != null ? `telegram:${type}:${info.id}` : undefined;
  const chat = await ctx.graph.createNode({
    type,
    data: chatData(type, info, source, url),
    key,
  });
  if (sourceNodeId) {
    await ctx.graph.createEdge({ from: sourceNodeId, to: chat.id, label });
  }
  return chat;
}

// posts -> telegram.post nodes + edges (posted in / replied to).
async function materializePosts(ctx, chatNodeId, info, posts) {
  const postNodes = new Map(); // message_id -> node id
  for (const p of posts) {
    const post = await ctx.graph.createNode({
      type: "telegram.post",
      data: {
        telegram_id: info.id != null ? info.id : undefined,
        message_id: p.id,
        text: p.text ?? "",
        date: p.date ?? undefined,
        sender_id: p.sender_id ?? undefined,
        media_kind: p.media_kind ?? undefined,
        views: p.views ?? undefined,
        forwards: p.forwards ?? undefined,
        reply_to_message_id: p.reply_to_msg_id ?? undefined,
        url: `https://t.me/${info.username ?? info.id}/${p.id}`,
      },
      key: info.id != null ? `telegram:post:${info.id}:${p.id}` : undefined,
    });
    postNodes.set(p.id, post.id);
    await ctx.graph.createEdge({ from: post.id, to: chatNodeId, label: "posted in" });
  }
  for (const p of posts) {
    const replyId = p.reply_to_msg_id;
    if (replyId != null && postNodes.has(replyId)) {
      await ctx.graph.createEdge({ from: postNodes.get(p.id), to: postNodes.get(replyId), label: "replied to" });
    }
  }
  return posts.length;
}

async function materializeParticipants(ctx, chatNodeId, participants) {
  let count = 0;
  for (const part of participants) {
    const name = [part.first_name, part.last_name].filter(Boolean).join(" ");
    const user = await ctx.graph.createNode({
      type: "telegram.user",
      data: {
        telegram_id: part.user_id,
        username: part.username ?? undefined,
        display_name: name || undefined,
        is_bot: part.is_bot ?? false,
        profile_url: profileUrl(part.username),
      },
      key: `telegram:telegram.user:${part.user_id}`,
    });
    await ctx.graph.createEdge({ from: user.id, to: chatNodeId, label: "participant of" });
    if (part.is_admin || part.is_creator) {
      await ctx.graph.createEdge({ from: user.id, to: chatNodeId, label: "admin of" });
    }
    count++;
  }
  return count;
}

// Selection helper: fetch the selected nodes, keep the ones the plugin handles.
async function collectSelection(ctx) {
  const selection = (ctx.input && ctx.input.selection) || [];
  const nodes = [];
  for (const id of selection) {
    const node = await ctx.graph.get(id);
    if (node) nodes.push(node);
  }
  return nodes;
}

// ---- plugin: telegram_search ------------------------------------------------
const searchPlugin = {
  manifest: {
    identifier: "run.vineyard.plugins.telegram_search",
    content_type: "vineyard:plugin",
    name: "Telegram Search",
    version: "2.2.0",
    description:
      "Global launch (no selection needed): runs a keyword search against Telegram (the same contacts.search the apps use) via the tgpeek gateway and materializes the results as telegram.user / telegram.channel / telegram.group nodes.",
    icon: "search",
    author: { name: "VINEYARD", url: "https://vineyard.run" },
    license: "MIT",
    distribution: { kind: "inline" },
    platforms: { primary: "web", web: { runtime: "sandbox-js", entry: "inline" } },
    io: {
      consumes: [],
      produces: [
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "user" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "channel" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" },
      ],
    },
    params: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Search keyword (people, bots, groups, channels)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results (default 20)." },
      },
      required: ["query"],
    },
    scopes: {
      graph: ["node:read", "node:create"],
      // Named, not addressed: the host owns the URL and attaches the analyst's identity.
      services: ["telegram"],
    },
    lifecycle: { persistence: "opt-in", controls: ["progress", "cancel"], progress: "determinate" },
  },
  async run(ctx) {
    const counts = { processed: 0, collected: 0, skipped: 0, errors: 0 };
    requireService(ctx);
    const params = ctx.params || {};
    const query = String(params.query || "").trim();
    if (!query) return { summary: "Provide a search query (params.query)", counts };

    ctx.progress && ctx.progress.set && ctx.progress.set({ percent: 10, message: `Searching "${query}"` });
    // One request, one outcome — nothing to keep going for, so a failure here just propagates.
    const result = await postJson(ctx, "/search", { query, limit: Number(params.limit) || 20 });
    let made = 0;
    for (const ref of result.results || []) {
      const mapped = peerData(ref);
      if (!mapped) { counts.skipped++; continue; }
      await ctx.graph.createNode({ type: mapped.type, data: mapped.data, key: `telegram:${mapped.type}:${ref.id}` });
      made++;
    }
    counts.processed = 1;
    counts.collected = made;
    return { summary: `Search "${query}": ${made} result(s) materialized`, counts };
  },
};

// ---- plugin: telegram_resolve -----------------------------------------------
const resolvePlugin = {
  manifest: {
    identifier: "run.vineyard.plugins.telegram_resolve",
    content_type: "vineyard:plugin",
    name: "Telegram Resolve",
    // Bumped with the two behaviour changes this description already documents: a handle with no
    // account is a result rather than a failure, and a handle resolves to its current holder rather
    // than being 'same as' them. plugins/telegram.manifest.json carries the same number per member,
    // and the registry compares them member by member — not just at the pack level.
    version: "2.4.1",
    description:
      "Resolves a known Telegram handle to its full profile via the tgpeek gateway (bio/about, participant count, flags). Inputs: a web.url t.me handle link (t.me/<username>, t.me/s/<username> — node created with a links-to evidence edge), an existing telegram.user / telegram.channel / telegram.group node (enriched in place by its username/usernames), or an identity.handle node (node created with a same-as edge). Invite links, non-Telegram URLs and handles without a username are a no-op. A handle with no Telegram account is reported as a normal result (no_account), not a failure.",
    icon: "user-search",
    author: { name: "VINEYARD", url: "https://vineyard.run" },
    license: "MIT",
    distribution: { kind: "inline" },
    platforms: { primary: "web", web: { runtime: "sandbox-js", entry: "inline" } },
    io: {
      consumes: [
        { typepack: "run.vineyard.typepacks.infrastructure", category: "web", name: "url" },
        { typepack: "run.vineyard.typepacks.identity", category: "identity", name: "handle" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "user" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "channel" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" },
      ],
      produces: [
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "user" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "channel" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" },
      ],
    },
    scopes: {
      graph: ["node:read", "node:create", "node:update", "edge:create"],
      // Named, not addressed: the host owns the URL and attaches the analyst's identity.
      services: ["telegram"],
    },
    lifecycle: { persistence: "opt-in", controls: ["progress", "cancel"], progress: "determinate" },
  },
  async run(ctx) {
    const counts = { processed: 0, collected: 0, not_found: 0, skipped: 0, errors: 0 };
    const state = {};
    requireService(ctx);
    const nodes = await collectSelection(ctx);
    if (!nodes.length) return { summary: "Select web.url / telegram.* / identity.handle nodes", counts };

    for (let i = 0; i < nodes.length; i++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const node = nodes[i];
      let target = null;
      let mode = "create"; // create = new node (+links_to/same_as), update = enrich in place
      let url;

      if (node.type === "web.url") {
        url = String((node.data && node.data.url) || "").trim();
        const parsed = parseTelegramUrl(url);
        if (!parsed || parsed.kind !== "handle") { counts.skipped++; continue; } // invites → telegram_invite_link
        target = handleFromUrl(url);
      } else if (node.type === "telegram.user" || node.type === "telegram.channel" || node.type === "telegram.group") {
        target = nodeHandle(node.data);
        if (!target) {
          // No handle on the node: fall back to the stored telegram_id. Numeric
          // resolution only works when the gateway session already knows the id,
          // and the type guard below rejects mismatches (e.g. a channel id
          // stored on a telegram.user node).
          const id = String(node.data && node.data.telegram_id != null ? node.data.telegram_id : "").trim();
          if (!id) { counts.skipped++; continue; }
          target = id;
        }
        mode = "update";
      } else if (node.type === "identity.handle") {
        const raw = String((node.data && node.data.handle) || "").trim().replace(/^@+/, "");
        if (!HANDLE_RE.test(raw)) { counts.skipped++; continue; } // not a telegram username shape
        target = raw;
      } else {
        counts.skipped++;
        continue;
      }

      ctx.progress && ctx.progress.set && ctx.progress.set({
        percent: Math.round(((i + 1) / nodes.length) * 100),
        message: `Resolving ${target}`,
      });
      counts.processed++;
      try {
        // found:false means the gateway asked Telegram and the answer was no — a normal negative
        // result, not a failure. Before this, tgpeek's /resolve answered a nonexistent handle
        // with the same HTTP 400 a malformed request gets, and postJson turned that into a thrown
        // ServiceError caught right below — so "checked and it has no account" and "the gateway
        // choked" both counted as counts.errors, and a run that only hit missing handles ended up
        // in the RED, FAILED bucket (see the `finish` comment above this plugin) for finding
        // exactly what it was asked to find out.
        const { found, info } = await postJson(ctx, "/resolve", { target });
        if (!found) { counts.not_found++; continue; }
        if (mode === "update") {
          const type = kindToType(info.kind);
          if (!type || type !== node.type) { counts.skipped++; continue; } // resolved to a different kind — stale node
          const merged = { ...(node.data || {}), ...chatData(type, info, "public", undefined) };
          await ctx.graph.updateNode(node.id, merged);
          counts.collected++;
        } else {
          // NOT "same as", and this is the whole point of the label parameter.
          //
          // An identity.handle node is a STRING, not a person, and it is a hub: every account
          // anywhere that uses that string hangs off the same node (node identity is type+label).
          // Telegram also RECYCLES usernames — a handle released by one account can be claimed by
          // an unrelated one. So "the handle t.me/x resolves to profile P" says only who holds it
          // NOW, and writing that as `same as` asserted something much larger: that the handle and
          // whoever currently answers to it are one entity.
          //
          // Measured consequence, from a real project file: a handle confirmed to belong to the
          // subject was ALSO claimed on Telegram by a stranger. This edge put the stranger three
          // hops from the subject's person node, and it survived the adversarial auto-apply check —
          // correctly, because at the string level the claim IS true. What was wrong was the claim,
          // not the checking. A label the verifier can only read as an identity assertion will be
          // supported whenever the strings match, which is exactly when it is most misleading.
          //
          // It was also a DUPLICATE: ensureChat had already drawn handle -> chat, so this added a
          // second, opposite-direction edge between the same pair.
          const chat = await ensureChat(
            ctx, node.id, url, info, "public",
            node.type === "identity.handle" ? "currently resolves to" : "links to",
          );
          if (!chat) { counts.skipped++; continue; }
          counts.collected++;
        }
      } catch (e) {
        noteError(counts, state, e);
      }
    }
    return finish(
      `Resolved ${counts.collected} handle(s); ${counts.not_found} no account, ${counts.skipped} skipped, ${counts.errors} error(s)`,
      counts,
      state.firstError,
    );
  },
};

// ---- plugin: telegram_invite_link --------------------------------------------
const inviteLinkPlugin = {
  manifest: {
    identifier: "run.vineyard.plugins.telegram_invite_link",
    content_type: "vineyard:plugin",
    name: "Telegram Invite Link",
    version: "2.2.0",
    description:
      "For each selected web.url node that is an invite link (t.me/+hash, t.me/joinchat/..., tg://join), analyzes it via the tgpeek gateway: creates the telegram.channel / telegram.group node (invite_hash for groups, peek/expires when the server grants temporary read access). Handle links and non-Telegram URLs are a no-op. Analysis only — reading posts of an invite link is Telegram Posts' job (best-effort peek).",
    icon: "link",
    author: { name: "VINEYARD", url: "https://vineyard.run" },
    license: "MIT",
    distribution: { kind: "inline" },
    platforms: { primary: "web", web: { runtime: "sandbox-js", entry: "inline" } },
    io: {
      consumes: [{ typepack: "run.vineyard.typepacks.infrastructure", category: "web", name: "url" }],
      produces: [
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "channel" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" },
      ],
    },
    scopes: {
      graph: ["node:read", "node:create", "edge:create"],
      // Named, not addressed: the host owns the URL and attaches the analyst's identity.
      services: ["telegram"],
    },
    lifecycle: { persistence: "opt-in", controls: ["progress", "cancel"], progress: "determinate" },
  },
  async run(ctx) {
    const counts = { processed: 0, collected: 0, skipped: 0, errors: 0 };
    const state = {};
    requireService(ctx);
    const nodes = await collectSelection(ctx);
    if (!nodes.length) return { summary: "Select one or more web.url nodes (invite links)", counts };

    for (let i = 0; i < nodes.length; i++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const node = nodes[i];
      if (node.type !== "web.url") { counts.skipped++; continue; }
      const url = String((node.data && node.data.url) || "").trim();
      const parsed = parseTelegramUrl(url);
      if (!parsed || parsed.kind !== "invite") { counts.skipped++; continue; }

      ctx.progress && ctx.progress.set && ctx.progress.set({
        percent: Math.round(((i + 1) / nodes.length) * 100),
        message: `Analyzing ${url}`,
      });
      counts.processed++;
      try {
        const info = await postJson(ctx, "/invite-link", { link: url });
        const chat = await ensureChat(ctx, node.id, url, info, "invite");
        if (chat) { counts.collected++; } else { counts.skipped++; }
      } catch (e) {
        noteError(counts, state, e);
      }
    }
    return finish(
      `Analyzed ${counts.collected} invite link(s); ${counts.skipped} skipped, ${counts.errors} error(s)`,
      counts,
      state.firstError,
    );
  },
};

// ---- plugin: telegram_posts --------------------------------------------------
const postsPlugin = {
  manifest: {
    identifier: "run.vineyard.plugins.telegram_posts",
    content_type: "vineyard:plugin",
    name: "Telegram Posts",
    version: "2.2.0",
    description:
      "Post list without joining. Inputs: a web.url invite link (best-effort peek via the gateway — posts only when the server grants temporary read access; the chat node is created with a links-to evidence edge) or existing telegram.channel / telegram.group nodes (target = username or numeric id). Stages telegram.post nodes with posted in / replied to edges.",
    icon: "list",
    author: { name: "VINEYARD", url: "https://vineyard.run" },
    license: "MIT",
    distribution: { kind: "inline" },
    platforms: { primary: "web", web: { runtime: "sandbox-js", entry: "inline" } },
    io: {
      consumes: [
        { typepack: "run.vineyard.typepacks.infrastructure", category: "web", name: "url" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "channel" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" },
      ],
      produces: [
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "channel" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" },
        { typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "post" },
      ],
    },
    params: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, description: "Max posts to collect per chat (blank = all)." },
      },
    },
    scopes: {
      graph: ["node:read", "node:create", "edge:create"],
      // Named, not addressed: the host owns the URL and attaches the analyst's identity.
      services: ["telegram"],
    },
    lifecycle: { persistence: "opt-in", controls: ["progress", "cancel"], progress: "determinate" },
  },
  async run(ctx) {
    const counts = { processed: 0, collected: 0, skipped: 0, errors: 0 };
    const state = {};
    requireService(ctx);
    const nodes = await collectSelection(ctx);
    if (!nodes.length) return { summary: "Select a web.url invite link or telegram.channel / telegram.group nodes", counts };
    const limits = runLimit(ctx, "limit");

    for (let i = 0; i < nodes.length; i++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const node = nodes[i];
      counts.processed++;
      try {
        if (node.type === "web.url") {
          const url = String((node.data && node.data.url) || "").trim();
          const parsed = parseTelegramUrl(url);
          if (!parsed || parsed.kind !== "invite") { counts.skipped++; continue; }
          ctx.progress && ctx.progress.set && ctx.progress.set({
            percent: Math.round(((i + 1) / nodes.length) * 100),
            message: `Peeking ${url}`,
          });
          const result = await postJson(ctx, "/posts", { target: url, ...limits });
          const chat = await ensureChat(ctx, node.id, url, result.info || {}, "invite");
          const posts = chat ? await materializePosts(ctx, chat.id, result.info || {}, result.posts || []) : 0;
          if (chat && posts > 0) { counts.collected++; } else { counts.skipped++; }
        } else if (node.type === "telegram.channel" || node.type === "telegram.group") {
          const target = String((node.data && node.data.username) || "").trim()
            || String(node.data && node.data.telegram_id != null ? node.data.telegram_id : "").trim();
          if (!target) { counts.skipped++; continue; }
          ctx.progress && ctx.progress.set && ctx.progress.set({
            percent: Math.round(((i + 1) / nodes.length) * 100),
            message: `Posts of ${target}`,
          });
          const result = await postJson(ctx, "/posts", { target, ...limits });
          const info = result.info || {};
          const posts = await materializePosts(ctx, node.id, info, result.posts || []);
          if (posts > 0) { counts.collected++; } else { counts.skipped++; }
        } else {
          counts.skipped++;
        }
      } catch (e) {
        noteError(counts, state, e);
      }
    }
    return finish(
      `Posts collected for ${counts.collected} chat(s); ${counts.skipped} skipped, ${counts.errors} error(s)`,
      counts,
      state.firstError,
    );
  },
};

// ---- plugin: telegram_participants -------------------------------------------
const participantsPlugin = {
  manifest: {
    identifier: "run.vineyard.plugins.telegram_participants",
    content_type: "vineyard:plugin",
    name: "Telegram Participants",
    version: "2.2.0",
    description:
      "For each selected telegram.group node, pulls the no-join participant list of the public supergroup from the tgpeek gateway and stages telegram.user nodes with participant of / admin of edges. Only public supergroups expose participants; the gateway rejects invite links and channels.",
    icon: "users",
    author: { name: "VINEYARD", url: "https://vineyard.run" },
    license: "MIT",
    distribution: { kind: "inline" },
    platforms: { primary: "web", web: { runtime: "sandbox-js", entry: "inline" } },
    io: {
      consumes: [{ typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "group" }],
      produces: [{ typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "user" }],
    },
    params: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, description: "Max participants to collect per group (blank = all)." },
      },
    },
    scopes: {
      graph: ["node:read", "node:create", "edge:create"],
      // Named, not addressed: the host owns the URL and attaches the analyst's identity.
      services: ["telegram"],
    },
    lifecycle: { persistence: "opt-in", controls: ["progress", "cancel"], progress: "determinate" },
  },
  async run(ctx) {
    const counts = { processed: 0, collected: 0, skipped: 0, errors: 0 };
    const state = {};
    requireService(ctx);
    const nodes = await collectSelection(ctx);
    if (!nodes.length) return { summary: "Select one or more telegram.group nodes", counts };
    const limits = runLimit(ctx, "participants_limit");

    for (let i = 0; i < nodes.length; i++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const node = nodes[i];
      if (node.type !== "telegram.group") { counts.skipped++; continue; }
      const target = String((node.data && node.data.username) || "").trim()
        || String(node.data && node.data.telegram_id != null ? node.data.telegram_id : "").trim();
      if (!target) { counts.skipped++; continue; }

      ctx.progress && ctx.progress.set && ctx.progress.set({
        percent: Math.round(((i + 1) / nodes.length) * 100),
        message: `Participants of ${target}`,
      });
      counts.processed++;
      try {
        const result = await postJson(ctx, "/participants", { target, ...limits });
        const participants = await materializeParticipants(ctx, node.id, result.participants || []);
        if (participants > 0) { counts.collected++; } else { counts.skipped++; }
      } catch (e) {
        noteError(counts, state, e);
      }
    }
    return finish(
      `Participants collected for ${counts.collected} group(s); ${counts.skipped} skipped, ${counts.errors} error(s)`,
      counts,
      state.firstError,
    );
  },
};

// ---- plugin: telegram_phone_lookup -------------------------------------------
const phoneLookupPlugin = {
  manifest: {
    identifier: "run.vineyard.plugins.telegram_phone_lookup",
    content_type: "vineyard:plugin",
    name: "Telegram Phone Lookup",
    version: "2.2.0",
    description:
      "For each selected identity.phone_number node, resolves the number via the tgpeek gateway (contacts.resolvePhone — the same method t.me/+<number> deep links use) and creates the telegram.user node when the number has a Telegram account whose privacy settings allow phone lookup, plus a same-as edge from the user to the phone number node. Numbers with no account, or hidden from phone lookup, produce nothing. The gateway caches results for 1 hour and collapses concurrent lookups of one number into a single request.",
    icon: "phone",
    author: { name: "VINEYARD", url: "https://vineyard.run" },
    license: "MIT",
    distribution: { kind: "inline" },
    platforms: { primary: "web", web: { runtime: "sandbox-js", entry: "inline" } },
    io: {
      consumes: [{ typepack: "run.vineyard.typepacks.identity", category: "identity", name: "phone_number" }],
      produces: [{ typepack: "run.vineyard.typepacks.telegram", category: "telegram", name: "user" }],
    },
    scopes: {
      graph: ["node:read", "node:create", "edge:create"],
      // Named, not addressed: the host owns the URL and attaches the analyst's identity.
      services: ["telegram"],
    },
    lifecycle: { persistence: "opt-in", controls: ["progress", "cancel"], progress: "determinate" },
  },
  async run(ctx) {
    const counts = { processed: 0, collected: 0, skipped: 0, errors: 0 };
    const state = {};
    requireService(ctx);
    const nodes = await collectSelection(ctx);
    if (!nodes.length) return { summary: "Select one or more identity.phone_number nodes", counts };

    for (let i = 0; i < nodes.length; i++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const node = nodes[i];
      if (node.type !== "identity.phone_number") { counts.skipped++; continue; }
      const phone = String((node.data && node.data.number) || "").trim();
      if (!phone) { counts.skipped++; continue; }

      ctx.progress && ctx.progress.set && ctx.progress.set({
        percent: Math.round(((i + 1) / nodes.length) * 100),
        message: `Looking up ${phone}`,
      });
      counts.processed++;
      try {
        const result = await postJson(ctx, "/phone-lookup", { phone });
        if (!result.found || !result.info) { counts.skipped++; continue; }
        const info = result.info;
        const type = kindToType(info.kind);
        if (!type) { counts.skipped++; continue; }
        const user = await ctx.graph.createNode({
          type,
          data: chatData(type, info, "public", undefined),
          key: `telegram:${type}:${info.id}`,
        });
        await ctx.graph.createEdge({ from: user.id, to: node.id, label: "same as" });
        counts.collected++;
      } catch (e) {
        noteError(counts, state, e);
      }
    }
    return finish(
      `Resolved ${counts.collected} phone number(s); ${counts.skipped} skipped (no user / hidden / no-op), ${counts.errors} error(s)`,
      counts,
      state.firstError,
    );
  },
};

// ---- pack -------------------------------------------------------------------
const packManifest = {
  identifier: "run.vineyard.pluginpacks.telegram",
  content_type: "vineyard:pluginpack",
  name: "Telegram",
  // Keep in step with plugins/telegram.manifest.json. Unlike the generated packs, this file is
  // hand-authored source rather than esbuild output, so nothing regenerates this number when the
  // manifest is bumped — it sat at 2.3.0 through the two telegram_resolve commits that shipped as
  // 2.4.0, and the registry now fails the pack when the two disagree (verify_pinned.bundle_mismatch).
  version: "2.4.1",
  description:
    "Telegram read-only reconnaissance via the tgpeek gateway (no joining): keyword search, handle resolution, invite-link analysis/collection, granular post / participant collection, and phone-number lookup. The plugins mirror the gateway endpoints 1:1 so the AI agent and the analyst can run exactly the operation they need. Materialized as telegram.* nodes with source URLs linked as evidence.",
  plugins: [searchPlugin.manifest, resolvePlugin.manifest, inviteLinkPlugin.manifest, postsPlugin.manifest, participantsPlugin.manifest, phoneLookupPlugin.manifest],
};

export default { manifest: packManifest, plugins: [searchPlugin, resolvePlugin, inviteLinkPlugin, postsPlugin, participantsPlugin, phoneLookupPlugin] };
