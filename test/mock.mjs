// Fake Discord API for tests: answers from a small in-memory server and logs every request.
import { appendFileSync } from "node:fs";
const LOG = process.env.MOCK_LOG;
const G = "100000000000000001";
const state = {
  guild: { id: G, name: "Test Server", owner_id: "1", premium_tier: 0, verification_level: 1, features: [] },
  channels: [
    { id: "200000000000000001", name: "Info", type: 4, position: 0, permission_overwrites: [] },
    { id: "200000000000000002", name: "📢-announcements", type: 5, position: 0, parent_id: "200000000000000001", permission_overwrites: [] },
    { id: "200000000000000003", name: "💬-general", type: 0, position: 1, parent_id: "200000000000000001",
      permission_overwrites: [{ id: G, type: 0, allow: "64", deny: "0" }] },
    { id: "200000000000000004", name: "bug-reports", type: 15, position: 2, parent_id: "200000000000000001",
      available_tags: [{ id: "300000000000000001", name: "Approved", emoji_name: "✅", moderated: true }], permission_overwrites: [] },
  ],
  roles: [
    { id: G, name: "@everyone", position: 0, permissions: "1024", color: 0 },
    { id: "400000000000000001", name: "Admin", position: 3, permissions: "8", color: 0x9b59b6, hoist: true },
    { id: "400000000000000002", name: "Bot Role", position: 2, permissions: "8", color: 0, managed: true },
    { id: "400000000000000003", name: "Updates Ping", position: 1, permissions: "0", color: 0xad1457 },
  ],
};
const bot = { id: "500000000000000001", username: "TestBot", bot: true };
const user = { id: "500000000000000002", username: "alice", global_name: "Alice" };
const json = (d, status = 200) => new Response(d === null ? null : JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (!url.startsWith("https://discord.com/api/v10")) return realFetch(url, init);
  const path = url.slice("https://discord.com/api/v10".length);
  const method = init.method || "GET";
  let body;
  let files = [];
  if (init.body instanceof FormData) {
    const pj = init.body.get("payload_json");
    body = pj ? JSON.parse(pj) : Object.fromEntries([...init.body.entries()].filter(([, v]) => typeof v === "string"));
    for (const [k, v] of init.body.entries()) if (typeof v !== "string") files.push({ field: k, name: v.name, size: v.size, type: v.type });
  } else if (init.body) body = JSON.parse(init.body);
  const auth = init.headers?.Authorization || "";
  if (LOG) appendFileSync(LOG, JSON.stringify({ method, path, body, files: files.length ? files : undefined, auth,
    reason: init.headers?.["X-Audit-Log-Reason"] }) + "\n");
  const p = path.split("?")[0];
  if (p === "/guilds/templates/hgM48av5Q69A") {
    return json({ code: "hgM48av5Q69A", name: "Friends & Family", description: "A cosy server", usage_count: 1234, creator: { username: "maker" },
      serialized_source_guild: {
        roles: [{ id: 0, name: "@everyone", permissions: "104324673", color: 0 }, { id: 1, name: "Mods", permissions: "8", color: 3447003, hoist: true }],
        channels: [
          { id: 2, type: 4, name: "Text Channels", position: 0, parent_id: null, permission_overwrites: [] },
          { id: 3, type: 0, name: "general", position: 0, parent_id: 2, topic: "chat", permission_overwrites: [] },
          { id: 4, type: 0, name: "mods-only", position: 1, parent_id: 2, permission_overwrites: [{ id: 0, type: 0, allow: "0", deny: "1024" }, { id: 1, type: 0, allow: "1024", deny: "0" }] },
          { id: 5, type: 4, name: "Voice Channels", position: 1, parent_id: null, permission_overwrites: [] },
          { id: 6, type: 2, name: "General", position: 0, parent_id: 5, user_limit: 0, permission_overwrites: [] },
        ] } });
  }
  // A second bot ("test-token-2") lives in another server.
  if (auth === "Bot test-token-2") {
    const G2 = "100000000000000002";
    if (p === "/users/@me") return json({ id: "500000000000000009", username: "SecondBot", bot: true });
    if (p === "/users/@me/guilds") return json([{ id: G2, name: "Other Server", permissions: "8" }]);
    if (p === `/guilds/${G2}`) return json({ id: G2, name: "Other Server", owner_id: "1", features: [] });
    if (p === `/guilds/${G2}/channels`) return json([]);
    if (p === `/guilds/${G2}/roles`) return json([{ id: G2, name: "@everyone", position: 0, permissions: "8" }]);
    if (p.startsWith(`/guilds/${G2}/members/`)) return json({ user: { id: "500000000000000009", username: "SecondBot" }, roles: [] });
    if (p === "/oauth2/applications/@me") return json({ id: "500000000000000009", name: "Second", flags: 0 });
    if (p === `/guilds/${G2}/threads/active`) return json({ threads: [] });
    return json({ message: "Unknown route for bot 2", path }, 404);
  }
  if (auth === "Bot test-token-3" && p === "/users/@me") return json({ id: "500000000000000003", username: "ThirdBot", bot: true });
  if (p === "/guilds/100000000000000001/channels/2fa-test" ) return json({ message: "Two factor is required for this operation", code: 60003 }, 403);
  if (p === "/users/@me") return json(method === "PATCH" ? { ...bot, ...body } : bot);
  if (p === "/oauth2/applications/@me") return json({ id: bot.id, name: "TestApp", flags: 0 });
  if (p === `/guilds/${G}/prune` && method === "GET") return json({ pruned: 3 });
  if (p === `/guilds/${G}/members` && method === "GET") return json([{ user, roles: ["400000000000000003"] }, { user: bot, roles: ["400000000000000002"] }]);
  if (p === "/users/@me/guilds") return json([{ id: G, name: "Test Server", permissions: "8" }]);
  if (p === `/guilds/${G}`) return json(method === "GET" ? state.guild : { ...state.guild, ...body });
  if (p === `/guilds/${G}/channels` && method === "GET") return json(state.channels);
  if (p === `/guilds/${G}/channels` && method === "POST") return json({ id: "200000000000000099", ...body });
  if (p === `/guilds/${G}/channels` && method === "PATCH") return json(null, 204);
  if (p === `/guilds/${G}/threads/active`) return json({ threads: [] });
  if (p === `/guilds/${G}/emojis` || p === `/guilds/${G}/stickers`) return json([]);
  if (p === `/guilds/${G}/roles` && method === "GET") return json(state.roles);
  if (p === `/guilds/${G}/roles` && method === "POST") {
    const r = { id: String(400000000000000100n + BigInt(state.roles.length)), position: 1, permissions: "0", color: 0, ...body };
    state.roles.push(r);
    return json(r);
  }
  if (p === `/guilds/${G}/roles` && method === "PATCH") return json(state.roles);
  if (p.startsWith(`/guilds/${G}/roles/`) && method === "PATCH") return json({ ...state.roles[3], ...body });
  if (p === `/guilds/${G}/members/${bot.id}`) return json({ user: bot, roles: ["400000000000000002"] });
  if (p.startsWith(`/guilds/${G}/members/search`)) return json([{ user, roles: [], joined_at: "2026-01-01" }]);
  if (p.startsWith(`/guilds/${G}/members/`)) return method === "GET" ? json({ user, roles: [] }) : json(null, 204);
  const ch = p.match(/^\/channels\/(\d+)$/);
  if (ch && method === "GET") return json(state.channels.find((c) => c.id === ch[1]) || { id: ch[1], name: "x", type: 0 });
  if (ch && method === "PATCH") return json({ ...state.channels.find((c) => c.id === ch[1]), ...body });
  if (ch && method === "DELETE") return json(state.channels.find((c) => c.id === ch[1]));
  if (/\/messages$/.test(p) && method === "POST") return json({ id: "600000000000000001", channel_id: "x", ...body });
  if (/\/threads$/.test(p) && method === "POST") return json({ id: "700000000000000001", name: body.name });
  if (/\/messages(\?|$)/.test(path) && method === "GET") return json([{ id: "600000000000000002", author: user, content: "hi", timestamp: "t", embeds: [], attachments: [] }]);
  if (/\/webhooks$/.test(p) && method === "GET") return json([]);
  if (/\/webhooks$/.test(p) && method === "POST") return json({ id: "800000000000000001", token: "tok", name: body.name });
  if (p.startsWith("/webhooks/")) return json({ id: "600000000000000003", channel_id: "200000000000000003" });
  if (method === "PUT" || method === "DELETE") return json(null, 204);
  if (method === "POST") return json({ id: "900000000000000001", ...body });
  return json({ message: "Unknown route in mock", path }, 404);
};

// Fake gateway: HELLO, READY, then any events a test appends (one JSON per line) to MOCK_GATEWAY_INBOX.
import { existsSync, readFileSync } from "node:fs";
const INBOX = process.env.MOCK_GATEWAY_INBOX;
globalThis.WebSocket = class {
  constructor() {
    this.seen = 0;
    setTimeout(() => this.emit({ op: 10, d: { heartbeat_interval: 45000 } }), 10);
  }
  emit(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(raw) {
    const msg = JSON.parse(raw);
    if (msg.op === 2) {
      const username = msg.d.token === "test-token-2" ? "SecondBot" : "TestBot";
      const id = msg.d.token === "test-token-2" ? "500000000000000009" : "500000000000000001";
      setTimeout(() => this.emit({ op: 0, t: "READY", s: 1, d: { session_id: "s", resume_gateway_url: "wss://x", user: { id, username } } }), 10);
      if (INBOX && msg.d.token === "test-token") {
        this.timer = setInterval(() => {
          if (!existsSync(INBOX)) return;
          const lines = readFileSync(INBOX, "utf8").split("\n").filter(Boolean);
          for (const line of lines.slice(this.seen)) this.emit({ op: 0, s: 2, ...JSON.parse(line) });
          this.seen = lines.length;
        }, 50);
      }
    }
  }
  close() {
    clearInterval(this.timer);
  }
};
