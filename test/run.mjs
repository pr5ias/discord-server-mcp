// Runs the built server against the fake Discord API and checks the requests it makes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "dsm-home-"));
const LOG = join(here, ".requests.log");
const IMG = join(here, "pixel.png");
writeFileSync(IMG, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", join(here, "mock.mjs"), join(here, "..", "dist", "index.mjs")],
  env: { ...process.env, HOME, USERPROFILE: HOME, DISCORD_BOT_TOKEN: "test-token", DISCORD_GATEWAY: "off", DISCORD_TOOLSETS: "all", MOCK_LOG: LOG },
});
const client = new Client({ name: "test", version: "1" });
await client.connect(transport);

let failures = 0;
let pageUrl;
async function check(name, args, verify) {
  if (existsSync(LOG)) unlinkSync(LOG);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  const reqs = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const writes = reqs.filter((r) => r.method !== "GET");
  try {
    verify({ text, isError: res.isError, writes, reqs, data: res.isError ? null : (() => { try { return JSON.parse(text); } catch { return null; } })() });
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message}\n     result: ${text.slice(0, 400)}\n     writes: ${JSON.stringify(writes).slice(0, 600)}`);
  }
}

const tools = (await client.listTools()).tools;
assert.ok(tools.length >= 60, "tool count");
console.log(`${tools.length} tools listed`);

await check("get_server", {}, ({ data }) => {
  assert.equal(data.server.name, "Test Server");
  assert.equal(data.categories[0].channels.length, 3);
  assert.equal(data.bot.administrator, true);
  assert.equal(data.roles[0].name, "Admin");
});
await check("create_channel", { name: "news", category: "info", topic: "t", private: true }, ({ writes }) => {
  const b = writes[0].body;
  assert.equal(b.parent_id, "200000000000000001");
  assert.equal(b.type, 0);
  assert.deepEqual(b.permission_overwrites.at(-1), { id: "100000000000000001", type: 0, allow: "0", deny: "1024" });
});
await check("edit_channel", { channel: "general", category: "none", topic: "x" }, ({ writes }) => {
  assert.equal(writes[0].path, "/channels/200000000000000003");
  assert.equal(writes[0].body.parent_id, null);
});
await check("set_permissions", { channel: "general", target: "@everyone", deny: ["SendMessages"] }, ({ writes }) => {
  assert.equal(writes[0].method, "PUT");
  assert.equal(writes[0].body.allow, "64"); // kept AddReactions
  assert.equal(writes[0].body.deny, String(1 << 11));
});
await check("add_forum_tags", { forum: "bug-reports", tags: [{ name: "New", emoji: "🆕" }] }, ({ writes }) => {
  const tags = writes[0].body.available_tags;
  assert.equal(tags.length, 2);
  assert.deepEqual(tags[0], { id: "300000000000000001", name: "Approved", emoji_name: "✅", moderated: true });
  assert.equal(tags[1].emoji_name, "🆕");
});
await check("send_message", {
  channel: "announcements", content: "Hello", ping_roles: ["Updates Ping"], publish: true, pin: true,
  embeds: [{ title: "T", image: "attachment://pixel.png", color: "green" }], files: [{ source: IMG }],
  link_buttons: [{ label: "Site", url: "https://example.com" }],
}, ({ writes, data }) => {
  const send = writes[0];
  assert.equal(send.body.content, "<@&400000000000000003>\nHello");
  assert.deepEqual(send.body.allowed_mentions.roles, ["400000000000000003"]);
  assert.deepEqual(send.body.allowed_mentions.parse, []);
  assert.equal(send.files[0].name, "pixel.png");
  assert.equal(send.files[0].type, "image/png");
  assert.equal(send.body.embeds[0].color, 0x57f287);
  assert.equal(send.body.components[0].components[0].style, 5);
  assert.ok(writes.some((w) => w.path.endsWith("/crosspost")));
  assert.ok(writes.some((w) => w.method === "PUT" && w.path.includes("pins")));
  assert.match(data.link, /discord.com\/channels/);
});
await check("send_message", { channel: "general", content: "no pings @everyone" }, ({ writes }) => {
  assert.deepEqual(writes[0].body.allowed_mentions.parse, []);
});
await check("create_forum_post", { forum: "bug-reports", title: "Crash", content: "x", tags: ["approved"] }, ({ writes }) => {
  assert.equal(writes[0].path, "/channels/200000000000000004/threads");
  assert.deepEqual(writes[0].body.applied_tags, ["300000000000000001"]);
});
await check("create_forum_post", { forum: "bug-reports", title: "Crash", content: "x", tags: ["nope"] }, ({ isError, text }) => {
  assert.ok(isError);
  assert.match(text, /no tag "nope"/);
});
await check("edit_role", { role: "Updates Ping", add_permissions: ["SendMessages"], color: "#ff0000" }, ({ writes }) => {
  assert.equal(writes[0].body.permissions, String(1 << 11));
  assert.equal(writes[0].body.color, 0xff0000);
});
await check("set_member_roles", { member: "alice", add: ["Updates Ping"], reason: "test" }, ({ writes }) => {
  assert.equal(writes[0].path, "/guilds/100000000000000001/members/500000000000000002/roles/400000000000000003");
  assert.equal(writes[0].reason, "test");
});
await check("timeout_member", { member: "alice", minutes: 10 }, ({ writes }) => {
  assert.ok(writes[0].body.communication_disabled_until);
});
await check("reorder_channels", { categories: ["info"] }, ({ writes }) => {
  assert.deepEqual(writes[0].body, [{ id: "200000000000000001", position: 0 }]);
});
await check("edit_server", { icon: IMG, name: "New" }, ({ writes }) => {
  assert.match(writes[0].body.icon, /^data:image\/png;base64,/);
});
await check("send_webhook_message", { channel: "general", username: "Vinland", content: "hi" }, ({ writes }) => {
  assert.ok(writes[0].path.endsWith("/webhooks"));
  assert.match(writes[1].path, /^\/webhooks\/800000000000000001\/tok\?wait=true/);
  assert.equal(writes[1].body.username, "Vinland");
});
await check("discord_api", { method: "GET", path: "/guilds/{guild}/roles" }, ({ data }) => {
  assert.equal(data.length, 4);
});
await check("delete_messages", { channel: "general", message_ids: ["1300000000000000000000", "1300000000000000000001"] }, ({ writes, data }) => {
  assert.equal(writes.length, 0, "no confirm: nothing sent");
  assert.equal(data.dry_run, true);
  assert.ok(data.would_send[0].path.endsWith("/bulk-delete"));
});
await check("delete_messages", { channel: "general", message_ids: ["1300000000000000000000", "1300000000000000000001"], confirm: true }, ({ writes }) => {
  assert.ok(writes[0].path.endsWith("/bulk-delete"));
});
await check("create_channel", { name: "x", dry_run: true }, ({ writes, data }) => {
  assert.equal(writes.length, 0);
  assert.equal(data.would_send[0].method, "POST");
});
await check("create_channel", { name: "news", type: "announcement" }, ({ writes, data }) => {
  assert.equal(writes[0].body.type, 0, "no Community: made as a text channel");
  assert.match(data.note, /Community/);
});
await check("apply_blueprint", { blueprint: { categories: [{ name: "Info", channels: [{ name: "brand-new-news", type: "announcement" }] }] } }, ({ data }) => {
  assert.ok(data.steps.some((s) => s.includes("Create text channel #brand-new-news")));
  assert.ok(data.notes.some((n) => n.includes("need Community")));
});
await check("apply_blueprint", { template: "community" }, ({ data }) => {
  assert.ok(data.steps.some((s) => s.includes('Give "Bots" to the bots')));
});
await check("edit_channel", { channel: "genral", topic: "x" }, ({ isError, text }) => {
  assert.ok(isError);
  assert.match(text, /Did you mean "💬-general"/);
});
await check("apply_blueprint", { template: "project" }, ({ writes, data }) => {
  assert.equal(writes.length, 0);
  assert.equal(data.mode, "plan");
  assert.ok(data.steps.some((s) => s.includes('Create role "Member"')));
  assert.ok(data.steps.some((s) => s.includes("Create category \"Support\"")));
  assert.ok(!data.steps.some((s) => s.includes("Create announcement channel #📢-announcements")), "existing announcements channel is reused");
  assert.ok(data.steps.some((s) => s.includes("Add tags") && s.includes("bug-reports")));
});
await check("apply_blueprint", { mode: "apply", blueprint: { roles: [{ name: "Tester", color: "#ff0000" }],
  categories: [{ name: "Beta", overrides: [{ target: "@everyone", deny: ["ViewChannel"] }, { target: "Tester", allow: ["ViewChannel"] }],
    channels: [{ name: "beta-chat", type: "text", topic: "t" }] }] } }, ({ writes, data }) => {
  assert.equal(data.done.length, 3);
  assert.equal(writes[0].path, "/guilds/100000000000000001/roles");
  assert.equal(writes[1].body.type, 4);
  assert.equal(writes[2].body.parent_id, "200000000000000099");
});
await check("preview_blueprint", { template: "project", server: "Test Server" }, ({ text, isError }) => {
  assert.ok(!isError, text);
  assert.match(text, /⌄ SUPPORT/);
  assert.match(text, /📢 📢-announcements \(exists in another category/);
  assert.match(text, /\| Member 🆕 \|/);
  assert.match(text, /\| # staff-chat \| 🚫 \|/);
  assert.match(text, /change\(s\) to make/);
});
await check("import_discord_template", { link: "https://discord.new/hgM48av5Q69A" }, ({ data }) => {
  assert.equal(data.info.name, "Friends & Family");
  assert.equal(data.blueprint.categories[0].channels[1].overrides[0].target, "@everyone");
  assert.deepEqual(data.blueprint.categories[0].channels[1].overrides[1], { target: "Mods", allow: ["ViewChannel"] });
  assert.equal(data.blueprint.categories[1].channels[0].type, "voice");
});
await check("preview_blueprint", { discord_template: "discord.com/template/hgM48av5Q69A", server: "Test Server" }, ({ text }) => {
  assert.match(text, /Preview: Discord template hgM48av5Q69A/);
  assert.match(text, /# mods-only 🆕/);
  assert.match(text, /\| # mods-only \| 🚫 \| ✅ \|/);
});
await check("export_server_structure", {}, ({ data }) => {
  assert.equal(data.categories[0].name, "Info");
  assert.deepEqual(data.categories[0].channels[1].overrides[0], { target: "@everyone", allow: ["AddReactions"] });
  assert.equal(data.roles[0].name, "@everyone");
});
await check("check_permissions", { channel: "general" }, ({ data }) => {
  assert.ok(data.roles_that_can_see.includes("Admin"));
});
await check("check_permissions", { role: "Updates Ping", channel: "general" }, ({ data }) => {
  assert.ok(data.can.includes("ViewChannel"));
  assert.ok(data.can.includes("AddReactions"));
});
await check("audit_roles", {}, ({ data }) => {
  assert.ok(data.findings.some((f) => f.includes('"Admin" has Administrator')));
});
await check("prune_members", { days: 7 }, ({ writes, data }) => {
  assert.equal(writes.length, 0);
  assert.equal(data.if_applied.members_affected, 3);
});
await check("configure", { status_text: "My Server", write_mode: "preview" }, ({ data }) => {
  const saved = JSON.parse(readFileSync(join(HOME, ".discord-mcp", "settings.json"), "utf8"));
  assert.equal(saved.DISCORD_PRESENCE_TEXT, "My Server");
  assert.equal(data.restart_needed, true);
});
await check("create_role", { name: "AfterPreview" }, ({ writes, data }) => {
  assert.equal(writes.length, 0, "preview mode applies at once");
  assert.equal(data.dry_run, true);
});
await check("configure", { write_mode: "full" }, () => {});
await check("setup_check", {}, ({ data }) => {
  assert.equal(data.bots[0].bot, "TestBot");
  assert.match(data.bots[0].invite_link, /client_id=500000000000000001/);
});
await check("add_bot", { method: "browser", label: "Page Bot" }, ({ data }) => {
  assert.match(data.open_this_link, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
  pageUrl = data.open_this_link;
});
{
  const res = await fetch(pageUrl, { method: "POST", body: `token=${"x".repeat(60)}&label=Page%20Bot` });
  const html = await res.text();
  try {
    assert.match(html, /is connected/);
    const saved = JSON.parse(readFileSync(join(HOME, ".discord-mcp", "bots.json"), "utf8"));
    assert.ok(saved.some((b) => b.name === "Page Bot"));
    console.log("ok   add_bot page");
  } catch (e) {
    failures++;
    console.log(`FAIL add_bot page: ${e.message}`);
  }
  unlinkSync(join(HOME, ".discord-mcp", "bots.json"));
}
await check("read_messages", { channel: "general", limit: 5 }, ({ data }) => {
  assert.equal(data.messages[0].content, "hi");
});
await check("get_member", { member: "bot" }, ({ data }) => assert.equal(data.username, "TestBot"));
await check("send_message", { channel: "nonexistent", content: "x" }, ({ isError, text }) => {
  assert.ok(isError);
  assert.match(text, /No channel/);
});

await client.close();

// Settings: read-only mode, tool groups, allowed servers.
async function withEnv(env, fn) {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", join(here, "mock.mjs"), join(here, "..", "dist", "index.mjs")],
    env: { ...process.env, HOME, USERPROFILE: HOME, DISCORD_BOT_TOKEN: "test-token", DISCORD_GATEWAY: "off", DISCORD_TOOLSETS: "all", ...env },
  });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(t);
  try {
    await fn(c);
    console.log(`ok   settings ${JSON.stringify(env)}`);
  } catch (e) {
    failures++;
    console.log(`FAIL settings ${JSON.stringify(env)}: ${e.message}`);
  }
  await c.close();
}
// Two bots: one from the environment, one saved in bots.json; tools follow the server's bot.
writeFileSync(join(HOME, ".discord-mcp", "bots.json"), JSON.stringify([{ name: "Second", id: "500000000000000009", token: "test-token-2" }]));
await withEnv({ MOCK_LOG: LOG }, async (c) => {
  const list = JSON.parse((await c.callTool({ name: "list_servers", arguments: {} })).content[0].text);
  assert.deepEqual(list.servers.map((s) => `${s.name}/${s.bot}`).sort(), ["Other Server/Second", "Test Server/TestBot"]);
  if (existsSync(LOG)) unlinkSync(LOG);
  const other = JSON.parse((await c.callTool({ name: "get_server", arguments: { server: "Other Server" } })).content[0].text);
  assert.equal(other.server.name, "Other Server");
  const reqs = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.path.startsWith("/guilds/100000000000000002"));
  assert.ok(reqs.length && reqs.every((r) => r.auth === "Bot test-token-2"), "used the second bot");
  const noServer = await c.callTool({ name: "get_server", arguments: {} });
  assert.ok(noServer.isError && /Say which server/.test(noServer.content[0].text));
  const bots = JSON.parse((await c.callTool({ name: "list_bots", arguments: {} })).content[0].text);
  assert.equal(bots.bots.length, 2);
});
unlinkSync(join(HOME, ".discord-mcp", "bots.json"));

// Two bots in the same server: default choice, explicit bot, per-server choice, and the "acting as" line.
writeFileSync(join(HOME, ".discord-mcp", "bots.json"), JSON.stringify([{ name: "Third", id: "500000000000000003", token: "test-token-3" }]));
await withEnv({ MOCK_LOG: LOG }, async (c) => {
  const list = JSON.parse((await c.callTool({ name: "list_servers", arguments: {} })).content[0].text);
  assert.equal(list.servers.filter((s) => s.id === "100000000000000001").length, 2);
  assert.ok(list.servers.every((s) => s.shared_with_other_bots));
  let r = await c.callTool({ name: "list_roles", arguments: { server: "Test Server" } });
  assert.match(r.content[1].text, /Acting as TestBot in Test Server \(Third is also in this server/);
  r = await c.callTool({ name: "list_roles", arguments: { server: "Test Server", bot: "Third" } });
  assert.match(r.content[1].text, /Acting as Third in Test Server/);
  await c.callTool({ name: "set_server_bot", arguments: { server: "Test Server", bot: "Third" } });
  if (existsSync(LOG)) unlinkSync(LOG);
  r = await c.callTool({ name: "list_roles", arguments: { server: "Test Server" } });
  assert.match(r.content[1].text, /Acting as Third/);
  const reqs = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.path.endsWith("/roles"));
  assert.ok(reqs.every((x) => x.auth === "Bot test-token-3"));
  r = await c.callTool({ name: "list_roles", arguments: { bot: "Nobody" } });
  assert.ok(r.isError && /No bot "Nobody"/.test(r.content[0].text));
  r = await c.callTool({ name: "discord_api", arguments: { method: "GET", path: "/guilds/{guild}/channels/2fa-test", server: "Test Server" } });
  assert.ok(r.isError && /two-factor/.test(r.content[0].text));
});
unlinkSync(join(HOME, ".discord-mcp", "bots.json"));
await withEnv({ DISCORD_WRITE_MODE: "readonly" }, async (c) => {
  const names = (await c.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("get_server") && !names.includes("send_message") && !names.includes("delete_channel"));
});
await withEnv({ DISCORD_TOOLSETS: "automations" }, async (c) => {
  const names = (await c.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("send_message") && names.includes("create_role_menu") && !names.includes("discord_api"));
});
await withEnv({ DISCORD_TOOLSETS: "" }, async (c) => {
  // Default: only the core tools, the rest on demand.
  let changed = false;
  c.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed = true; });
  const before = (await c.listTools()).tools.map((x) => x.name);
  assert.ok(before.length >= 40 && before.length <= 55, `core size ${before.length}`);
  assert.ok(before.includes("send_message") && before.includes("enable_tools") && !before.includes("create_role_menu"));
  const r = await c.callTool({ name: "enable_tools", arguments: { packs: ["automations"] } });
  assert.ok(JSON.parse(r.content[0].text).tools.some((t) => t.name === "create_role_menu"));
  const after = (await c.listTools()).tools.map((x) => x.name);
  assert.ok(after.includes("create_role_menu") && !after.includes("discord_api"));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(changed, "client told the tool list changed");
  const off = await c.callTool({ name: "discord_api", arguments: { method: "GET", path: "/guilds/{guild}" } });
  assert.ok(off.isError, "tools of packs that are off cannot be called");
  // Fallback for apps that do not refresh their tool list.
  const via = await c.callTool({ name: "use_tool", arguments: { tool: "discord_api", arguments: { method: "GET", path: "/guilds/{guild}/roles" } } });
  assert.ok(!via.isError, via.content[0].text);
  assert.match(via.content[0].text, /Admin/);
  const bad = await c.callTool({ name: "use_tool", arguments: { tool: "create_role_menu", arguments: {} } });
  assert.ok(bad.isError && /Wrong arguments for create_role_menu/.test(bad.content[0].text));
  const desc = JSON.parse(r.content[0].text).tools.find((t) => t.name === "create_role_menu");
  assert.ok(desc.parameters.options && desc.required.includes("channel") && !desc.required.includes("style"), "defaults are optional");
});
await withEnv({ DISCORD_ALLOWED_GUILDS: "999999999999999999" }, async (c) => {
  const r = await c.callTool({ name: "get_server", arguments: { server: "100000000000000001" } });
  assert.ok(r.isError && /limited to these servers/.test(r.content[0].text));
});
await withEnv({ DISCORD_WRITE_MODE: "preview" }, async (c) => {
  const r = await c.callTool({ name: "create_role", arguments: { name: "X" } });
  assert.equal(JSON.parse(r.content[0].text).dry_run, true);
});

// Schedules keep the local time across daylight saving changes.
{
  const { nextRun, zoned } = await import("../src/features.js");
  const first = zoned(2026, 9, 24, 9, 0, "Europe/Lisbon"); // 24 Oct 2026, 09:00 summer time (08:00 UTC)
  assert.equal(new Date(first).toISOString(), "2026-10-24T08:00:00.000Z");
  const after = nextRun({ first, every: "day", timezone: "Europe/Lisbon" }, Date.parse("2026-10-25T12:00:00Z"));
  assert.equal(new Date(after).toISOString(), "2026-10-26T09:00:00.000Z", "09:00 winter time");
  assert.equal(nextRun({ first: 0, every: "hour", until: 7200000 }, 7200000), null, "until is respected");
  console.log("ok schedules across DST");
}

// Live events, automations, jobs and utilities against the fake gateway.
const INBOX = join(HOME, "inbox.jsonl");
writeFileSync(INBOX, "");
const push = (t, d) => appendFileSync(INBOX, JSON.stringify({ t, d }) + "\n");
const G = "100000000000000001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
};
await withEnv({ MOCK_LOG: LOG, MOCK_GATEWAY_INBOX: INBOX, DISCORD_GATEWAY: "on" }, async (c) => {
  await sleep(200);
  const st = await call(c, "events_status", {});
  assert.equal(st.bots[0].connected, true);

  push("MESSAGE_CREATE", { id: "700", guild_id: G, channel_id: "200000000000000003", content: "hello there", author: { id: "500000000000000002", username: "alice" }, mentions: [] });
  await sleep(200);
  const ev = await call(c, "get_events", { types: ["message"] });
  assert.equal(ev.events.at(-1).content, "hello there");
  assert.equal(ev.events.at(-1).channel, "💬-general");

  const waiting = call(c, "wait_for_event", { contains: "ping", timeout_seconds: 5 });
  await sleep(150);
  push("MESSAGE_CREATE", { id: "701", guild_id: G, channel_id: "200000000000000003", content: "ping me", author: { id: "500000000000000002", username: "alice" }, mentions: [{ id: "500000000000000001" }] });
  const got = await waiting;
  assert.equal(got.event.content, "ping me");
  assert.equal(got.event.mentions_bot, true);

  // Role menu: a click gives the role and answers privately.
  const menu = await call(c, "create_role_menu", { channel: "general", title: "Pings", options: [{ role: "Updates Ping", emoji: "🔔" }] });
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "900", token: "itok", application_id: "700000000000000001", type: 3, guild_id: G, channel_id: "200000000000000003", data: { custom_id: `dsm:rr:${menu.id}:400000000000000003` }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [] } });
  await sleep(400);
  let reqs = logged();
  assert.ok(reqs.some((r) => r.method === "PUT" && r.path === `/guilds/${G}/members/500000000000000002/roles/400000000000000003`), "role given");
  assert.ok(reqs.some((r) => r.path === "/interactions/900/itok/callback" && r.body.type === 5 && r.body.data.flags === 64), "private answer, deferred");

  // Welcome on join, with an auto-role.
  await call(c, "set_welcome", { channel: "general", message: "Welcome {user} to {server}!", auto_roles: ["Updates Ping"] });
  if (existsSync(LOG)) unlinkSync(LOG);
  push("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "500000000000000005", username: "bob" }, roles: [] });
  await sleep(400);
  reqs = logged();
  assert.ok(reqs.some((r) => r.method === "POST" && r.path === "/channels/200000000000000003/messages" && r.body.content === "Welcome <@500000000000000005> to Test Server!"), "welcome sent");
  assert.ok(reqs.some((r) => r.method === "PUT" && r.path.endsWith("/members/500000000000000005/roles/400000000000000003")), "auto-role");

  // Tickets: opening creates a private channel.
  const panel = await call(c, "create_ticket_panel", { channel: "general", staff_roles: ["Admin"] });
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "901", token: "t2", application_id: "700000000000000001", type: 3, guild_id: G, channel_id: "200000000000000003", data: { custom_id: `dsm:ticket:open:${panel.id}` }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [] } });
  await sleep(400);
  reqs = logged();
  const created = reqs.find((r) => r.method === "POST" && r.path === `/guilds/${G}/channels`);
  assert.equal(created?.body.name, "ticket-0001-alice");
  assert.ok(created.body.permission_overwrites.some((o) => o.id === G && o.deny === String(1 << 10)), "hidden from everyone");
  assert.equal(reqs.find((r) => r.path === "/interactions/901/t2/callback")?.body.type, 5, "deferred first");
  assert.match(reqs.find((r) => r.method === "PATCH" && r.path === "/webhooks/700000000000000001/t2/messages/@original")?.body.content || "", /ticket is open/);
  const auto = await call(c, "list_automations", {});
  assert.equal(auto.open_tickets, 1);

  // Texts follow the server's language (Brazilian Portuguese here) unless a menu sets its own.
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "902", token: "t3", application_id: "700000000000000001", type: 3, guild_id: G, guild_locale: "pt-BR", channel_id: "200000000000000003", data: { custom_id: `dsm:rr:${menu.id}:400000000000000003` }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [] } });
  await sleep(300);
  assert.match(logged().find((r) => r.method === "PATCH" && r.path === "/webhooks/700000000000000001/t3/messages/@original")?.body.content || "", /Você recebeu/);
  const ptMenu = await call(c, "create_role_menu", { channel: "general", title: "Avisos", options: [{ role: "Updates Ping" }], language: "pt", texts: { removed: "Tirado: {label}" } });
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "903", token: "t4", application_id: "700000000000000001", type: 3, guild_id: G, guild_locale: "en-US", channel_id: "200000000000000003", data: { custom_id: `dsm:rr:${ptMenu.id}:400000000000000003` }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [] } });
  await sleep(300);
  assert.match(logged().find((r) => r.method === "PATCH" && r.path === "/webhooks/700000000000000001/t4/messages/@original")?.body.content || "", /Recebeste/);

  // The server's own slash command answers with its saved text.
  if (existsSync(LOG)) unlinkSync(LOG);
  const cmd = await call(c, "create_command", { name: "rules", description: "Show the rules", response: "Be kind, {user}." });
  assert.equal(cmd.created, "/rules");
  assert.ok(logged().some((r) => r.method === "POST" && r.path === `/applications/500000000000000001/guilds/${G}/commands` && r.body.name === "rules"));
  push("INTERACTION_CREATE", { id: "904", token: "t5", type: 2, guild_id: G, channel_id: "200000000000000003", data: { id: "900000000000000001", name: "rules" }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [] } });
  await sleep(300);
  assert.equal(logged().find((r) => r.path === "/interactions/904/t5/callback")?.body.data.content, "Be kind, <@500000000000000002>.");
  // Translated: name per locale and the answer in the member's language.
  if (existsSync(LOG)) unlinkSync(LOG);
  await call(c, "create_command", { name: "rules", description: "Show the rules", response: "Be kind.",
    translations: { "pt-BR": { name: "regras", response: "Sê simpático." }, es: { name: "normas", description: "Ver las normas", response: "Sé amable." } } });
  const upd = logged().find((r) => r.path.includes("/commands"))?.body;
  assert.equal(upd.name_localizations["pt-BR"], "regras");
  assert.equal(upd.name_localizations["es-419"], "normas");
  push("INTERACTION_CREATE", { id: "905", token: "t6", type: 2, guild_id: G, channel_id: "200000000000000003", locale: "es-ES", data: { id: "900000000000000001", name: "rules" }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [] } });
  await sleep(300);
  assert.equal(logged().find((r) => r.path === "/interactions/905/t6/callback")?.body.data.content, "Sé amable.");

  // Moderation log: a deleted message shows what it said; a ban shows who did it.
  await call(c, "set_mod_log", { channel: "announcements" });
  push("MESSAGE_CREATE", { id: "710", guild_id: G, channel_id: "200000000000000003", content: "secret text", author: { id: "500000000000000002", username: "alice" }, mentions: [] });
  await sleep(150);
  if (existsSync(LOG)) unlinkSync(LOG);
  push("MESSAGE_DELETE", { id: "710", guild_id: G, channel_id: "200000000000000003" });
  push("GUILD_AUDIT_LOG_ENTRY_CREATE", { guild_id: G, action_type: 22, target_id: "500000000000000005", user_id: "500000000000000002", reason: "spam" });
  await sleep(400);
  const logs = logged().filter((r) => r.method === "POST" && r.path === "/channels/200000000000000002/messages").map((r) => r.body.embeds[0]);
  assert.ok(logs.some((e) => e.title === "Message deleted" && e.fields.some((f) => f.value.includes("secret text"))), "deleted message logged");
  assert.ok(logs.some((e) => e.title === "Member banned" && e.fields.some((f) => f.value === "spam")), "ban logged");
  push("MESSAGE_CREATE", { id: "711", guild_id: G, channel_id: "200000000000000003", content: "first", author: { id: "500000000000000002", username: "alice" }, mentions: [] });
  await sleep(150);
  if (existsSync(LOG)) unlinkSync(LOG);
  push("MESSAGE_UPDATE", { id: "711", guild_id: G, channel_id: "200000000000000003", content: "second", author: { id: "500000000000000002", username: "alice" } });
  await sleep(300);
  const edit = logged().find((r) => r.path === "/channels/200000000000000002/messages")?.body.embeds[0];
  assert.equal(edit?.title, "Message edited");
  assert.deepEqual(edit.fields.slice(1).map((f) => f.value), ["first", "second"], "before and after");
  // The bot's own role-menu changes and ticket channels stay out of the log.
  if (existsSync(LOG)) unlinkSync(LOG);
  push("GUILD_AUDIT_LOG_ENTRY_CREATE", { guild_id: G, action_type: 25, target_id: "500000000000000002", user_id: "500000000000000001", reason: "Role menu",
    changes: [{ key: "$add", new_value: [{ id: "1", name: "Blue" }] }] });
  push("GUILD_AUDIT_LOG_ENTRY_CREATE", { guild_id: G, action_type: 10, target_id: "200000000000000099", user_id: "500000000000000001", reason: "Ticket opened", changes: [{ key: "name", new_value: "ticket-0002-bob" }] });
  await sleep(300);
  assert.ok(!logged().some((r) => r.path === "/channels/200000000000000002/messages"), "automation noise left out");
  const list = await call(c, "list_automations", {});
  assert.equal(list.commands[0].command, "/rules");
  assert.equal(list.mod_logs.length, 1);

  // Staff alerts: a ban pings the staff role; quick joins count as a raid.
  await call(c, "set_staff_alerts", { channel: "general", ping_role: "Admin", on: ["ban", "raid"], raid_joins: 2, raid_seconds: 60 });
  if (existsSync(LOG)) unlinkSync(LOG);
  push("GUILD_AUDIT_LOG_ENTRY_CREATE", { guild_id: G, action_type: 22, target_id: "500000000000000006", user_id: "500000000000000002", reason: "raid" });
  push("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "500000000000000007", username: "r1" }, roles: [] });
  push("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "500000000000000008", username: "r2" }, roles: [] });
  await sleep(500);
  const alerts = logged().filter((r) => r.method === "POST" && r.path === "/channels/200000000000000003/messages" && r.body.content === "<@&400000000000000001>");
  assert.ok(alerts.some((r) => r.body.embeds[0].title === "Member banned"), "ban alert");
  assert.ok(alerts.some((r) => /Possible raid: 2 joins/.test(r.body.embeds[0].title)), "raid alert");

  // Staff commands: registered with permissions; /slowmode works; /ban respects the role order and names who did it.
  if (existsSync(LOG)) unlinkSync(LOG);
  const sc = await call(c, "enable_staff_commands", {});
  assert.ok(sc.enabled.includes("/ban"));
  const ban = logged().find((r) => r.method === "POST" && r.path.endsWith("/commands") && r.body.name === "ban");
  assert.equal(ban.body.default_member_permissions, String(1 << 2));
  assert.equal(ban.body.name_localizations["pt-BR"], "banir");
  if (existsSync(LOG)) unlinkSync(LOG);
  const staffMember = { user: { id: "500000000000000002", username: "alice" }, roles: ["400000000000000001"], permissions: "8" };
  push("INTERACTION_CREATE", { id: "910", token: "s1", application_id: "700000000000000001", type: 2, guild_id: G, channel_id: "200000000000000003",
    data: { id: "x1", name: "slowmode", options: [{ name: "seconds", type: 4, value: 30 }] }, member: staffMember });
  push("INTERACTION_CREATE", { id: "911", token: "s2", application_id: "700000000000000001", type: 2, guild_id: G, channel_id: "200000000000000003",
    data: { id: "x2", name: "ban", options: [{ name: "member", type: 6, value: "500000000000000005" }, { name: "reason", type: 3, value: "spam" }] }, member: staffMember });
  push("INTERACTION_CREATE", { id: "912", token: "s3", application_id: "700000000000000001", type: 2, guild_id: G, channel_id: "200000000000000003",
    data: { id: "x3", name: "ban", options: [{ name: "member", type: 6, value: "500000000000000005" }] }, member: { ...staffMember, permissions: "0" } });
  await sleep(2000);
  reqs = logged();
  assert.ok(reqs.some((r) => r.method === "PATCH" && r.path === "/channels/200000000000000003" && r.body.rate_limit_per_user === 30), "slowmode");
  const banReq = reqs.find((r) => r.method === "PUT" && r.path === `/guilds/${G}/bans/500000000000000005`);
  assert.equal(decodeURIComponent(banReq?.reason || ""), "/ban · 500000000000000002 · spam");
  assert.match(reqs.find((r) => r.path === "/webhooks/700000000000000001/s2/messages/@original")?.body.content || "", /was banned/);
  assert.match(reqs.find((r) => r.path === "/interactions/912/s3/callback")?.body.data.content || "", /permission/);

  // Command names: translated per member by default, one language for everyone on request.
  if (existsSync(LOG)) unlinkSync(LOG);
  await call(c, "enable_staff_commands", { commands: ["lock", "role"], command_names: "es", language: "es" });
  const esLock = logged().find((r) => r.method === "POST" && r.path.endsWith("/commands") && r.body.description?.startsWith("Lock"))?.body;
  assert.equal(esLock.name, "bloquear");
  assert.equal(esLock.name_localizations, undefined);
  const esRole = logged().find((r) => r.method === "POST" && r.path.endsWith("/commands") && r.body.name === "rol")?.body;
  assert.deepEqual(esRole.options.map((o) => o.name), ["dar", "quitar"]);
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "916", token: "s7", application_id: "700000000000000001", type: 2, guild_id: G, channel_id: "200000000000000003",
    data: { id: "nope", name: "rol", options: [{ type: 1, name: "dar", options: [{ name: "member", type: 6, value: "500000000000000002" }, { name: "role", type: 8, value: "400000000000000003" }] }] }, member: staffMember });
  await sleep(800);
  reqs = logged();
  assert.ok(reqs.some((r) => r.method === "PUT" && r.path === `/guilds/${G}/members/500000000000000002/roles/400000000000000003`), "translated subcommand works");
  assert.match(reqs.find((r) => r.path === "/webhooks/700000000000000001/s7/messages/@original")?.body.content || "", /ha recibido/);
  await call(c, "enable_staff_commands", { commands: ["lock", "role"] });

  // The log shows the staff member, not the bot, for actions done with staff commands.
  if (existsSync(LOG)) unlinkSync(LOG);
  push("GUILD_AUDIT_LOG_ENTRY_CREATE", { guild_id: G, action_type: 22, target_id: "500000000000000005", user_id: "500000000000000001", reason: "/ban · 500000000000000002 · spam" });
  await sleep(300);
  const byField = logged().find((r) => r.path === "/channels/200000000000000002/messages")?.body.embeds[0].fields.find((f) => f.name === "By");
  assert.equal(byField?.value, "<@500000000000000002> (/ban)");

  // Filtering the log: by member here, and with /modlog in Discord.
  const found = await call(c, "search_mod_log", { member: "500000000000000005", event: "banned" });
  assert.ok(found.count >= 1 && found.entries[0].actor === "500000000000000002");
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "913", token: "s4", application_id: "700000000000000001", type: 2, guild_id: G, channel_id: "200000000000000003",
    data: { id: "x4", name: "modlog", options: [{ name: "member", type: 6, value: "500000000000000005" }] }, member: staffMember });
  await sleep(300);
  assert.match(logged().find((r) => r.path === "/webhooks/700000000000000001/s4/messages/@original")?.body.embeds?.[0].description || "", /banned/);

  // Tickets: staff claim one; closing it keeps it in the history.
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "914", token: "s5", type: 3, guild_id: G, channel_id: "200000000000000099", channel: { name: "ticket-0001-alice" },
    data: { custom_id: "dsm:ticket:claim" }, member: staffMember });
  await sleep(300);
  assert.match(logged().find((r) => r.path === "/interactions/914/s5/callback")?.body.data.content || "", /is handling this ticket/);
  push("INTERACTION_CREATE", { id: "915", token: "s6", type: 3, guild_id: G, channel_id: "200000000000000099", channel: { name: "ticket-0001-alice" },
    data: { custom_id: "dsm:ticket:close" }, member: staffMember });
  await sleep(6000);
  const hist = await call(c, "ticket_history", {});
  assert.equal(hist.tickets[0].name, "ticket-0001-alice");
  assert.equal(hist.tickets[0].claimed_by, "500000000000000002");
  const one = await call(c, "ticket_history", { ticket: "1" });
  assert.match(one.transcript, /# ticket-0001-alice/);

  // A forum log: one post per member with tags per kind.
  if (existsSync(LOG)) unlinkSync(LOG);
  const fl = await call(c, "set_mod_log", { channel: "bug-reports", events: ["moderation"] });
  assert.equal(fl.forum, true);
  assert.ok(logged().some((r) => r.method === "PATCH" && r.path === "/channels/200000000000000004" && r.body.available_tags.some((t) => t.name === "Moderation")));
  push("GUILD_AUDIT_LOG_ENTRY_CREATE", { guild_id: G, action_type: 20, target_id: "500000000000000002", user_id: "500000000000000002", reason: "test" });
  await sleep(400);
  const post = logged().find((r) => r.method === "POST" && r.path === "/channels/200000000000000004/threads");
  assert.match(post?.body.name || "", /· 500000000000000002$/);
  assert.equal(post.body.message.embeds[0].title, "Member kicked");

  // A ticket panel with a staff channel: made private, gets "opened" with the Claim button, and claims from there.
  if (existsSync(LOG)) unlinkSync(LOG);
  const p2 = await call(c, "create_ticket_panel", { channel: "general", staff_roles: ["Admin"], log_channel: "announcements", texts: { ticket_log_opened: "New ticket" } });
  assert.ok(p2.log_channel_now_private);
  assert.ok(logged().some((r) => r.method === "PUT" && r.path === `/channels/200000000000000002/permissions/${G}` && BigInt(r.body.deny) & 1024n));
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "920", token: "u1", application_id: "700000000000000001", type: 3, guild_id: G, channel_id: "200000000000000003",
    data: { custom_id: `dsm:ticket:open:${p2.id}` }, member: { user: { id: "500000000000000005", username: "bob" }, roles: [], permissions: "0" } });
  await sleep(600);
  reqs = logged();
  const opened = reqs.find((r) => r.method === "POST" && r.path === "/channels/200000000000000002/messages")?.body;
  assert.match(opened?.embeds[0].title || "", /^New ticket/);
  const claimBtn = opened.components[0].components.find((b) => b.custom_id?.startsWith("dsm:ticket:claim:"));
  assert.ok(claimBtn, "claim button in the staff channel");
  const inTicket = reqs.find((r) => r.method === "POST" && r.path === "/channels/200000000000000099/messages" && r.body.components)?.body;
  assert.ok(!inTicket.components[0].components.some((b) => b.custom_id === "dsm:ticket:claim"), "no claim button for the member");
  await call(c, "edit_automation", { id: p2.id, texts: { claim_label: "Take it" } });

  // Support forum: a new post gets the Open tag and the Solved button; Solved closes it.
  if (existsSync(LOG)) unlinkSync(LOG);
  const sf = await call(c, "set_support_forum", { forum: "bug-reports", staff_roles: ["Admin"] });
  assert.equal(sf.tags.solved, "Solved");
  push("THREAD_CREATE", { id: "750", guild_id: G, parent_id: "200000000000000004", owner_id: "500000000000000002", newly_created: true, name: "help" });
  await sleep(2200);
  reqs = logged();
  const welcomePost = reqs.find((r) => r.method === "POST" && r.path === "/channels/750/messages")?.body;
  assert.ok(welcomePost?.components[0].components.some((b) => b.custom_id === "dsm:sf:solve"), "Solved button");
  assert.ok(reqs.some((r) => r.method === "PATCH" && r.path === "/channels/750" && r.body.applied_tags), "Open tag");
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "930", token: "f1", type: 3, guild_id: G, channel_id: "750", channel: { id: "750", parent_id: "200000000000000004", owner_id: "500000000000000002" },
    data: { custom_id: "dsm:sf:solve" }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [], permissions: "0" } });
  await sleep(500);
  reqs = logged();
  assert.match(reqs.find((r) => r.path === "/interactions/930/f1/callback")?.body.data.content || "", /solved by/);
  assert.ok(reqs.some((r) => r.method === "PATCH" && r.path === "/channels/750" && r.body.archived === true && r.body.locked === true), "closed and locked");

  // A rule: answer a question with a fixed text.
  await call(c, "create_rule", { name: "ip", when: { event: "message", words: ["ip"] }, then: [{ action: "reply", text: "The IP is mc.example.com, {user}" }] });
  if (existsSync(LOG)) unlinkSync(LOG);
  push("MESSAGE_CREATE", { id: "760", guild_id: G, channel_id: "200000000000000003", content: "what is the IP?", author: { id: "500000000000000002", username: "alice" }, member: { roles: [] }, mentions: [] });
  push("MESSAGE_CREATE", { id: "761", guild_id: G, channel_id: "200000000000000003", content: "zipper", author: { id: "500000000000000002", username: "alice" }, member: { roles: [] }, mentions: [] });
  await sleep(500);
  const replies = logged().filter((r) => r.method === "POST" && r.path === "/channels/200000000000000003/messages" && /mc\.example\.com/.test(r.body.content || ""));
  assert.equal(replies.length, 1, "whole words only");
  assert.equal(replies[0].body.content, "The IP is mc.example.com, <@500000000000000002>");

  // Verification button gives the role; dropdown menus set exactly the chosen roles.
  const ver = await call(c, "create_verification", { channel: "general", role: "Updates Ping" });
  const dd = await call(c, "create_role_menu", { channel: "general", title: "Pick", style: "dropdown", options: [{ role: "Updates Ping" }] });
  const ddMsg = logged().reverse().find((r) => r.method === "POST" && r.body?.components?.[0]?.components?.[0]?.type === 3)?.body;
  assert.equal(ddMsg.components[0].components[0].custom_id, `dsm:rr:${dd.id}:select`);
  if (existsSync(LOG)) unlinkSync(LOG);
  push("INTERACTION_CREATE", { id: "931", token: "v1", application_id: "700000000000000001", type: 3, guild_id: G, channel_id: "200000000000000003",
    data: { custom_id: `dsm:verify:${ver.id}` }, member: { user: { id: "500000000000000005", username: "bob" }, roles: [], permissions: "0" } });
  push("INTERACTION_CREATE", { id: "932", token: "v2", application_id: "700000000000000001", type: 3, guild_id: G, channel_id: "200000000000000003",
    data: { custom_id: `dsm:rr:${dd.id}:select`, values: ["400000000000000003"] }, member: { user: { id: "500000000000000002", username: "alice" }, roles: [], permissions: "0" } });
  await sleep(600);
  reqs = logged();
  assert.ok(reqs.some((r) => r.method === "PUT" && r.path === `/guilds/${G}/members/500000000000000005/roles/400000000000000003`), "verified");
  assert.match(reqs.find((r) => r.path === "/webhooks/700000000000000001/v2/messages/@original")?.body.content || "", /Updates Ping/);

  // Scheduled message: sent when due.
  if (existsSync(LOG)) unlinkSync(LOG);
  const sch = await call(c, "schedule_message", { channel: "general", content: "Weekly reminder", at: new Date(Date.now() + 1500).toISOString(), every: "week" });
  assert.equal(sch.repeats, "every week");
  await sleep(2500);
  assert.ok(logged().some((r) => r.method === "POST" && r.path === "/channels/200000000000000003/messages" && r.body.content === "Weekly reminder"), "scheduled message sent");
  const after = (await call(c, "list_automations", {})).schedules.find((x) => x.id === sch.scheduled);
  assert.equal(after.sent, 1);

  // Reordering roles gives each movable role its own position.
  if (existsSync(LOG)) unlinkSync(LOG);
  await call(c, "reorder_roles", { roles: ["Updates Ping"] });
  const patch = logged().find((r) => r.method === "PATCH" && r.path === `/guilds/${G}/roles`);
  const positions = patch.body.map((x) => x.position);
  assert.equal(new Set(positions).size, positions.length, "distinct positions");
  const bad = await c.callTool({ name: "reorder_roles", arguments: { roles: ["Admin"] } });
  assert.ok(bad.isError && /cannot move it/.test(bad.content[0].text));

  // Jobs: backup to files, bulk role change.
  const folder = join(HOME, "backup");
  const job = await call(c, "backup_messages", { channels: ["general"], folder });
  for (let i = 0; i < 20 && (await call(c, "job_status", { job_id: job.job_id })).status !== "done"; i++) await sleep(100);
  assert.equal((await call(c, "job_status", { job_id: job.job_id })).status, "done");
  assert.ok(existsSync(join(folder, "general.json")) && existsSync(join(folder, "general.html")) && existsSync(join(folder, "general.md")));
  const preview = await call(c, "bulk_role_update", { role: "Admin", action: "add" });
  assert.equal(preview.dry_run, true);
  const bulk = await call(c, "bulk_role_update", { role: "Admin", action: "add", confirm: true });
  for (let i = 0; i < 20 && (await call(c, "job_status", { job_id: bulk.job_id })).status !== "done"; i++) await sleep(100);
  assert.equal((await call(c, "job_status", { job_id: bulk.job_id })).status, "done");

  // Utilities.
  if (existsSync(LOG)) unlinkSync(LOG);
  await call(c, "lock_channel", { channel: "general" });
  const lock = logged().find((r) => r.method === "PUT" && r.path.includes("/permissions/"));
  assert.ok(BigInt(lock.body.deny) & (1n << 11n), "send messages denied");
  assert.ok(BigInt(lock.body.deny) & (1n << 6n), "reactions denied too");
  const stats = await call(c, "server_stats", {});
  assert.equal(stats.server, "Test Server");
});

// HTTP transport with a bearer token.
{
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { spawn } = await import("node:child_process");
  const port = 39000 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ["--import", join(here, "mock.mjs"), join(here, "..", "dist", "index.mjs"), "serve", "--http", "--port", String(port)],
    { env: { ...process.env, HOME, USERPROFILE: HOME, DISCORD_BOT_TOKEN: "test-token", DISCORD_MCP_HTTP_TOKEN: "s3cret-s3cret-s3cret" }, stdio: "ignore" });
  await sleep(800);
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 401);
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer s3cret-s3cret-s3cret" } } });
    const c = new Client({ name: "http", version: "1" });
    await c.connect(t);
    const n = (await c.listTools()).tools.length;
    assert.ok(n >= 40 && n <= 55, `core size over HTTP ${n}`);
    const r = await c.callTool({ name: "get_server", arguments: {} });
    assert.match(r.content[0].text, /Test Server/);
    await c.close();
    console.log(`ok   http transport (${n} tools)`);
  } catch (e) {
    failures++;
    console.log(`FAIL http transport: ${e.message}`);
  } finally {
    proc.kill();
  }
}

unlinkSync(IMG);
if (existsSync(LOG)) unlinkSync(LOG);
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
