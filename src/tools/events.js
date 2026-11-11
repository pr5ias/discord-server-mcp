// Real-time events: what happened on the servers since the bots connected (messages, mentions, joins,
// reactions, button clicks), and waiting for something specific to happen.
import { z } from "zod";
import { api, guildId, channel, defined, server, DiscordError } from "../discord.js";
import { config } from "../config.js";
import { status, getEvents, waitForEvent, lastEventId } from "../gateway.js";
import { READ } from "../tool.js";

const TYPES = ["message", "message_edit", "message_delete", "reaction_add", "reaction_remove", "member_join", "member_leave",
  "ban", "thread_create", "bot_added", "bot_removed", "interaction"];

const names = new Map();
async function channelName(id) {
  if (!id) return undefined;
  if (!names.has(id)) names.set(id, await api("GET", `/channels/${id}`).then((c) => c.name).catch(() => `deleted channel ${id}`));
  return names.get(id);
}

async function present(e) {
  return defined({ ...e, channel: await channelName(e.channel_id), channel_id: undefined, guild_id: undefined });
}

function filterFrom(a, g, chId) {
  const words = a.contains?.toLowerCase();
  return (e) => (!a.types?.length || a.types.includes(e.type))
    && (!g || e.guild_id === g) && (!chId || e.channel_id === chId)
    && (!words || (e.content || "").toLowerCase().includes(words))
    && (!a.from || [e.author, e.user, e.author_id, e.user_id].some((x) => x && String(x).toLowerCase() === a.from.toLowerCase()))
    && (!a.mentions_only || e.mentions_bot);
}

export default function register(t) {
  const tool = t("events");

  tool("events_status",
    "Whether the bots are connected live and which kinds of events they can see. Without Message Content intent message text is empty; without Server Members intent joins/leaves are not seen.",
    {}, async () => {
      if (config.gateway === "off") return { live: false, note: "DISCORD_GATEWAY=off: no live connection." };
      return {
        bots: config.bots.map((b) => {
          const st = status.get(b.token) || {};
          return defined({ bot: b.name, connected: Boolean(st.connected), intents: st.intents, error: st.error,
            missing_privileged: st.missing_privileged?.length ? st.missing_privileged : undefined });
        }),
        events_buffered: lastEventId(),
        how_to_enable_more: "Developer Portal > your app > Bot > Privileged Gateway Intents: turn on Message Content and Server Members, then restart the app.",
      };
    }, READ);

  tool("get_events",
    "What happened since the bots connected (up to the last 1000 events): new messages, mentions of the bot, edits, deletions, reactions, members joining or leaving, bans, new threads, button clicks. Filter by server, channel, type, author or words. Pass since (an event id) to get only newer ones.", {
      server, channel: z.string().optional(),
      types: z.array(z.enum(TYPES)).optional(),
      contains: z.string().optional().describe("Words in the message"),
      from: z.string().optional().describe("Author or user name/id"),
      mentions_only: z.boolean().optional().describe("Only messages that mention the bot"),
      since: z.number().int().optional().describe("Event id; only events after it"),
      limit: z.number().int().min(1).max(200).default(50),
    }, async (a) => {
      const g = a.server ? await guildId(a.server) : undefined;
      const chId = a.channel ? (await channel(g, a.channel)).id : undefined;
      const list = getEvents({ since: a.since || 0, limit: a.limit, match: filterFrom(a, g, chId) });
      return { latest_event_id: lastEventId(), count: list.length, events: await Promise.all(list.map(present)),
        note: config.gateway === "off" ? "Live events are off (DISCORD_GATEWAY=off)." : undefined };
    }, READ);

  tool("wait_for_event",
    "Wait (up to 50 seconds per call) until something matching happens, e.g. a reply in a channel, a mention of the bot, someone joining, or a reaction. Returns the event, or timed_out so you can call again.", {
      server, channel: z.string().optional(),
      types: z.array(z.enum(TYPES)).optional().describe('Default ["message"]'),
      contains: z.string().optional(), from: z.string().optional(), mentions_only: z.boolean().optional(),
      timeout_seconds: z.number().int().min(1).max(50).default(30),
    }, async (a) => {
      if (config.gateway === "off") throw new DiscordError("Live events are off (DISCORD_GATEWAY=off).");
      const g = a.server ? await guildId(a.server) : undefined;
      const chId = a.channel ? (await channel(g, a.channel)).id : undefined;
      const e = await waitForEvent(filterFrom({ ...a, types: a.types?.length ? a.types : ["message"] }, g, chId), a.timeout_seconds * 1000);
      return e ? { event: await present(e) } : { timed_out: true, latest_event_id: lastEventId() };
    }, READ);
}
