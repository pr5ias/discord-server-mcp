// Live connection to Discord for every configured bot: online presence, real-time events
// (messages, mentions, joins, reactions, button clicks) kept in a short buffer, and hooks for automations.
import { config } from "./config.js";

const ACTIVITY = { playing: 0, listening: 2, watching: 3, competing: 5, custom: 4 };

export const INTENTS = {
  Guilds: 1 << 0, GuildMembers: 1 << 1, GuildModeration: 1 << 2, GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10, DirectMessages: 1 << 12, MessageContent: 1 << 15, AutoModerationExecution: 1 << 21,
};
const PRIVILEGED = INTENTS.GuildMembers | INTENTS.MessageContent;
const ALL = Object.values(INTENTS).reduce((a, b) => a | b, 0);

/** Recent events from all bots, newest last. */
const buffer = [];
const MAX = 1000;
let nextId = 1;
const waiters = new Set();
const handlers = new Map(); // event type -> Set of fn(event, raw, bot)

/** Status per bot token: { connected, intents, missingPrivileged, user, error }. */
export const status = new Map();
const started = new Set();

export function onEvent(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
}

/** Events matching a filter. */
export function getEvents({ since = 0, types, guildId, channelId, limit = 50, match } = {}) {
  return buffer.filter((e) => e.id > since && (!types?.length || types.includes(e.type))
    && (!guildId || e.guild_id === guildId) && (!channelId || e.channel_id === channelId) && (!match || match(e))).slice(-limit);
}

/** Resolves with the first new event that matches, or null after the timeout. */
export function waitForEvent(filter, timeoutMs) {
  return new Promise((resolve) => {
    const w = { filter, resolve };
    waiters.add(w);
    setTimeout(() => {
      if (waiters.delete(w)) resolve(null);
    }, timeoutMs).unref?.();
  });
}

export const lastEventId = () => nextId - 1;

function record(e) {
  e.id = nextId++;
  e.at = new Date().toISOString();
  buffer.push(e);
  if (buffer.length > MAX) buffer.shift();
  for (const w of [...waiters]) {
    if (w.filter(e)) {
      waiters.delete(w);
      w.resolve(e);
    }
  }
}

/** Short, model-friendly form of a gateway dispatch, or null for events we don't keep. */
function normalise(t, d, bot) {
  const base = { bot: bot.name, guild_id: d.guild_id, channel_id: d.channel_id };
  switch (t) {
    case "MESSAGE_CREATE":
      if (d.author?.id === bot.id) return null;
      return { ...base, type: "message", message_id: d.id, author: d.author?.global_name || d.author?.username, author_id: d.author?.id,
        bot_author: d.author?.bot || undefined, content: d.content || (d.embeds?.length ? "(embed)" : d.attachments?.length ? "(attachment)" : ""),
        mentions_bot: d.mentions?.some((m) => m.id === bot.id) || undefined, reply_to: d.message_reference?.message_id,
        dm: !d.guild_id || undefined };
    case "MESSAGE_UPDATE":
      if (!d.content || d.author?.id === bot.id) return null;
      return { ...base, type: "message_edit", message_id: d.id, author: d.author?.username, content: d.content };
    case "MESSAGE_DELETE":
      return { ...base, type: "message_delete", message_id: d.id };
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE":
      if (d.user_id === bot.id) return null;
      return { ...base, type: t === "MESSAGE_REACTION_ADD" ? "reaction_add" : "reaction_remove", message_id: d.message_id,
        user_id: d.user_id, user: d.member?.user?.username, emoji: d.emoji?.id ? `${d.emoji.name}:${d.emoji.id}` : d.emoji?.name };
    case "GUILD_MEMBER_ADD":
      return { ...base, type: "member_join", user_id: d.user?.id, user: d.user?.username, is_bot: d.user?.bot || undefined };
    case "GUILD_MEMBER_REMOVE":
      return { ...base, type: "member_leave", user_id: d.user?.id, user: d.user?.username };
    case "GUILD_BAN_ADD":
      return { ...base, type: "ban", user_id: d.user?.id, user: d.user?.username };
    case "THREAD_CREATE":
      return d.newly_created ? { ...base, type: "thread_create", channel_id: d.id, parent_id: d.parent_id, name: d.name } : null;
    case "GUILD_CREATE":
      return d.joined_at && Date.now() - Date.parse(d.joined_at) < 60000 ? { ...base, guild_id: d.id, type: "bot_added", name: d.name } : null;
    case "GUILD_DELETE":
      return d.unavailable ? null : { ...base, guild_id: d.id, type: "bot_removed" };
    case "INTERACTION_CREATE":
      return { ...base, type: "interaction", custom_id: d.data?.custom_id, user: d.member?.user?.username || d.user?.username,
        user_id: d.member?.user?.id || d.user?.id };
    default:
      return null;
  }
}

/** Connects every configured bot that is not connected yet. */
export function startGateway() {
  if (config.gateway === "off" || typeof WebSocket === "undefined") return;
  for (const bot of config.bots) connectBot(bot);
}

function connectBot(bot) {
  if (!bot?.token || started.has(bot.token)) return;
  started.add(bot.token);
  const p = config.presence;
  let intents = ALL;
  let delay = 5000;
  let session = null;
  let resumeUrl = null;
  let seq = null;
  const st = { connected: false, intents: [], missing_privileged: [] };
  status.set(bot.token, st);

  const activity = () => {
    if (!p.text || !p.enabled) return [];
    const type = ACTIVITY[p.type] ?? 3;
    return [type === 4 ? { name: "Custom Status", state: p.text, type } : { name: p.text, type }];
  };

  const connect = () => {
    let ws;
    let beat;
    try {
      ws = new WebSocket(`${resumeUrl || "wss://gateway.discord.gg"}/?v=10&encoding=json`);
    } catch {
      setTimeout(connect, delay);
      return;
    }
    const send = (op, d) => {
      try {
        ws.send(JSON.stringify({ op, d }));
      } catch {
        // closed; onclose reconnects
      }
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.s !== null && msg.s !== undefined) seq = msg.s;
      if (msg.op === 10) {
        clearInterval(beat);
        beat = setInterval(() => send(1, seq), msg.d.heartbeat_interval);
        if (session) {
          send(6, { token: bot.token, session_id: session, seq });
        } else {
          send(2, {
            token: bot.token, intents,
            properties: { os: process.platform, browser: "discord-server-mcp", device: "discord-server-mcp" },
            presence: { status: p.enabled ? p.status : "invisible", since: null, afk: false, activities: activity() },
          });
        }
      } else if (msg.op === 1) {
        send(1, seq);
      } else if (msg.op === 7) {
        ws.close(4000);
      } else if (msg.op === 9) {
        session = null;
        resumeUrl = null;
        ws.close(4000);
      } else if (msg.op === 0) {
        if (msg.t === "READY") {
          delay = 5000;
          session = msg.d.session_id;
          resumeUrl = msg.d.resume_gateway_url;
          bot.id = bot.id || msg.d.user.id;
          // Bots read from token.txt or the environment have no name yet: use the bot's own.
          if (!bot.name || bot.name === bot.source || bot.name === "DISCORD_BOT_TOKEN") bot.name = msg.d.user.global_name || msg.d.user.username;
          Object.assign(st, { connected: true, user: msg.d.user.username,
            intents: Object.entries(INTENTS).filter(([, v]) => intents & v).map(([k]) => k),
            missing_privileged: Object.entries(INTENTS).filter(([, v]) => PRIVILEGED & v && !(intents & v)).map(([k]) => k) });
        }
        if (msg.t === "RESUMED") st.connected = true;
        const ctx = { ...bot, id: bot.id };
        const e = normalise(msg.t, msg.d || {}, ctx);
        if (e) record(e);
        for (const fn of handlers.get(msg.t) || []) {
          Promise.resolve().then(() => fn(msg.d, bot)).catch((err) => process.stderr.write(`discord-server-mcp: ${msg.t} handler: ${err.message}\n`));
        }
      }
    };
    ws.onclose = (event) => {
      clearInterval(beat);
      st.connected = false;
      const code = event?.code;
      if (code === 4014 && intents & PRIVILEGED) {
        // Privileged intents not enabled in the Developer Portal: continue without them.
        intents &= ~PRIVILEGED;
        session = null;
        resumeUrl = null;
        setTimeout(connect, 1000);
        return;
      }
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        st.error = code === 4004 ? "invalid token" : `gateway closed (${code})`;
        process.stderr.write(`discord-server-mcp: ${bot.name}: ${st.error}\n`);
        return;
      }
      if ([4007, 4009].includes(code)) {
        session = null;
        resumeUrl = null;
      }
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 300000);
    };
    ws.onerror = () => {};
  };
  connect();
}
