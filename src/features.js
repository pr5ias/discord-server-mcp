// More automations: support forums (tags, Solved/Claim buttons, staff updates, closing idle posts),
// rules ("when this happens, do that"), member verification, and scheduled messages.
// They share the store and helpers of automations.js and run while a bot is connected.
import { api } from "./discord.js";
import { onEvent } from "./gateway.js";
import { config } from "./config.js";
import { text } from "./i18n.js";
import { automations, saveAutomations, asBot, ephemeral, isStaffMember, guildLocale } from "./automations.js";

const data = () => automations();
const botById = (id) => config.bots.find((b) => b.id === id);
const permsOf = (d) => BigInt(d.member?.permissions || 0);

// ------------------------------------------------------------------ support forums

const forumOf = (parentId, bot) => data().support_forums.find((f) => f.forum === parentId && f.bot === bot.id && f.enabled !== false);
const tf = (f, locale) => (k, vars) => text(k, { lang: f.language, locale, texts: f.texts, vars });

async function setTags(threadId, f, add, remove = []) {
  const info = await api("GET", `/channels/${threadId}`).catch(() => null);
  if (!info) return null;
  const drop = remove.map((k) => f.tags?.[k]).filter(Boolean);
  const want = f.tags?.[add];
  const tags = [...new Set([...(info.applied_tags || []).filter((t) => !drop.includes(t)), ...(want ? [want] : [])])].slice(-5);
  return api("PATCH", `/channels/${threadId}`, { applied_tags: tags }).catch(() => null);
}

async function forumLog(f, t, title, threadId, guild, fields, color) {
  if (!f.log_channel) return;
  await api("POST", `/channels/${f.log_channel}/messages`, {
    embeds: [{ title: `${t(title)}`, description: `<#${threadId}>`, color, fields, timestamp: new Date().toISOString() }],
    components: title === "sf_log_opened" && f.claim !== false ? [{ type: 1, components: [
      { type: 2, style: 1, label: t("sf_claim_label").slice(0, 80), custom_id: `dsm:sf:claim:${threadId}`, emoji: { name: "🙋" } },
    ] }] : undefined,
    allowed_mentions: { parse: [] },
  }).catch(() => {});
}

const postButtons = (f, t, solved) => [{ type: 1, components: [
  solved
    ? { type: 2, style: 2, label: t("sf_reopen_label").slice(0, 80), custom_id: "dsm:sf:reopen", emoji: { name: "🔄" } }
    : { type: 2, style: 3, label: t("sf_solve_label").slice(0, 80), custom_id: "dsm:sf:solve", emoji: { name: "✅" } },
  // Without a staff channel, staff claim from the post itself (members get a polite no).
  ...(!solved && f.claim !== false && !f.log_channel ? [{ type: 2, style: 2, label: t("sf_claim_label").slice(0, 80), custom_id: "dsm:sf:claim", emoji: { name: "🙋" } }] : []),
] }];

/** Handles Solved / Reopen / Claim in support forum posts. Returns true when it answered. */
export async function handleForumButton(d, bot, action, threadArg) {
  const threadId = threadArg || d.channel_id;
  const thread = threadArg ? await api("GET", `/channels/${threadId}`).catch(() => null) : d.channel;
  const f = thread && forumOf(thread.parent_id, bot);
  const locale = d.guild_locale || d.locale;
  if (!f) {
    await ephemeral(d, text("sf_not_post", { locale }));
    return true;
  }
  const t = tf(f, locale);
  const userId = d.member.user.id;
  const staff = isStaffMember(d, { staff_role_ids: f.staff_role_ids });
  if (action === "claim") {
    if (!staff) {
    await ephemeral(d, t("claim_denied"));
    return true;
  }
    await setTags(threadId, f, "in_progress", ["open"]);
    const msg = { content: t("sf_claimed", { staff: `<@${userId}>` }), allowed_mentions: { parse: [] } };
    if (threadArg) {
      await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { ...msg, flags: 64 } });
      await api("POST", `/channels/${threadId}/messages`, msg).catch(() => {});
    } else {
      await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: msg });
    }
    await forumLog(f, t, "sf_log_claimed", threadId, d.guild_id, [{ name: t("ticket_claimed_by"), value: `<@${userId}>`, inline: true }], 0x5865f2);
    return true;
  }
  // Solve and reopen: the post's author or staff.
  if (userId !== thread.owner_id && !staff) {
    await ephemeral(d, t("sf_denied"));
    return true;
  }
  if (action === "solve") {
    await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: {
      content: t("sf_solved", { user: `<@${userId}>` }), allowed_mentions: { parse: [] }, components: postButtons(f, t, true) } });
    await setTags(threadId, f, "solved", ["open", "in_progress"]);
    await forumLog(f, t, "sf_log_solved", threadId, d.guild_id, [{ name: t("log_by"), value: `<@${userId}>`, inline: true }], 0x57f287);
    // Closing (and locking, if chosen) last, since a locked post takes no more changes.
    await api("PATCH", `/channels/${threadId}`, { archived: true, locked: f.lock_on_solve !== false }).catch(() => {});
    return true;
  }
  if (action === "reopen") {
    await api("PATCH", `/channels/${threadId}`, { archived: false, locked: false }).catch(() => {});
    await setTags(threadId, f, "open", ["solved"]);
    await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: {
      content: t("sf_reopened", { user: `<@${userId}>` }), allowed_mentions: { parse: [] }, components: postButtons(f, t, false) } });
    return true;
  }
  return false;
}

/** Whether a channel is a post of a support forum (for /ticket close|claim inside one). */
export const isSupportPost = (thread, bot) => Boolean(thread?.parent_id && forumOf(thread.parent_id, bot));

async function closeIdlePosts() {
  for (const f of data().support_forums.filter((x) => x.enabled !== false && x.close_after_days)) {
    const bot = botById(f.bot);
    if (!bot?.token) continue;
    await asBot(bot, async () => {
      const { threads = [] } = await api("GET", `/guilds/${f.guild}/threads/active`).catch(() => ({}));
      const limit = Date.now() - f.close_after_days * 86400000;
      const t = tf(f, await guildLocale(f.guild));
      for (const th of threads.filter((x) => x.parent_id === f.forum)) {
        const last = Number((BigInt(th.last_message_id || th.id) >> 22n) + 1420070400000n);
        if (last > limit) continue;
        await api("POST", `/channels/${th.id}/messages`, { content: t("sf_closed_inactive", { days: f.close_after_days }) }).catch(() => {});
        await api("PATCH", `/channels/${th.id}`, { archived: true }).catch(() => {});
      }
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ rules

const cooldowns = new Map();
function fill(value, { user, guild, channel, content }) {
  return String(value || "")
    .replaceAll("{user}", user ? `<@${user.id}>` : "").replaceAll("{username}", user?.global_name || user?.username || "")
    .replaceAll("{server}", guild || "").replaceAll("{channel}", channel ? `<#${channel}>` : "").replaceAll("{content}", content || "");
}

function matches(rule, d) {
  const w = rule.when;
  if (w.channels?.length && !w.channels.includes(d.channel_id) && !w.channels.includes(d.parent_id)) return false;
  const roles = d.member?.roles || [];
  if (w.only_roles?.length && !roles.some((r) => w.only_roles.includes(r))) return false;
  if (w.except_roles?.length && roles.some((r) => w.except_roles.includes(r))) return false;
  if (w.event === "message") {
    const content = String(d.content || "");
    const lower = content.toLowerCase();
    if (w.words?.length) {
      const hit = w.words.some((word) => (w.whole_words
        ? new RegExp(`(^|[^\\p{L}\\p{N}])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(lower)
        : lower.includes(word.toLowerCase())));
      if (!hit) return false;
    }
    if (w.regex) {
      try {
        if (!new RegExp(w.regex, "iu").test(content)) return false;
      } catch {
        return false;
      }
    }
    if (w.has_link && !/https?:\/\//i.test(content)) return false;
    if (w.has_attachment && !d.attachments?.length) return false;
  }
  if (w.event === "reaction" && w.emoji && w.emoji !== (d.emoji?.id ? `${d.emoji.name}:${d.emoji.id}` : d.emoji?.name)) return false;
  if (w.event === "reaction" && w.message_id && w.message_id !== d.message_id) return false;
  return true;
}

async function runActions(rule, d, bot) {
  const user = d.author || d.user || d.member?.user;
  const userId = user?.id || d.user_id;
  const g = d.guild_id;
  const guildName = (await api("GET", `/guilds/${g}`).catch(() => ({}))).name;
  const vars = { user: user || { id: userId }, guild: guildName, channel: d.channel_id, content: d.content };
  const reason = `Rule: ${rule.name}`;
  for (const a of rule.then) {
    try {
      switch (a.action) {
        case "reply":
          await api("POST", `/channels/${d.channel_id}/messages`, { content: fill(a.text, vars), message_reference: d.id && d.content !== undefined ? { message_id: d.id, fail_if_not_exists: false } : undefined,
            allowed_mentions: { users: userId ? [userId] : [], replied_user: false } });
          break;
        case "send":
          await api("POST", `/channels/${a.channel}/messages`, { content: fill(a.text, vars), allowed_mentions: { users: userId ? [userId] : [], roles: a.ping_role ? [a.ping_role] : [] } });
          break;
        case "dm": {
          const dm = await api("POST", "/users/@me/channels", { recipient_id: userId });
          await api("POST", `/channels/${dm.id}/messages`, { content: fill(a.text, vars) });
          break;
        }
        case "add_role":
          await api("PUT", `/guilds/${g}/members/${userId}/roles/${a.role}`, undefined, { reason });
          break;
        case "remove_role":
          await api("DELETE", `/guilds/${g}/members/${userId}/roles/${a.role}`, undefined, { reason });
          break;
        case "delete":
          if (d.id && d.content !== undefined) await api("DELETE", `/channels/${d.channel_id}/messages/${d.id}`, undefined, { reason });
          break;
        case "react":
          if (d.id && d.content !== undefined) await api("PUT", `/channels/${d.channel_id}/messages/${d.id}/reactions/${encodeURIComponent(a.emoji)}/@me`);
          break;
        case "timeout":
          await api("PATCH", `/guilds/${g}/members/${userId}`, { communication_disabled_until: new Date(Date.now() + (a.minutes || 5) * 60000).toISOString() }, { reason });
          break;
        default:
      }
    } catch {
      // one failed action should not stop the others
    }
  }
}

async function onRuleEvent(event, d, bot) {
  if (!d.guild_id) return;
  const who = d.author || d.user || d.member?.user;
  if (who?.bot || (d.user_id && d.user_id === bot.id)) return;
  for (const rule of data().rules.filter((r) => r.guild === d.guild_id && r.bot === bot.id && r.enabled !== false && r.when.event === event)) {
    if (!matches(rule, d)) continue;
    const key = `${rule.id}:${who?.id || d.user_id}`;
    if (rule.cooldown_seconds && Date.now() - (cooldowns.get(key) || 0) < rule.cooldown_seconds * 1000) continue;
    cooldowns.set(key, Date.now());
    await asBot(bot, () => runActions(rule, d, bot)).catch(() => {});
  }
}

// ------------------------------------------------------------------ verification

export async function handleVerify(d, bot, id) {
  const v = data().verifications.find((x) => x.id === id);
  const locale = d.guild_locale || d.locale;
  const t = (k) => text(k, { lang: v?.language, locale, texts: v?.texts });
  if (!v) return ephemeral(d, t("menu_gone"));
  if (d.member.roles.includes(v.role)) return ephemeral(d, t("verify_already"));
  await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: 64 } });
  const reply = (content) => api("PATCH", `/webhooks/${d.application_id}/${d.token}/messages/@original`, { content });
  try {
    await api("PUT", `/guilds/${d.guild_id}/members/${d.member.user.id}/roles/${v.role}`, undefined, { reason: "Verification" });
    if (v.remove_role) await api("DELETE", `/guilds/${d.guild_id}/members/${d.member.user.id}/roles/${v.remove_role}`, undefined, { reason: "Verification" }).catch(() => {});
    return reply(t("verify_done"));
  } catch {
    return reply(t("role_error"));
  }
}

// ------------------------------------------------------------------ scheduled messages

/** Offset of a time zone at a moment, in minutes (e.g. Europe/Lisbon in summer: 60). */
function offsetMinutes(tz, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** UTC time of a wall-clock time in a zone. */
export function zoned(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - offsetMinutes(tz, new Date(guess)) * 60000;
  return first - (offsetMinutes(tz, new Date(first)) - offsetMinutes(tz, new Date(guess))) * 60000;
}

/** Wall-clock parts of a moment in a zone. */
function wall(at, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

/** Next time after `after` for a schedule that started at `first` and repeats (keeping the local time across DST). */
export function nextRun(s, after = Date.now()) {
  if (s.first > after) return s.first;
  if (!s.every) return null;
  const tz = s.timezone || "UTC";
  const n = s.interval || 1;
  if (s.every === "hour") {
    const step = n * 3600000;
    const t = s.first + Math.ceil((after - s.first + 1) / step) * step;
    return s.until && t > s.until ? null : t;
  }
  const w = wall(s.first, tz);
  for (let k = 0; k < 5000; k++) {
    let t;
    if (s.every === "day") t = zoned(w.y, w.mo, w.d + k * n, w.h, w.mi, tz);
    else if (s.every === "week") t = zoned(w.y, w.mo, w.d + 7 * k * n, w.h, w.mi, tz);
    else t = zoned(w.y, w.mo + k * n, w.d, w.h, w.mi, tz);
    if (t > after) return s.until && t > s.until ? null : t;
  }
  return null;
}

async function runSchedules() {
  const now = Date.now();
  let changed = false;
  for (const s of data().schedules.filter((x) => x.enabled !== false && x.next && x.next <= now)) {
    const bot = botById(s.bot);
    if (!bot?.token) continue;
    // Missed while the app was closed: send if it is still fresh (within 6 hours), else skip to the next one.
    if (now - s.next < 6 * 3600000) {
      await asBot(bot, () => api("POST", `/channels/${s.channel}/messages`, {
        content: [s.ping_role ? `<@&${s.ping_role}>` : "", s.content || ""].filter(Boolean).join("\n") || undefined,
        embeds: s.embed ? [s.embed] : undefined, allowed_mentions: { roles: s.ping_role ? [s.ping_role] : [], parse: s.ping_everyone ? ["everyone"] : [] },
      })).catch(() => {});
      s.sent = (s.sent || 0) + 1;
      s.last_sent = new Date(now).toISOString();
    }
    s.next = nextRun(s, now);
    if (!s.next) s.enabled = false;
    changed = true;
  }
  if (changed) saveAutomations();
}

/** Wakes up at the next scheduled message (checking at least every 30 seconds). */
let timer;
export function armSchedules() {
  clearTimeout(timer);
  const soonest = Math.min(...data().schedules.filter((x) => x.enabled !== false && x.next).map((x) => x.next), Date.now() + 30000);
  timer = setTimeout(async () => {
    await runSchedules().catch(() => {});
    armSchedules();
  }, Math.max(500, soonest - Date.now()));
  timer.unref?.();
}

// ------------------------------------------------------------------ wiring

let wired = false;
export function startFeatures() {
  if (wired) return;
  wired = true;

  onEvent("THREAD_CREATE", async (d, bot) => {
    const f = d.newly_created && forumOf(d.parent_id, bot);
    if (!f) return;
    await asBot(bot, async () => {
      const t = tf(f, await guildLocale(d.guild_id));
      await setTags(d.id, f, "open", []);
      // The starter message is created a moment after the thread.
      await new Promise((r) => setTimeout(r, 1500));
      await api("POST", `/channels/${d.id}/messages`, {
        content: f.welcome === "" ? undefined : t("sf_welcome", { user: `<@${d.owner_id}>` }),
        components: postButtons(f, t, false), allowed_mentions: { users: [d.owner_id] },
      }).catch(() => {});
      if (f.ping_staff && f.log_channel) {
        await api("POST", `/channels/${f.log_channel}/messages`, { content: f.staff_role_ids.map((r) => `<@&${r}>`).join(" "), allowed_mentions: { roles: f.staff_role_ids } }).catch(() => {});
      }
      await forumLog(f, t, "sf_log_opened", d.id, d.guild_id, [{ name: t("ticket_opened_by"), value: `<@${d.owner_id}>`, inline: true }], 0x57f287);
    }).catch(() => {});
  });

  onEvent("MESSAGE_CREATE", (d, bot) => onRuleEvent("message", d, bot));
  onEvent("GUILD_MEMBER_ADD", (d, bot) => onRuleEvent("member_join", d, bot));
  onEvent("MESSAGE_REACTION_ADD", (d, bot) => onRuleEvent("reaction", d, bot));

  armSchedules();
  setInterval(() => closeIdlePosts().catch(() => {}), 3600000).unref?.();
}

// Exposed for tests.
export const _internal = { runSchedules, closeIdlePosts, matches };
