// Discord REST client and the lookups every tool shares.
import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, extname } from "node:path";
import { z } from "zod";
import { config } from "./config.js";

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {}

// ------------------------------------------------------------------ dry run

/** Per-call context. In a dry run, writes are recorded instead of sent. */
export const callContext = new AsyncLocalStorage();
let fakeId = 0;

function plannedWrite(method, path, body, files, reason) {
  const ctx = callContext.getStore();
  ctx.planned.push(defined({ method, path, body, files: files?.length ? files.map((f) => f.name) : undefined, reason }));
  if (method === "DELETE" || method === "PUT") return null;
  const id = path.match(/\/(\d{15,})(?:\/?$|\?)/)?.[1] || `dry-run-${++fakeId}`;
  return { id: method === "POST" ? `dry-run-${++fakeId}` : id, ...(body && typeof body === "object" ? body : {}),
    name: body?.name ?? "(dry run)", available_tags: body?.available_tags ?? [], permissions: body?.permissions ?? "0" };
}

/** Throws if the server is not in DISCORD_ALLOWED_GUILDS. */
export function assertAllowed(guild) {
  if (guild && config.allowedGuilds && !config.allowedGuilds.includes(guild)) {
    throw new DiscordError(`This MCP server is limited to these servers: ${config.allowedGuilds.join(", ")} (DISCORD_ALLOWED_GUILDS).`);
  }
}

// ------------------------------------------------------------------ REST

/**
 * Calls the Discord API. `body` is JSON unless `files` are given, then it is sent as multipart
 * with the JSON in `payload_json`. Retries on rate limits.
 */
export async function api(method, path, body, { files, reason, form, token: forced } = {}) {
  const token = forced || currentToken();
  if (!token) {
    throw new DiscordError(
      "No bot yet. Run setup_check (or the add_bot tool) to add one; never paste a token in the chat.",
    );
  }
  const guildInPath = path.match(/^\/guilds\/(\d{15,})/)?.[1];
  if (guildInPath) assertAllowed(guildInPath);
  if (method !== "GET" && callContext.getStore()?.dryRun) return plannedWrite(method, path, body, files, reason);
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = {
      Authorization: `Bot ${token}`,
      "User-Agent": "DiscordBot (https://github.com/pr5ias/discord-server-mcp, 2.0)",
    };
    if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
    let payload;
    if (form) {
      payload = form;
    } else if (files?.length) {
      const form = new FormData();
      if (body !== undefined) form.append("payload_json", JSON.stringify(body));
      files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
      payload = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(API + path, { method, headers, body: payload });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((data.retry_after ?? 1) * 1000) + 100));
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new DiscordError(explain(res.status, method, path, data));
    return data;
  }
  throw new DiscordError("Discord kept rate-limiting the request. Try again in a moment.");
}

function explain(status, method, path, data) {
  const base = `Discord ${status} on ${method} ${path}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
  if (data?.code === 50013) {
    return `${base}\nThe bot lacks a permission here, or the target role/member is above the bot's highest role (move the bot's role higher in Server Settings > Roles).`;
  }
  if (data?.code === 50001) return `${base}\nThe bot cannot see this channel (check its View Channel permission).`;
  if (status === 401) return `${base}\nThe bot token is invalid. Reset it in the Developer Portal and update it.`;
  if (data?.code === 50035) return `${base}\nDiscord rejected one of the values (see the errors above).`;
  if (data?.code === 60003) {
    return `${base}\nThis server requires two-factor authentication (2FA) for moderation actions. For a bot, that means the Discord account that owns the bot's application (or, for a Team, its owner) must have 2FA turned on: User Settings > My Account > Enable Two-Factor Auth. Or the server owner can turn off "Require 2FA for moderation" in Server Settings > Safety Setup.`;
  }
  return base;
}

// ------------------------------------------------------------------ files and images

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
  ".wav": "audio/wav", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".pdf": "application/pdf",
  ".zip": "application/zip", ".jar": "application/java-archive", ".log": "text/plain", ".apng": "image/apng",
};

/** Loads a local file or a URL. Returns { name, type, data }. */
export async function loadFile(source, name) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new DiscordError(`Could not download ${source} (${res.status}).`);
    const data = Buffer.from(await res.arrayBuffer());
    const urlName = basename(new URL(source).pathname) || "file";
    const finalName = name || urlName;
    return { name: finalName, type: res.headers.get("content-type") || MIME[extname(finalName).toLowerCase()] || "application/octet-stream", data };
  }
  let data;
  try {
    data = await readFile(source);
  } catch (e) {
    throw new DiscordError(`Could not read the file ${source}: ${e.message}`);
  }
  const finalName = name || basename(source);
  return { name: finalName, type: MIME[extname(finalName).toLowerCase()] || "application/octet-stream", data };
}

/** Image from a path or URL as the data URI Discord wants for icons, avatars, emojis and banners. */
export async function imageData(source) {
  if (source === null || source === "none") return null;
  const f = await loadFile(source);
  return `data:${f.type};base64,${f.data.toString("base64")}`;
}

// ------------------------------------------------------------------ lookups

export const CHANNEL_TYPES = {
  text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16,
};
/**
 * Role order as Discord applies it: higher position first, and for equal positions (common right after
 * roles are created) the older role, with the smaller id, ranks higher.
 */
export const roleAbove = (a, b) => a.position !== b.position ? a.position > b.position : BigInt(a.id) < BigInt(b.id);
export const byRank = (a, b) => (roleAbove(a, b) ? -1 : roleAbove(b, a) ? 1 : 0);
/** The highest of these role ids, or null. */
export const topRole = (roles, ids) => roles.filter((r) => ids.includes(r.id)).sort(byRank)[0] || null;

/** Announcement channels exist only in servers with Community (or the older NEWS feature). */
export const hasNews = (guild) => !Array.isArray(guild?.features) || guild.features.includes("NEWS") || guild.features.includes("COMMUNITY");

export const TYPE_NAMES = {
  0: "text", 2: "voice", 4: "category", 5: "announcement", 10: "announcement_thread", 11: "public_thread",
  12: "private_thread", 13: "stage", 15: "forum", 16: "media",
};

/** Token for this call: the bot chosen for the call's server, else the active bot. */
export function currentToken() {
  return callContext.getStore()?.token || config.token;
}

const guildCache = new Map();
const meCache = new Map();

/** Servers of one bot (cached for a few seconds). */
async function guildsOf(token, fresh = false) {
  const hit = guildCache.get(token);
  if (hit && !fresh && Date.now() - hit.at < 10000) return hit.list;
  const list = await api("GET", "/users/@me/guilds?with_counts=true", undefined, { token });
  guildCache.set(token, { at: Date.now(), list });
  return list;
}

/** The current bot's user. */
export async function me(token = currentToken()) {
  if (!meCache.has(token)) meCache.set(token, await api("GET", "/users/@me", undefined, { token }));
  return meCache.get(token);
}

/** Every bot with its servers (bots whose token fails are listed with the error). */
export async function botsWithServers() {
  const out = [];
  for (const bot of config.bots) {
    try {
      const user = await me(bot.token);
      if (!bot.id || bot.name !== user.username) Object.assign(bot, { id: user.id, name: bot.name === "token.txt" || bot.name === "DISCORD_BOT_TOKEN" || !bot.name ? user.username : bot.name });
      let servers = await guildsOf(bot.token, true);
      if (config.allowedGuilds) servers = servers.filter((g) => config.allowedGuilds.includes(g.id));
      out.push({ bot, user, servers });
    } catch (e) {
      out.push({ bot, error: String(e.message || e) });
    }
  }
  return out;
}

/**
 * Server id from a name, an id, DISCORD_GUILD_ID, or the only server. With several bots, the server is
 * looked up across all of them and the rest of the call uses the bot that is in it.
 */
export async function guildId(given) {
  const { id, token, name, others } = await resolveGuild(given);
  assertAllowed(id);
  const store = callContext.getStore();
  if (store) {
    if (token) store.token = token;
    store.serverName = name || id;
    store.otherBots = others;
  }
  return id;
}

/** Name of the bot with this token. */
export const botNameOf = (token) => config.bots.find((b) => b.token === token)?.name;

async function resolveGuild(given) {
  if (!config.bots.length) throw new DiscordError("No bot yet. Run setup_check to add one.");
  const preferActive = (a, b) => (a.bot.token === config.token ? -1 : b.bot.token === config.token ? 1 : 0);
  const store = callContext.getStore();
  const forcedToken = store?.token;
  const candidates = async () => {
    const all = (await botsWithServers()).filter((x) => x.servers).sort(preferActive);
    return forcedToken ? all.filter((x) => x.bot.token === forcedToken) : all;
  };
  const wanted = given ?? config.defaultGuild;
  if (wanted) {
    const hits = [];
    for (const x of await candidates()) {
      const g = x.servers.find((s) => s.id === wanted || s.name.toLowerCase() === String(wanted).toLowerCase());
      if (g) hits.push({ g, bot: x.bot });
    }
    if (hits.length) {
      // Several bots in this server: the one chosen for it, else the default bot, else the first.
      const bound = findBotLocal(config.serverBots?.[hits[0].g.id]);
      const pick = hits.find((h) => bound && h.bot === bound) || hits[0];
      return { id: pick.g.id, name: pick.g.name, token: pick.bot.token,
        others: hits.filter((h) => h !== pick).map((h) => h.bot.name) };
    }
    if (/^\d{15,}$/.test(wanted)) return { id: wanted, token: forcedToken };
    const names = (await candidates()).flatMap((x) => x.servers.map((s) => s.name));
    throw new DiscordError(`No bot is in a server called "${wanted}".${suggest(wanted, names)} Use list_servers.`);
  }
  const all = (await candidates()).flatMap((x) => x.servers.map((s) => ({ ...s, token: x.bot.token, botName: x.bot.name })));
  const unique = [...new Map(all.map((g) => [g.id, g])).values()];
  if (unique.length === 1) return resolveGuild(unique[0].id);
  if (!all.length) throw new DiscordError("The bot is not in any server yet. Invite it with the link from setup_check.");
  throw new DiscordError(`Say which server: ${all.map((g) => `${g.name}${config.bots.length > 1 ? ` (bot ${g.botName})` : ""}`).join(", ")}.`);
}

const simplify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function findBotLocal(ref) {
  if (!ref) return undefined;
  const r = String(ref).toLowerCase();
  return config.bots.find((b) => b.id === ref || b.name?.toLowerCase() === r);
}

/** Channel (or thread) by id or name. Names match loosely, so "announcements" finds "📢-announcements". */
export async function channel(guild, ref, wantTypes) {
  const byId = /^\d{15,}$/.test(ref) ? ref : ref.match(/channels\/\d+\/(\d+)/)?.[1];
  if (byId) {
    const c = await api("GET", `/channels/${byId}`);
    if (c.guild_id) assertAllowed(c.guild_id);
    if (guild && c.guild_id && c.guild_id !== guild) throw new DiscordError(`Channel ${ref} belongs to another server.`);
    return c;
  }
  const name = ref.replace(/^#/, "");
  let list = await api("GET", `/guilds/${guild}/channels`);
  const threads = await api("GET", `/guilds/${guild}/threads/active`).then((r) => r.threads).catch(() => []);
  list = list.concat(threads);
  if (wantTypes) list = list.filter((c) => wantTypes.includes(c.type));
  const exact = list.filter((c) => c.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return exact[0];
  const loose = list.filter((c) => simplify(c.name) === simplify(name) || simplify(c.name).endsWith(simplify(name)));
  const found = exact.length ? exact : loose;
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new DiscordError(`"${ref}" matches several channels: ${found.map((c) => `${c.name} (${c.id})`).join(", ")}. Use the id.`);
  }
  throw new DiscordError(`No channel "${ref}".${suggest(name, list.map((c) => c.name))} Use get_server to see the channels.`);
}

export async function category(guild, ref) {
  return channel(guild, ref, [4]);
}

/** Role by id, name or "@everyone". */
export async function role(guild, ref) {
  const name = ref.replace(/^@/, "");
  if (name.toLowerCase() === "everyone" || ref === guild) return { id: guild, name: "@everyone" };
  const roles = await api("GET", `/guilds/${guild}/roles`);
  const r = roles.find((x) => x.id === ref.replace(/[<@&>]/g, "") || x.name.toLowerCase() === name.toLowerCase());
  if (!r) throw new DiscordError(`No role "${ref}".${suggest(name, roles.map((x) => x.name))}`);
  return r;
}

/** Member by id, mention, username, display name or "bot" (the bot itself). Returns the member object. */
export async function member(guild, ref) {
  let id = ref.replace(/[<@!>]/g, "");
  if (ref === "bot" || ref === "me") id = (await me()).id;
  if (!/^\d{15,}$/.test(id)) {
    const found = await api("GET", `/guilds/${guild}/members/search?query=${encodeURIComponent(ref)}&limit=10`);
    const lower = ref.toLowerCase();
    const exact = found.filter((m) => [m.user.username, m.user.global_name, m.nick].some((n) => n && n.toLowerCase() === lower));
    const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
    if (!pick) {
      throw new DiscordError(found.length
        ? `"${ref}" matches several members: ${found.map((m) => `${m.user.username} (${m.user.id})`).join(", ")}. Use the id.`
        : `No member "${ref}". Try their exact username or user id.`);
    }
    return pick;
  }
  return api("GET", `/guilds/${guild}/members/${id}`);
}

/** Emoji for reactions: a unicode emoji, <:name:id>, name:id, or the name of a server emoji. */
export async function reactionEmoji(guild, ref) {
  const custom = ref.match(/<?a?:?(\w+):(\d+)>?/);
  if (custom) return encodeURIComponent(`${custom[1]}:${custom[2]}`);
  if (/^\w+$/.test(ref.replace(/:/g, ""))) {
    const emojis = await api("GET", `/guilds/${guild}/emojis`);
    const e = emojis.find((x) => x.name.toLowerCase() === ref.replace(/:/g, "").toLowerCase());
    if (e) return encodeURIComponent(`${e.name}:${e.id}`);
  }
  return encodeURIComponent(ref);
}

/** " Did you mean …?" with the closest names, ignoring emojis and punctuation. */
export function suggest(wanted, names) {
  const w = simplify(wanted);
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  const scored = [...new Set(names)].map((n) => {
    const s = simplify(n);
    return { n, d: s.includes(w) || w.includes(s) ? 0 : dist(w, s) };
  }).filter((x) => x.d <= Math.max(2, Math.floor(w.length / 3))).sort((a, b) => a.d - b.d).slice(0, 3);
  return scored.length ? ` Did you mean ${scored.map((x) => `"${x.n}"`).join(", ")}?` : "";
}

// ------------------------------------------------------------------ permissions

export const PERMISSIONS = {
  CreateInstantInvite: 0, KickMembers: 1, BanMembers: 2, Administrator: 3, ManageChannels: 4, ManageGuild: 5,
  AddReactions: 6, ViewAuditLog: 7, PrioritySpeaker: 8, Stream: 9, ViewChannel: 10, SendMessages: 11,
  SendTTSMessages: 12, ManageMessages: 13, EmbedLinks: 14, AttachFiles: 15, ReadMessageHistory: 16,
  MentionEveryone: 17, UseExternalEmojis: 18, ViewGuildInsights: 19, Connect: 20, Speak: 21, MuteMembers: 22,
  DeafenMembers: 23, MoveMembers: 24, UseVAD: 25, ChangeNickname: 26, ManageNicknames: 27, ManageRoles: 28,
  ManageWebhooks: 29, ManageGuildExpressions: 30, UseApplicationCommands: 31, RequestToSpeak: 32, ManageEvents: 33,
  ManageThreads: 34, CreatePublicThreads: 35, CreatePrivateThreads: 36, UseExternalStickers: 37,
  SendMessagesInThreads: 38, UseEmbeddedActivities: 39, ModerateMembers: 40, ViewCreatorMonetizationAnalytics: 41,
  UseSoundboard: 42, CreateGuildExpressions: 43, CreateEvents: 44, UseExternalSounds: 45, SendVoiceMessages: 46,
  SendPolls: 49, UseExternalApps: 50, PinMessages: 51,
};

export const PERMISSION_LIST = Object.keys(PERMISSIONS).join(", ");

/** Permission names (any case, spaces/underscores ignored) or raw numbers to a bitfield string. */
export function bits(names = []) {
  let v = 0n;
  for (const n of names) {
    if (/^\d+$/.test(String(n))) {
      v |= BigInt(n);
      continue;
    }
    const wanted = String(n).replace(/[\s_]/g, "").toLowerCase();
    const key = Object.keys(PERMISSIONS).find((k) => k.toLowerCase() === wanted);
    if (key === undefined) throw new DiscordError(`Unknown permission "${n}". Known: ${PERMISSION_LIST}`);
    v |= 1n << BigInt(PERMISSIONS[key]);
  }
  return v.toString();
}

export function permNames(value) {
  const v = BigInt(value || 0);
  return Object.entries(PERMISSIONS).filter(([, b]) => v & (1n << BigInt(b))).map(([k]) => k);
}

// ------------------------------------------------------------------ shared schemas and converters

export function color(c) {
  if (c === undefined || c === null || c === "") return undefined;
  if (typeof c === "number") return c;
  const named = { red: 0xed4245, green: 0x57f287, blue: 0x5865f2, yellow: 0xfee75c, white: 0xffffff, black: 0x000000,
    orange: 0xffa500, purple: 0x9b59b6, pink: 0xeb459e, grey: 0x95a5a6, gray: 0x95a5a6, blurple: 0x5865f2 };
  if (named[String(c).toLowerCase()] !== undefined) return named[String(c).toLowerCase()];
  return parseInt(String(c).replace("#", ""), 16);
}

export const server = z.string().optional().describe("Server name or id. Optional when the bot is in one server or DISCORD_GUILD_ID is set.");
export const channelRef = z.string().describe("Channel or thread name, id, or message link");
export const reason = z.string().optional().describe("Reason shown in the server's audit log");

export const Embed = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional().describe("Link for the title"),
  color: z.union([z.string(), z.number()]).optional().describe('Hex like "#57F287", a name like "green", or a number'),
  fields: z.array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() })).optional(),
  author: z.string().optional(),
  author_icon: z.string().optional().describe("Author icon URL"),
  footer: z.string().optional(),
  footer_icon: z.string().optional().describe("Footer icon URL"),
  image: z.string().optional().describe('Big image: a URL, or "attachment://file.png" for a file sent with the message'),
  thumbnail: z.string().optional().describe('Small image on the right: URL or "attachment://file.png"'),
  timestamp: z.union([z.boolean(), z.string()]).optional().describe("true for now, or an ISO date"),
});

export function toEmbed(e) {
  return {
    title: e.title, description: e.description, url: e.url, color: color(e.color), fields: e.fields,
    author: e.author ? { name: e.author, icon_url: e.author_icon } : undefined,
    footer: e.footer ? { text: e.footer, icon_url: e.footer_icon } : undefined,
    image: e.image ? { url: e.image } : undefined,
    thumbnail: e.thumbnail ? { url: e.thumbnail } : undefined,
    timestamp: e.timestamp === true ? new Date().toISOString() : e.timestamp || undefined,
  };
}

export const FileInput = z.object({
  source: z.string().describe("Local file path or http(s) URL"),
  name: z.string().optional().describe("File name in Discord (use it in attachment://name)"),
  description: z.string().optional().describe("Alt text"),
  spoiler: z.boolean().optional(),
});

export async function loadFiles(list = []) {
  const out = [];
  for (const f of list) {
    const file = await loadFile(f.source, f.name);
    if (f.spoiler && !file.name.startsWith("SPOILER_")) file.name = `SPOILER_${file.name}`;
    file.description = f.description;
    out.push(file);
  }
  return out;
}

export const attachmentsMeta = (files) =>
  files.length ? files.map((f, i) => ({ id: i, filename: f.name, description: f.description })) : undefined;

export const LinkButton = z.object({
  label: z.string(), url: z.string(), emoji: z.string().optional().describe("Unicode emoji"),
});

export function linkButtons(buttons) {
  if (!buttons?.length) return undefined;
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5).map((b) => ({
      type: 2, style: 5, label: b.label, url: b.url, emoji: b.emoji ? { name: b.emoji } : undefined })) });
  }
  return rows;
}

/** Drops undefined keys so PATCH requests only touch what was given. */
export function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export const messageLink = (g, c, m) => `https://discord.com/channels/${g}/${c}/${m}`;
