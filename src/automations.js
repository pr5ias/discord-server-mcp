// Automations that react to Discord events while a bot is connected: role menus (buttons or reactions),
// welcome messages and auto-roles, support tickets, the server's own slash commands, and a moderation log.
// They run while the MCP server runs (Claude open) or around the clock with `discord-server-mcp run`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { api, callContext, defined } from "./discord.js";
import { onEvent } from "./gateway.js";
import { text } from "./i18n.js";
import { archive, typeOf } from "./modlog.js";
import { handleStaffCommand } from "./staff.js";
import { startFeatures, handleForumButton, handleVerify, isSupportPost } from "./features.js";

export const AUTOMATIONS_FILE = join(homedir(), ".discord-mcp", "automations.json");
export const TICKETS_DIR = join(homedir(), ".discord-mcp", "tickets");
let data = { role_menus: [], welcomes: [], ticket_panels: [], tickets: [], closed_tickets: [], commands: [], mod_logs: [], alerts: [], staff_commands: [],
  support_forums: [], rules: [], verifications: [], schedules: [] };
try {
  data = { ...data, ...JSON.parse(readFileSync(AUTOMATIONS_FILE, "utf8")) };
} catch {
  // none yet
}

export const automations = () => data;
export const newId = () => randomBytes(3).toString("hex");

export function saveAutomations() {
  mkdirSync(dirname(AUTOMATIONS_FILE), { recursive: true });
  writeFileSync(AUTOMATIONS_FILE, JSON.stringify(data, null, 2));
}

export const asBot = (bot, fn) => callContext.run({ dryRun: false, planned: [], token: bot.token }, fn);
export const ephemeral = (d, content) => api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

/** The server's language, cached (interactions carry it; other events need one lookup). */
const locales = new Map();
export async function guildLocale(guild, hint) {
  if (hint) locales.set(guild, hint);
  if (!locales.has(guild)) locales.set(guild, (await api("GET", `/guilds/${guild}`).catch(() => ({}))).preferred_locale || "en-US");
  return locales.get(guild);
}

/** The translation for a Discord locale ("es-419" → "es", "en-GB" → "en"), if any. */
export function translationFor(translations, locale) {
  if (!translations || !locale) return undefined;
  const l = String(locale);
  return translations[l] || translations[l.split("-")[0]] || (l.startsWith("pt") ? translations.pt || translations["pt-BR"] : undefined);
}

export function fillTemplate(value, { user, guildName, memberCount }) {
  return String(value || "")
    .replaceAll("{user}", `<@${user.id}>`).replaceAll("{username}", user.global_name || user.username)
    .replaceAll("{server}", guildName).replaceAll("{member_count}", String(memberCount ?? ""));
}

async function toggleRole(menu, guild, userId, roleId, add) {
  const option = menu.options.find((o) => o.role_id === roleId);
  if (!option) return null;
  const member = await api("GET", `/guilds/${guild}/members/${userId}`);
  const has = member.roles.includes(roleId);
  const want = add === undefined ? !has : add;
  if (want && !has) {
    if (menu.unique) {
      for (const o of menu.options) if (o.role_id !== roleId && member.roles.includes(o.role_id)) await api("DELETE", `/guilds/${guild}/members/${userId}/roles/${o.role_id}`, undefined, { reason: AUTO_REASONS.roleMenu });
    }
    await api("PUT", `/guilds/${guild}/members/${userId}/roles/${roleId}`, undefined, { reason: AUTO_REASONS.roleMenu });
  } else if (!want && has) {
    await api("DELETE", `/guilds/${guild}/members/${userId}/roles/${roleId}`, undefined, { reason: AUTO_REASONS.roleMenu });
  }
  return { option, added: want };
}

/** Every message of a channel, oldest first (up to max). */
async function allMessages(channelId, max = 10000) {
  const out = [];
  let before;
  while (out.length < max) {
    const page = await api("GET", `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!page.length) break;
    out.push(...page);
    before = page.at(-1).id;
    if (page.length < 100) break;
  }
  return out.reverse();
}

function transcript(msgs, title) {
  const lines = [`# ${title}`, ""];
  for (const m of msgs) {
    lines.push(`**${m.author.global_name || m.author.username}** · ${m.timestamp}`);
    if (m.content) lines.push(m.content);
    for (const e of m.embeds || []) lines.push(`> ${[e.title, e.description].filter(Boolean).join(" — ")}`);
    for (const a of m.attachments || []) lines.push(`📎 ${a.filename}: ${a.url}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ moderation log

/** Recent messages of logged servers, so deletions and edits can show what was there. */
const seen = new Map();
const SEEN_MAX = 5000;
const logsFor = (guild, bot, kind) => data.mod_logs.filter((l) => l.guild === guild && l.bot === bot.id && l.enabled !== false && (l.events || []).includes(kind));

const COLORS = { red: 0xed4245, orange: 0xf0b232, green: 0x57f287, blue: 0x5865f2, grey: 0x99aab5 };
const clip = (s, n = 1000) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const who = (u) => (u ? `<@${u.id}> (${u.global_name || u.username || u.id})` : "?");

/** Embed of a log entry in the log's language. */
function logEmbed(log, locale, { title, color = "grey", fields = [], description, user, subject, actor }) {
  const t = (k, vars) => text(k, { lang: log.language, locale, texts: log.texts, vars });
  return {
    title: t(title.key, title.vars), description, color: COLORS[color],
    fields: fields.filter((f) => f.value).map((f) => ({ name: t(f.key), value: clip(String(f.value?.key ? t(f.value.key) : f.value), 1024), inline: f.inline })),
    thumbnail: user?.avatar ? { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` } : undefined,
    // Ids as plain text make Discord's own search find every entry about a member.
    footer: { text: [subject && `${t("log_member")}: ${subject}`, actor && actor !== subject && `${t("log_by")}: ${actor}`].filter(Boolean).join(" · ") || "—" },
    timestamp: new Date().toISOString(),
  };
}

const names = new Map();
export async function nameOf(id, user) {
  if (user?.username) names.set(id, user.global_name || user.username);
  if (!names.has(id)) names.set(id, await api("GET", `/users/${id}`).then((u) => u.global_name || u.username).catch(() => id));
  return names.get(id);
}

/**
 * Forum logs: one post per member ("alice · 123…") with every event about them, tagged by kind, so staff
 * can filter by tag, by member, or both. Events about no member go to one "Server" post.
 */
async function postToForum(log, locale, entry, kind) {
  const embed = logEmbed(log, locale, entry);
  const key = entry.subject || "server";
  const tag = log.tags?.[kind];
  log.threads ||= {};
  let thread = log.threads[key];
  if (thread) {
    const send = () => api("POST", `/channels/${thread}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } }).then(() => true).catch(() => false);
    if (!(await send())) {
      // Archived posts are reopened; deleted ones are made again below.
      const reopened = await api("PATCH", `/channels/${thread}`, { archived: false }).catch(() => null);
      if (!reopened || !(await send())) thread = undefined;
    }
    if (thread && tag) {
      const info = await api("GET", `/channels/${thread}`).catch(() => null);
      const applied = info?.applied_tags || [];
      if (info && !applied.includes(tag)) await api("PATCH", `/channels/${thread}`, { applied_tags: [...applied, tag].slice(-5) }).catch(() => {});
    }
  }
  if (!thread) {
    const title = entry.subject ? `${await nameOf(entry.subject, entry.user)} · ${entry.subject}` : text("log_server_post", { lang: log.language, locale });
    const created = await api("POST", `/channels/${log.channel}/threads`, {
      name: title.slice(0, 100), applied_tags: tag ? [tag] : undefined,
      message: { embeds: [embed], allowed_mentions: { parse: [] } },
    }).catch(() => null);
    if (created) {
      log.threads[key] = created.id;
      saveAutomations();
    }
  }
}

async function postLog(log, locale, entry, kind) {
  if (log.forum) return postToForum(log, locale, entry, kind);
  return api("POST", `/channels/${log.channel}/messages`, { embeds: [logEmbed(log, locale, entry)], allowed_mentions: { parse: [] } }).catch(() => {});
}

/** Plain text of an entry for the archive. */
function plain(entry) {
  return entry.fields.filter((f) => f.value && !f.value.key).map((f) => `${f.key.replace(/^log_/, "")}: ${f.value}`).join(" | ");
}

export async function logEvent(guild, bot, kind, entry) {
  if (entry.channelId && data.tickets.some((x) => x.channel_id === entry.channelId)) return;
  const all = data.mod_logs.filter((l) => l.guild === guild && l.bot === bot.id && l.enabled !== false);
  const alerts = data.alerts.filter((a) => a.guild === guild && a.bot === bot.id && a.enabled !== false);
  if (!all.length && !alerts.length) return;
  if (all.length) {
    archive(guild, { kind, type: typeOf(entry.title.key), subject: entry.subject, actor: entry.actor, channel: entry.channelId,
      description: entry.description, summary: plain(entry) });
  }
  const locale = await guildLocale(guild);
  for (const log of all) {
    if (!(log.events || []).includes(kind)) continue;
    if (entry.channelId && (entry.channelId === log.channel || (log.ignore_channels || []).includes(entry.channelId))) continue;
    await postLog(log, locale, entry, kind);
  }
  for (const a of alerts) await sendAlert(a, locale, entry);
}

// ------------------------------------------------------------------ staff alerts

/** Which alert an entry is, if any. */
const ALERT_OF = { log_banned: "ban", log_kicked: "kick", log_timeout: "timeout", log_automod: "automod", log_raid: "raid" };

async function sendAlert(a, locale, entry) {
  const kind = ALERT_OF[entry.title.key];
  if (!kind || !(a.on || []).includes(kind)) return;
  const embed = logEmbed({ language: a.language, texts: a.texts }, locale, entry);
  if (a.channel) {
    await api("POST", `/channels/${a.channel}/messages`, {
      content: a.ping_role ? `<@&${a.ping_role}>` : undefined, embeds: [embed], allowed_mentions: { roles: a.ping_role ? [a.ping_role] : [] },
    }).catch(() => {});
  }
  for (const u of a.dm_users || []) {
    const dm = await api("POST", "/users/@me/channels", { recipient_id: u }).catch(() => null);
    if (dm) await api("POST", `/channels/${dm.id}/messages`, { embeds: [embed] }).catch(() => {});
  }
}

/** Recent joins per server, to spot raids. */
const joins = new Map();
async function checkRaid(guild, bot) {
  const list = data.alerts.filter((a) => a.guild === guild && a.bot === bot.id && a.enabled !== false && (a.on || []).includes("raid"));
  if (!list.length) return;
  const now = Date.now();
  const key = `${bot.id}:${guild}`;
  const recent = (joins.get(key) || []).filter((x) => now - x < 10 * 60 * 1000);
  recent.push(now);
  joins.set(key, recent);
  const locale = await guildLocale(guild);
  for (const a of list) {
    const window = (a.raid_seconds || 60) * 1000;
    const count = recent.filter((x) => now - x <= window).length;
    if (count >= (a.raid_joins || 10) && now - (a.last_raid || 0) > window) {
      a.last_raid = now;
      await sendAlert(a, locale, { title: { key: "log_raid", vars: { count, seconds: a.raid_seconds || 60 } }, color: "red", fields: [] });
    }
  }
}

/** Staff commands write "/ban · <member id> · reason" so the log can show who really did it. */
export const staffReason = (command, userId, why) => [`/${command}`, userId, why].filter(Boolean).join(" · ");
function parseReason(d) {
  const m = /^\/(\S+) · (\d+)(?: · ([\s\S]*))?$/.exec(d.reason || "");
  return m ? { actor: m[2], command: m[1], reason: m[3] } : { actor: d.user_id, reason: d.reason };
}

function withPeople(d, entry) {
  if (!entry) return entry;
  return { ...entry, subject: [20, 22, 23, 24, 25].includes(d.action_type) ? d.target_id : undefined, actor: parseReason(d).actor };
}

function auditEntry(d) {
  const change = (key) => d.changes?.find((c) => c.key === key);
  const target = { id: d.target_id };
  const r = parseReason(d);
  const by = { key: "log_by", value: r.actor ? `<@${r.actor}>${r.command ? ` (/${r.command})` : ""}` : undefined, inline: true };
  const reason = { key: "log_reason", value: r.reason };
  const member = { key: "log_member", value: d.target_id ? `<@${d.target_id}>` : undefined, inline: true };
  switch (d.action_type) {
    case 20: return { kind: "moderation", title: { key: "log_kicked" }, color: "orange", fields: [member, by, reason], target };
    case 22: return { kind: "moderation", title: { key: "log_banned" }, color: "red", fields: [member, by, reason], target };
    case 23: return { kind: "moderation", title: { key: "log_unbanned" }, color: "green", fields: [member, by, reason], target };
    case 24: {
      const timeout = change("communication_disabled_until");
      if (timeout) {
        const until = timeout.new_value;
        return until
          ? { kind: "moderation", title: { key: "log_timeout" }, color: "orange",
            fields: [member, by, { key: "log_until", value: `<t:${Math.floor(Date.parse(until) / 1000)}:f>`, inline: true }, reason] }
          : { kind: "moderation", title: { key: "log_timeout_removed" }, color: "green", fields: [member, by] };
      }
      const nick = change("nick");
      if (nick) {
        return { kind: "moderation", title: { key: "log_nickname" }, color: "blue",
          fields: [member, by, { key: "log_before", value: nick.old_value || "—", inline: true }, { key: "log_after", value: nick.new_value || "—", inline: true }] };
      }
      return null;
    }
    case 25: {
      const added = change("$add")?.new_value?.map((r) => r.name).join(", ");
      const removed = change("$remove")?.new_value?.map((r) => r.name).join(", ");
      return { kind: "moderation", title: { key: "log_roles" }, color: "blue",
        fields: [member, by, { key: "log_roles_added", value: added }, { key: "log_roles_removed", value: removed }] };
    }
    case 10: return { kind: "server", title: { key: "log_channel_created" }, color: "green", fields: [{ key: "log_channel", value: `<#${d.target_id}> (${change("name")?.new_value || ""})`, inline: true }, by] };
    case 12: return { kind: "server", title: { key: "log_channel_deleted" }, color: "red", fields: [{ key: "log_channel", value: `#${change("name")?.old_value || d.target_id}`, inline: true }, by] };
    case 30: return { kind: "server", title: { key: "log_role_created" }, color: "green", fields: [{ key: "log_role", value: change("name")?.new_value, inline: true }, by] };
    case 32: return { kind: "server", title: { key: "log_role_deleted" }, color: "red", fields: [{ key: "log_role", value: change("name")?.old_value, inline: true }, by] };
    default: return null;
  }
}

// ------------------------------------------------------------------ wiring

/** Audit log reasons of the bot's own automations; the moderation log leaves these out. */
const AUTO_REASONS = { roleMenu: "Role menu", autoRole: "Auto-role", ticketOpen: "Ticket opened", ticketClose: "Ticket closed", ticketCategory: "Ticket category",
  verification: "Verification" };
// Any bot may have made the change (several bots can share a server), so the reason decides.
const isAutomation = (d) => Object.values(AUTO_REASONS).some((r) => d.reason?.startsWith(r));

/** A line in the panel's staff channel about a ticket (opened, claimed); "opened" carries the Claim button. */
async function ticketLog(panel, t, { title, color, ticket, channelId, guild, fields }) {
  if (!panel?.log_channel || !ticket) return;
  const claimable = title === "ticket_log_opened" && panel.claim !== false;
  await api("POST", `/channels/${panel.log_channel}/messages`, {
    embeds: [{ title: `${t(title)} · ${ticket.name || ""}`, color, fields, timestamp: new Date().toISOString() }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: t("ticket_go").slice(0, 80), url: `https://discord.com/channels/${guild}/${channelId}` },
      ...(claimable ? [{ type: 2, style: 1, label: t("claim_label").slice(0, 80), custom_id: `dsm:ticket:claim:${channelId}`, emoji: { name: "🙋" } }] : []),
    ] }],
    allowed_mentions: { parse: [] },
  }).catch(() => {});
}

/** Staff for a ticket: its staff roles, or anyone who can manage messages or is an administrator. */
export function isStaffMember(d, panel) {
  const perms = BigInt(d.member?.permissions || 0);
  return d.member?.roles?.some((r) => panel?.staff_role_ids?.includes(r)) || (perms & 8n) !== 0n || (perms & (1n << 13n)) !== 0n;
}

let wired = false;
const busy = new Map();

/** Hooks the automations into the live connection. Safe to call more than once. */
export function startAutomations() {
  if (wired) return;
  wired = true;
  startFeatures();

  onEvent("INTERACTION_CREATE", async (d, bot) => {
    const userId = d.member?.user?.id || d.user?.id;
    const locale = d.guild_locale || d.locale;
    if (d.guild_id && d.guild_locale) guildLocale(d.guild_id, d.guild_locale);

    // Staff commands; /ticket close|claim continue below as if the buttons were clicked.
    let staffTicket;
    if (d.type === 2) {
      const staff = data.staff_commands.find((x) => x.guild === d.guild_id && x.bot === bot.id);
      if (staff) {
        const handled = await asBot(bot, () => handleStaffCommand(d, bot, staff, { staffReason })).catch(() => true);
        if (typeof handled === "string") staffTicket = handled;
        else if (handled) return;
      }
    }

    // The server's own slash commands.
    if (d.type === 2 && !staffTicket) {
      const cmd = data.commands.find((c) => c.command_id === d.data?.id || (c.guild === d.guild_id && c.name === d.data?.name && c.bot === bot.id));
      if (!cmd) return;
      await asBot(bot, async () => {
        const user = d.member?.user || d.user;
        const vars = { user, guildName: "", memberCount: "" };
        // The answer in the member's own Discord language, when the command has it.
        const tr = translationFor(cmd.translations, d.locale);
        const response = tr?.response ?? cmd.response;
        await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: {
          content: response ? fillTemplate(response, vars) : undefined,
          embeds: cmd.embed ? [{ title: fillTemplate(tr?.embed_title ?? cmd.embed.title, vars) || undefined, description: fillTemplate(tr?.embed_description ?? cmd.embed.description, vars) || undefined,
            color: cmd.embed.color, image: cmd.embed.image ? { url: cmd.embed.image } : undefined }] : undefined,
          flags: cmd.ephemeral ? 64 : undefined, allowed_mentions: { parse: [] } } });
      }).catch(() => {});
      return;
    }

    if (staffTicket && isSupportPost(d.channel, bot)) {
      await asBot(bot, () => handleForumButton(d, bot, staffTicket === "ticket:close" ? "solve" : "claim")).catch(() => {});
      return;
    }
    const id = staffTicket ? `dsm:${staffTicket}` : d.data?.custom_id || "";
    if ((d.type !== 3 && !staffTicket) || !id.startsWith("dsm:")) return;
    await asBot(bot, async () => {
      const [, kind, a, b] = id.split(":");
      if (kind === "sf") return handleForumButton(d, bot, a, b);
      if (kind === "verify") return handleVerify(d, bot, a);
      if (kind === "rr") {
        const menu = data.role_menus.find((m) => m.id === a);
        const t = (k, vars) => text(k, { lang: menu?.language, locale, texts: menu?.texts, vars });
        if (!menu) return ephemeral(d, t("menu_gone"));
        if (b === "select") {
          // Dropdown: the member's choice becomes exactly their roles from this menu.
          await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: 64 } });
          const reply = (content) => api("PATCH", `/webhooks/${d.application_id}/${d.token}/messages/@original`, { content, allowed_mentions: { parse: [] } });
          const chosen = (d.data.values || []).filter((v) => menu.options.some((o) => o.role_id === v));
          try {
            const member = await api("GET", `/guilds/${d.guild_id}/members/${userId}`);
            for (const o of menu.options) {
              const has = member.roles.includes(o.role_id);
              const want = chosen.includes(o.role_id);
              if (want && !has) await api("PUT", `/guilds/${d.guild_id}/members/${userId}/roles/${o.role_id}`, undefined, { reason: AUTO_REASONS.roleMenu });
              if (!want && has) await api("DELETE", `/guilds/${d.guild_id}/members/${userId}/roles/${o.role_id}`, undefined, { reason: AUTO_REASONS.roleMenu });
            }
            const names = menu.options.filter((o) => chosen.includes(o.role_id)).map((o) => o.label).join(", ");
            return reply(t("menu_updated", { roles: names || t("log_none") }));
          } catch {
            return reply(t("role_error"));
          }
        }
        // Changing roles can take longer than the 3 seconds Discord waits (unique menus remove other roles
        // first), so answer "thinking…" at once and fill in the reply after.
        await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: 64 } });
        const reply = (content) => api("PATCH", `/webhooks/${d.application_id}/${d.token}/messages/@original`, { content, allowed_mentions: { parse: [] } });
        // One change at a time per member and menu, so quick double clicks do not undo each other.
        const key = `${menu.id}:${userId}`;
        const prev = busy.get(key) || Promise.resolve();
        const job = prev.then(async () => {
          try {
            const r = await toggleRole(menu, d.guild_id, userId, b);
            return reply(r ? t(r.added ? "added" : "removed", { label: r.option.label }) : t("unknown_option"));
          } catch {
            return reply(t("role_error"));
          }
        });
        busy.set(key, job.catch(() => {}));
        return job;
      }
      if (kind === "ticket" && a === "open") {
        const panel = data.ticket_panels.find((p) => p.id === b);
        const t = (k, vars) => text(k, { lang: panel?.language, locale, texts: panel?.texts, vars });
        if (!panel) return ephemeral(d, t("tickets_closed"));
        const existing = data.tickets.find((x) => x.panel === panel.id && x.user_id === userId);
        if (existing) {
          // A ticket channel deleted by hand should not block a new ticket.
          const alive = await api("GET", `/channels/${existing.channel_id}`).catch(() => null);
          if (alive) return ephemeral(d, t("ticket_exists", { channel: `<#${existing.channel_id}>` }));
          data.tickets = data.tickets.filter((x) => x !== existing);
          saveAutomations();
        }
        // Creating the channel can take longer than the 3 seconds Discord waits for an answer, so answer
        // "thinking…" first and fill in the reply when the channel exists (then the link also shows its name).
        await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: 64 } });
        const reply = (content) => api("PATCH", `/webhooks/${d.application_id}/${d.token}/messages/@original`, { content });
        const user = d.member.user;
        const can = String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 15n));
        let ch;
        try {
          panel.count = (panel.count || 0) + 1;
          // "Only while tickets are open" categories are made when the first ticket opens.
          if (panel.category_name && !(panel.category_id && await api("GET", `/channels/${panel.category_id}`).catch(() => null))) {
            const same = (await api("GET", `/guilds/${d.guild_id}/channels`)).find((c) => c.type === 4 && c.name.toLowerCase() === panel.category_name.toLowerCase());
            const cat = same || await api("POST", `/guilds/${d.guild_id}/channels`, {
              name: panel.category_name, type: 4,
              permission_overwrites: [{ id: d.guild_id, type: 0, allow: "0", deny: String(1n << 10n) },
                ...(panel.staff_role_ids || []).map((rid) => ({ id: rid, type: 0, allow: String(1n << 10n), deny: "0" }))],
            }, { reason: AUTO_REASONS.ticketCategory });
            panel.category_id = cat.id;
          }
          ch = await api("POST", `/guilds/${d.guild_id}/channels`, {
            name: `ticket-${String(panel.count).padStart(4, "0")}-${user.username}`.slice(0, 90), type: 0, parent_id: panel.category_id || undefined,
            topic: t("ticket_topic", { username: user.global_name || user.username }),
            permission_overwrites: [
              { id: d.guild_id, type: 0, allow: "0", deny: String(1n << 10n) },
              { id: user.id, type: 1, allow: can, deny: "0" },
              { id: bot.id, type: 1, allow: String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 4n)), deny: "0" },
              ...(panel.staff_role_ids || []).map((rid) => ({ id: rid, type: 0, allow: can, deny: "0" })),
            ],
          }, { reason: AUTO_REASONS.ticketOpen });
        } catch {
          return reply(t("ticket_error"));
        }
        data.tickets.push({ channel_id: ch.id, name: ch.name, number: panel.count, user_id: userId, panel: panel.id, opened: new Date().toISOString() });
        saveAutomations();
        await api("POST", `/channels/${ch.id}/messages`, {
          content: fillTemplate(panel.welcome || t("ticket_welcome"), { user, guildName: "", memberCount: "" })
            + (panel.staff_role_ids?.length && panel.ping_staff ? `\n${panel.staff_role_ids.map((r) => `<@&${r}>`).join(" ")}` : ""),
          allowed_mentions: { users: [userId], roles: panel.ping_staff ? panel.staff_role_ids : [] },
          components: [{ type: 1, components: [
            { type: 2, style: 4, label: t("close_label").slice(0, 80), custom_id: "dsm:ticket:close", emoji: { name: "🔒" } },
            // With a staff log channel the Claim button lives there, where only staff can see it.
            ...(panel.claim === false || panel.log_channel ? [] : [{ type: 2, style: 2, label: t("claim_label").slice(0, 80), custom_id: "dsm:ticket:claim", emoji: { name: "🙋" } }]),
          ] }],
        });
        await ticketLog(panel, t, { title: "ticket_log_opened", color: 0x57f287, ticket: data.tickets.at(-1), channelId: ch.id, guild: d.guild_id,
          fields: [{ name: t("ticket_opened_by"), value: `<@${userId}>`, inline: true }] });
        return reply(t("ticket_opened", { channel: `<#${ch.id}>` }));
      }
      if (kind === "ticket" && a === "claim") {
        // From inside the ticket, or from the staff log message (custom id carries the ticket channel).
        const ticketChannel = b || d.channel_id;
        const ticket = data.tickets.find((x) => x.channel_id === ticketChannel);
        const panel = ticket && data.ticket_panels.find((p) => p.id === ticket.panel);
        const t = (k, vars) => text(k, { lang: panel?.language, locale, texts: panel?.texts, vars });
        if (!ticket) return ephemeral(d, t("not_ticket"));
        if (!isStaffMember(d, panel)) return ephemeral(d, t("claim_denied"));
        if (ticket.claimed_by) return ephemeral(d, t("already_claimed", { staff: `<@${ticket.claimed_by}>` }));
        ticket.claimed_by = userId;
        saveAutomations();
        const announce = { content: t("ticket_claimed", { staff: `<@${userId}>` }), allowed_mentions: { parse: [] } };
        if (b) {
          // Clicked in the staff channel: tell the member in the ticket, and answer the staff member privately.
          await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: t("ticket_claimed", { staff: `<@${userId}>` }), flags: 64 } });
          await api("POST", `/channels/${ticketChannel}/messages`, announce).catch(() => {});
        } else {
          await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: announce });
        }
        const info = await api("GET", `/channels/${ticketChannel}`).catch(() => ({}));
        await api("PATCH", `/channels/${ticketChannel}`, { topic: `${info.topic || ""} · ${t("ticket_claimed_by")}: ${d.member.user.global_name || d.member.user.username}`.slice(0, 1024) }).catch(() => {});
        await ticketLog(panel, t, { title: "ticket_log_claimed", color: 0x5865f2, ticket, channelId: ticketChannel, guild: d.guild_id,
          fields: [{ name: t("ticket_claimed_by"), value: `<@${userId}>`, inline: true }] });
        return undefined;
      }
      if (kind === "ticket" && a === "close") {
        const ticket = data.tickets.find((x) => x.channel_id === d.channel_id);
        const panel = ticket && data.ticket_panels.find((p) => p.id === ticket.panel);
        const t = (k, vars) => text(k, { lang: panel?.language, locale, texts: panel?.texts, vars });
        if (!ticket) return ephemeral(d, t("not_ticket"));
        if (userId !== ticket.user_id && !isStaffMember(d, panel)) return ephemeral(d, t("close_denied"));
        await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: t("closing") } });
        // Keep the whole conversation before the channel goes away: on this computer, and in the panel's
        // transcript channel (if it has one) with a summary staff can scroll through.
        let msgs = [];
        try {
          msgs = await allMessages(d.channel_id);
          const md = transcript(msgs, `${ticket.name || d.channel?.name || "ticket"} · ${ticket.opened}`);
          mkdirSync(TICKETS_DIR, { recursive: true });
          writeFileSync(join(TICKETS_DIR, `${ticket.name || d.channel_id}.md`), md);
          if (panel?.log_channel) {
            const people = [...new Set(msgs.filter((m) => !m.author.bot).map((m) => `<@${m.author.id}>`))].join(" ") || "—";
            const opened = Date.parse(ticket.opened);
            await api("POST", `/channels/${panel.log_channel}/messages`, {
              embeds: [{
                title: `${t("ticket_closed_title")} · ${ticket.name || ""}`, color: 0x99aab5,
                fields: [
                  { name: t("ticket_opened_by"), value: `<@${ticket.user_id}>`, inline: true },
                  { name: t("ticket_closed_by"), value: `<@${userId}>`, inline: true },
                  { name: t("ticket_messages"), value: String(msgs.filter((m) => !m.author.bot).length), inline: true },
                  ...(ticket.claimed_by ? [{ name: t("ticket_claimed_by"), value: `<@${ticket.claimed_by}>`, inline: true }] : []),
                  { name: t("ticket_opened_at"), value: `<t:${Math.floor(opened / 1000)}:f>`, inline: true },
                  { name: t("ticket_duration"), value: `${Math.max(1, Math.round((Date.now() - opened) / 60000))} min`, inline: true },
                  { name: t("ticket_participants"), value: people.slice(0, 1024) },
                ],
                timestamp: new Date().toISOString(),
              }],
              allowed_mentions: { parse: [] },
            }, { files: [{ name: `${ticket.name || "ticket"}.md`, data: Buffer.from(md), type: "text/markdown" }] });
          }
        } catch {
          // transcripts are best effort
        }
        data.closed_tickets.push(defined({ name: ticket.name, number: ticket.number, guild: d.guild_id, panel: ticket.panel, user_id: ticket.user_id,
          claimed_by: ticket.claimed_by, closed_by: userId, opened: ticket.opened, closed: new Date().toISOString(),
          messages: msgs.filter((m) => !m.author.bot).length, file: join(TICKETS_DIR, `${ticket.name || d.channel_id}.md`) }));
        if (data.closed_tickets.length > 2000) data.closed_tickets = data.closed_tickets.slice(-2000);
        saveAutomations();
        await new Promise((r) => setTimeout(r, 5000));
        await api("DELETE", `/channels/${d.channel_id}`, undefined, { reason: `${AUTO_REASONS.ticketClose} (${d.member?.user?.username})` });
        data.tickets = data.tickets.filter((x) => x !== ticket);
        saveAutomations();
        // Remove an on-demand category once its last ticket is closed.
        if (panel?.category_name && panel.category_id) {
          const left = (await api("GET", `/guilds/${d.guild_id}/channels`).catch(() => [])).filter((c) => c.parent_id === panel.category_id);
          if (!left.length) {
            await api("DELETE", `/channels/${panel.category_id}`, undefined, { reason: AUTO_REASONS.ticketCategory }).catch(() => {});
            panel.category_id = undefined;
            saveAutomations();
          }
        }
      }
      return undefined;
    });
  });

  const onReaction = (add) => async (d, bot) => {
    const menu = data.role_menus.find((m) => m.style === "reactions" && m.message_id === d.message_id && m.bot === bot.id);
    if (!menu || d.user_id === bot.id) return;
    const emoji = d.emoji?.id ? `${d.emoji.name}:${d.emoji.id}` : d.emoji?.name;
    const option = menu.options.find((o) => o.emoji === emoji || o.emoji === d.emoji?.name);
    if (!option) return;
    await asBot(bot, () => toggleRole(menu, d.guild_id, d.user_id, option.role_id, add)).catch(() => {});
  };
  onEvent("MESSAGE_REACTION_ADD", onReaction(true));
  onEvent("MESSAGE_REACTION_REMOVE", onReaction(false));

  onEvent("GUILD_MEMBER_ADD", async (d, bot) => {
    for (const w of data.welcomes.filter((x) => x.guild === d.guild_id && x.bot === bot.id && x.enabled !== false)) {
      await asBot(bot, async () => {
        const guild = await api("GET", `/guilds/${d.guild_id}?with_counts=true`).catch(() => ({}));
        const vars = { user: d.user, guildName: guild.name || "", memberCount: guild.approximate_member_count };
        for (const r of w.auto_role_ids || []) await api("PUT", `/guilds/${d.guild_id}/members/${d.user.id}/roles/${r}`, undefined, { reason: AUTO_REASONS.autoRole }).catch(() => {});
        if (w.channel && (w.message || w.embed)) {
          await api("POST", `/channels/${w.channel}/messages`, {
            content: w.message ? fillTemplate(w.message, vars) : undefined,
            embeds: w.embed ? [{ title: fillTemplate(w.embed.title, vars) || undefined, description: fillTemplate(w.embed.description, vars) || undefined,
              color: w.embed.color, image: w.embed.image ? { url: w.embed.image } : undefined,
              thumbnail: { url: d.user.avatar ? `https://cdn.discordapp.com/avatars/${d.user.id}/${d.user.avatar}.png` : "https://cdn.discordapp.com/embed/avatars/0.png" } }] : undefined,
            allowed_mentions: { users: [d.user.id] },
          }).catch(() => {});
        }
        if (w.dm) {
          const dm = await api("POST", "/users/@me/channels", { recipient_id: d.user.id }).catch(() => null);
          if (dm) await api("POST", `/channels/${dm.id}/messages`, { content: fillTemplate(w.dm, vars) }).catch(() => {});
        }
      });
    }
    await asBot(bot, () => checkRaid(d.guild_id, bot));
    await asBot(bot, () => logEvent(d.guild_id, bot, "members", { title: { key: "log_joined" }, color: "green", user: d.user, subject: d.user.id,
      fields: [{ key: "log_member", value: who(d.user), inline: true },
        { key: "log_account_created", value: `<t:${Math.floor(Number((BigInt(d.user.id) >> 22n) + 1420070400000n) / 1000)}:R>`, inline: true }] }));
  });

  onEvent("GUILD_MEMBER_REMOVE", (d, bot) => asBot(bot, () => logEvent(d.guild_id, bot, "members",
    { title: { key: "log_left" }, color: "grey", user: d.user, subject: d.user.id, fields: [{ key: "log_member", value: who(d.user) }] })));

  onEvent("CHANNEL_DELETE", async (d) => {
    const before = data.tickets.length;
    data.tickets = data.tickets.filter((x) => x.channel_id !== d.id);
    if (data.tickets.length !== before) saveAutomations();
  });

  // Messages: remember them for logged servers, then report deletions and edits.
  // Each bot keeps its own copy: several bots in one server get the same events.
  onEvent("MESSAGE_CREATE", (d, bot) => {
    if (!d.guild_id || !logsFor(d.guild_id, bot, "messages").length) return;
    seen.set(`${bot.id}:${d.id}`, { author: d.author, content: d.content, attachments: (d.attachments || []).map((a) => a.filename) });
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  });
  onEvent("MESSAGE_DELETE", (d, bot) => {
    if (!d.guild_id || !logsFor(d.guild_id, bot, "messages").length) return undefined;
    const old = seen.get(`${bot.id}:${d.id}`);
    seen.delete(`${bot.id}:${d.id}`);
    if (old?.author?.bot) return undefined;
    return asBot(bot, () => logEvent(d.guild_id, bot, "messages", { channelId: d.channel_id, color: "red", user: old?.author, subject: old?.author?.id,
      title: { key: "log_message_deleted" },
      description: `<#${d.channel_id}>`,
      fields: [{ key: "log_author", value: old ? who(old.author) : undefined, inline: true },
        { key: "log_content", value: old ? [old.content, ...old.attachments.map((f) => `📎 ${f}`)].filter(Boolean).join("\n") || "—" : { key: "log_unknown_content" } }] }));
  });
  onEvent("MESSAGE_DELETE_BULK", (d, bot) => (d.guild_id ? asBot(bot, () => logEvent(d.guild_id, bot, "messages", { channelId: d.channel_id, color: "red",
    title: { key: "log_bulk_deleted", vars: { count: d.ids?.length || 0 } }, description: `<#${d.channel_id}>` })) : undefined));
  onEvent("MESSAGE_UPDATE", (d, bot) => {
    if (!d.guild_id || d.content === undefined || d.author?.bot || !logsFor(d.guild_id, bot, "messages").length) return undefined;
    const old = seen.get(`${bot.id}:${d.id}`);
    // Discord also sends updates when only an embed preview appears; those are not edits.
    if (old && old.content === d.content) return undefined;
    const before = old ? old.content || "—" : { key: "log_unknown_content" };
    if (old) old.content = d.content;
    return asBot(bot, () => logEvent(d.guild_id, bot, "messages", { channelId: d.channel_id, color: "blue", user: d.author, subject: d.author?.id,
      title: { key: "log_message_edited" }, description: `<#${d.channel_id}> · [↗](https://discord.com/channels/${d.guild_id}/${d.channel_id}/${d.id})`,
      fields: [{ key: "log_author", value: who(d.author) }, { key: "log_before", value: before }, { key: "log_after", value: d.content || "—" }] }));
  });

  // Moderation and server changes come from the audit log, so they show who did it and why.
  onEvent("GUILD_AUDIT_LOG_ENTRY_CREATE", (d, bot) => {
    if (isAutomation(d)) return undefined;
    const entry = withPeople(d, auditEntry(d));
    if (!entry) return undefined;
    return asBot(bot, () => logEvent(d.guild_id, bot, entry.kind, entry));
  });
  onEvent("AUTO_MODERATION_ACTION_EXECUTION", (d, bot) => {
    if (d.action?.type !== 1) return undefined;
    return asBot(bot, () => logEvent(d.guild_id, bot, "moderation", { channelId: d.channel_id, color: "orange", subject: d.user_id,
      title: { key: "log_automod" }, description: d.channel_id ? `<#${d.channel_id}>` : undefined,
      fields: [{ key: "log_member", value: `<@${d.user_id}>`, inline: true }, { key: "log_content", value: d.content || d.matched_content }] }));
  });
}
