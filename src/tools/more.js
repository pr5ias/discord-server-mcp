// DMs, pruning, bot profile, effective permissions, role audit, message search, onboarding, stage,
// soundboard and application commands.
import { z } from "zod";
import {
  api, guildId, channel, role, member, me, permNames, imageData, loadFile, defined, server, channelRef, reason,
  Embed, toEmbed, FileInput, loadFiles, attachmentsMeta, PERMISSIONS, DiscordError, messageLink, roleAbove, topRole, byRank,
} from "../discord.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const ALL = (1n << 53n) - 1n;
const ADMIN = 1n << 3n;
const VIEW = 1n << 10n;

/** Discord's permission maths for a member (or a role alone) in an optional channel. */
function effective(g, roles, memberRoleIds, userId, ch) {
  const byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  let perms = BigInt(byId[g].permissions);
  for (const id of memberRoleIds) if (byId[id]) perms |= BigInt(byId[id].permissions);
  if (perms & ADMIN) return ALL;
  if (!ch) return perms;
  const ow = Object.fromEntries((ch.permission_overwrites || []).map((o) => [o.id, o]));
  if (ow[g]) perms = (perms & ~BigInt(ow[g].deny)) | BigInt(ow[g].allow);
  let allow = 0n;
  let deny = 0n;
  for (const id of memberRoleIds) {
    if (ow[id]) {
      allow |= BigInt(ow[id].allow);
      deny |= BigInt(ow[id].deny);
    }
  }
  perms = (perms & ~deny) | allow;
  if (userId && ow[userId]) perms = (perms & ~BigInt(ow[userId].deny)) | BigInt(ow[userId].allow);
  return perms;
}

const DANGEROUS = ["Administrator", "ManageGuild", "ManageRoles", "ManageChannels", "ManageWebhooks", "BanMembers",
  "KickMembers", "ModerateMembers", "ManageMessages", "MentionEveryone", "ManageGuildExpressions", "ManageEvents"];

export default function register(t) {
  // ------------------------------------------------------------------ members
  let tool = t("members");

  tool("send_dm", "Send a direct message to a member (they must share a server with the bot and allow DMs from server members).", {
    server, member: z.string(), content: z.string().optional(), embeds: z.array(Embed).max(10).optional(),
    files: z.array(FileInput).max(10).optional(),
  }, async (a) => {
    if (!a.content && !a.embeds?.length && !a.files?.length) throw new DiscordError("Give content, embeds or files.");
    const g = await guildId(a.server);
    const m = await member(g, a.member);
    const dm = await api("POST", "/users/@me/channels", { recipient_id: m.user.id });
    const files = await loadFiles(a.files);
    const msg = await api("POST", `/channels/${dm.id}/messages`, defined({
      content: a.content, embeds: a.embeds?.map(toEmbed), attachments: attachmentsMeta(files), allowed_mentions: { parse: [] },
    }), { files });
    return { sent_to: m.user.username, message_id: msg.id };
  });

  tool("prune_members", "Remove members who have not been active for some days and have no roles (or only the listed roles). Without confirm it only counts them.", {
    server, days: z.number().int().min(1).max(30), include_roles: z.array(z.string()).optional().describe("Also prune members with these roles"),
    reason,
  }, async ({ server: s, days, include_roles, reason: r }) => {
    const g = await guildId(s);
    const roleIds = include_roles ? await Promise.all(include_roles.map(async (x) => (await role(g, x)).id)) : [];
    const q = new URLSearchParams({ days: String(days) });
    if (roleIds.length) q.set("include_roles", roleIds.join(","));
    const count = await api("GET", `/guilds/${g}/prune?${q}`);
    await api("POST", `/guilds/${g}/prune`, { days, include_roles: roleIds, compute_prune_count: true }, { reason: r });
    return { members_affected: count.pruned, days };
  }, DESTRUCTIVE);

  // ------------------------------------------------------------------ server
  tool = t("server");

  tool("edit_bot_profile", "Change the bot's own name, avatar or banner (applies everywhere). For a per-server nickname use edit_member with member \"bot\".", {
    username: z.string().optional(), avatar: z.string().optional().describe("Image path or URL"),
    banner: z.string().optional().describe("Image path or URL"),
  }, async ({ username, avatar, banner }) => {
    const out = await api("PATCH", "/users/@me", defined({
      username, avatar: avatar ? await imageData(avatar) : undefined, banner: banner ? await imageData(banner) : undefined,
    }));
    return { updated: out.username };
  });

  tool("check_permissions",
    "What a member or role can actually do, on the server or in one channel, after roles and channel overrides. Also answers \"who can see this channel?\" when only a channel is given.", {
      server, channel: z.string().optional(), member: z.string().optional(), role: z.string().optional(),
    }, async ({ server: s, channel: ch, member: mRef, role: rRef }) => {
      const g = await guildId(s);
      const roles = await api("GET", `/guilds/${g}/roles`);
      const c = ch ? await channel(g, ch) : undefined;
      if (!mRef && !rRef) {
        if (!c) throw new DiscordError("Give a member, a role, or a channel.");
        const canSee = roles.filter((r) => effective(g, roles, r.id === g ? [] : [r.id], null, c) & VIEW).map((r) => r.name);
        const cannot = roles.filter((r) => !canSee.includes(r.name)).map((r) => r.name);
        return { channel: c.name, roles_that_can_see: canSee, roles_that_cannot: cannot,
          note: "A member sees the channel if any of their roles can, unless a member override says otherwise." };
      }
      let ids = [];
      let who;
      let userId = null;
      if (mRef) {
        const m = await member(g, mRef);
        ids = m.roles;
        who = m.user.username;
        userId = m.user.id;
        const info = await api("GET", `/guilds/${g}`);
        if (info.owner_id === userId) return { who, owner: true, permissions: ["everything (server owner)"] };
      } else {
        const r = await role(g, rRef);
        ids = r.id === g ? [] : [r.id];
        who = r.name;
      }
      let p = effective(g, roles, ids, userId, c);
      // Discord's implicit rules inside a channel: no View Channel means nothing; no Send Messages means
      // no attachments, links, pings, polls or TTS either.
      const bit = (n) => 1n << BigInt(PERMISSIONS[n]);
      if (c && p !== ALL) {
        if (!(p & bit("ViewChannel"))) p = 0n;
        else if (!(p & bit("SendMessages"))) {
          for (const n of ["SendTTSMessages", "EmbedLinks", "AttachFiles", "MentionEveryone", "SendPolls", "SendVoiceMessages"]) p &= ~bit(n);
        }
      }
      return { who, where: c ? c.name : "server", administrator: p === ALL,
        can: p === ALL ? ["everything (Administrator)"] : permNames(p.toString()),
        cannot: p === ALL ? [] : Object.keys(PERMISSIONS).filter((k) => !(p & (1n << BigInt(PERMISSIONS[k])))) };
    }, READ);

  tool("audit_roles", "Check roles for risk: dangerous permissions, roles the bot cannot manage, risky @everyone permissions, and member counts when available.", {
    server,
  }, async ({ server: s }) => {
    const g = await guildId(s);
    const bot = await me();
    const [roles, botMember] = await Promise.all([api("GET", `/guilds/${g}/roles`), api("GET", `/guilds/${g}/members/${bot.id}`)]);
    const botTop = topRole(roles, botMember.roles);
    let counts = null;
    try {
      const members = await api("GET", `/guilds/${g}/members?limit=1000`);
      counts = {};
      for (const m of members) for (const id of m.roles) counts[id] = (counts[id] || 0) + 1;
    } catch {
      // Server Members Intent off: no counts.
    }
    const findings = [];
    const everyone = roles.find((r) => r.id === g);
    const everyoneRisky = permNames(everyone.permissions).filter((p) => DANGEROUS.includes(p));
    if (everyoneRisky.length) findings.push(`@everyone has risky permissions: ${everyoneRisky.join(", ")}`);
    const report = roles.filter((r) => r.id !== g).sort(byRank).map((r) => {
      const risky = permNames(r.permissions).filter((p) => DANGEROUS.includes(p));
      if (r.permissions && risky.includes("Administrator") && !r.managed) findings.push(`"${r.name}" has Administrator`);
      if (counts && !r.managed && !counts[r.id]) findings.push(`"${r.name}" has no members`);
      return defined({ name: r.name, members: counts ? counts[r.id] || 0 : undefined, risky: risky.length ? risky : undefined,
        bot_can_manage: r.managed ? undefined : !!botTop && roleAbove(botTop, r), managed_by_integration: r.managed || undefined,
        mentionable: r.mentionable || undefined });
    });
    if (!counts) findings.push("Member counts unavailable (turn on Server Members Intent for the bot to see them).");
    return { findings, roles: report };
  }, READ);

  tool("search_messages", "Search recent messages across the server's text channels, forums' active posts and threads (and their titles) for words or an author.", {
    server, query: z.string().optional().describe("Words to find (case-insensitive)"), author: z.string().optional(),
    channels: z.array(z.string()).optional().describe("Only these channels"),
    per_channel: z.number().int().min(10).max(500).default(100).describe("How many recent messages to look at per channel"),
    max_results: z.number().int().min(1).max(100).default(25),
  }, async ({ server: s, query, author, channels: only, per_channel, max_results }) => {
    if (!query && !author) throw new DiscordError("Give query and/or author.");
    const g = await guildId(s);
    const authorId = author ? (await member(g, author)).user.id : null;
    let list;
    if (only) list = await Promise.all(only.map((x) => channel(g, x)));
    else {
      const all = await api("GET", `/guilds/${g}/channels`);
      const threads = await api("GET", `/guilds/${g}/threads/active`).then((r) => r.threads).catch(() => []);
      list = [...all.filter((c) => [0, 5].includes(c.type)), ...threads];
    }
    const q = query?.toLowerCase();
    const results = [];
    for (const c of list) {
      // Forum and thread titles count too.
      if (q && [11, 12].includes(c.type) && c.name?.toLowerCase().includes(q) && !authorId) {
        results.push({ channel: c.name, author: "(title)", time: c.thread_metadata?.create_timestamp, text: c.name, link: `https://discord.com/channels/${g}/${c.id}` });
      }
      let before;
      for (let fetched = 0; fetched < per_channel;) {
        const page = await api("GET", `/channels/${c.id}/messages?limit=${Math.min(100, per_channel - fetched)}${before ? `&before=${before}` : ""}`).catch(() => []);
        if (!page.length) break;
        fetched += page.length;
        before = page.at(-1).id;
        for (const m of page) {
          const text = [m.content, ...(m.embeds || []).flatMap((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name} ${f.value}`)]),
            m.poll?.question?.text, ...(m.poll?.answers || []).map((x) => x.poll_media?.text)]
            .filter(Boolean).join(" ");
          if ((!q || text.toLowerCase().includes(q)) && (!authorId || m.author.id === authorId)) {
            results.push({ channel: c.name, author: m.author.username, time: m.timestamp, text: text.slice(0, 200), link: messageLink(g, c.id, m.id) });
            if (results.length >= max_results) return { results, note: "Stopped at max_results." };
          }
        }
        if (page.length < 100) break;
      }
    }
    return { results, searched_channels: list.length };
  }, READ);

  tool("get_onboarding", "Show the server's onboarding (questions new members answer and default channels).", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    return api("GET", `/guilds/${g}/onboarding`);
  }, READ);

  tool("edit_onboarding",
    "Set up onboarding for a Community server: default channels and questions whose answers give roles and channels.", {
      server, enabled: z.boolean().optional(),
      default_channels: z.array(z.string()).optional(),
      questions: z.array(z.object({
        title: z.string(), single_select: z.boolean().default(false), required: z.boolean().default(false),
        options: z.array(z.object({ title: z.string(), description: z.string().optional(), emoji: z.string().optional(),
          roles: z.array(z.string()).default([]), channels: z.array(z.string()).default([]) })).min(1),
      })).optional(),
      mode: z.enum(["default", "advanced"]).optional(),
    }, async (a) => {
      const g = await guildId(a.server);
      const ids = async (list, fn) => Promise.all((list || []).map(async (x) => (await fn(g, x)).id));
      const prompts = a.questions ? await Promise.all(a.questions.map(async (q, i) => ({
        id: String(i), type: 0, title: q.title, single_select: q.single_select, required: q.required, in_onboarding: true,
        options: await Promise.all(q.options.map(async (o, j) => defined({
          id: String(j), title: o.title, description: o.description, emoji: o.emoji ? { name: o.emoji } : undefined,
          role_ids: await ids(o.roles, role), channel_ids: await ids(o.channels, channel) }))),
      }))) : undefined;
      const out = await api("PUT", `/guilds/${g}/onboarding`, defined({
        enabled: a.enabled, prompts, mode: a.mode === undefined ? undefined : a.mode === "advanced" ? 1 : 0,
        default_channel_ids: a.default_channels ? await ids(a.default_channels, channel) : undefined,
      }));
      return out ?? { updated: true };
    });

  // ------------------------------------------------------------------ channels: stage
  tool = t("channels");

  tool("start_stage", "Start a live stage in a stage channel with a topic.", {
    server, channel: channelRef, topic: z.string(), notify_everyone: z.boolean().optional(),
  }, async ({ server: s, channel: ch, topic, notify_everyone }) => {
    const g = await guildId(s);
    const c = await channel(g, ch, [13]);
    const out = await api("POST", "/stage-instances", { channel_id: c.id, topic, privacy_level: 2, send_start_notification: !!notify_everyone });
    return { started: out?.topic ?? topic, channel: c.name };
  });

  tool("end_stage", "End the live stage in a stage channel.", { server, channel: channelRef }, async ({ server: s, channel: ch }) => {
    const g = await guildId(s);
    const c = await channel(g, ch, [13]);
    await api("DELETE", `/stage-instances/${c.id}`);
    return { ended: c.name };
  });

  // ------------------------------------------------------------------ expressions: soundboard
  tool = t("expressions");

  tool("list_sounds", "List the server's soundboard sounds.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const out = await api("GET", `/guilds/${g}/soundboard-sounds`);
    return (out.items || out).map((x) => defined({ name: x.name, id: x.sound_id, emoji: x.emoji_name || undefined, volume: x.volume }));
  }, READ);

  tool("create_sound", "Add a soundboard sound from an MP3 or OGG file (max 512 KB, 5 seconds).", {
    server, name: z.string(), file: z.string().describe("Path or URL"), emoji: z.string().optional(), volume: z.number().min(0).max(1).optional(),
  }, async ({ server: s, name, file, emoji, volume }) => {
    const g = await guildId(s);
    const f = await loadFile(file);
    const out = await api("POST", `/guilds/${g}/soundboard-sounds`, defined({
      name, sound: `data:${f.type};base64,${f.data.toString("base64")}`, emoji_name: emoji, volume }));
    return { created: out.name, id: out.sound_id };
  });

  tool("delete_sound", "Delete a soundboard sound.", { server, sound: z.string().describe("Name or id") }, async ({ server: s, sound }) => {
    const g = await guildId(s);
    const out = await api("GET", `/guilds/${g}/soundboard-sounds`);
    const x = (out.items || out).find((y) => y.sound_id === sound || y.name.toLowerCase() === sound.toLowerCase());
    if (!x) throw new DiscordError(`No sound "${sound}".`);
    await api("DELETE", `/guilds/${g}/soundboard-sounds/${x.sound_id}`);
    return { deleted: x.name };
  }, DESTRUCTIVE);

  // ------------------------------------------------------------------ automation: application commands
  tool = t("automation");

  tool("list_commands", "List the slash commands registered by this bot (globally and in the server).", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const app = await api("GET", "/oauth2/applications/@me");
    const [global, local] = await Promise.all([
      api("GET", `/applications/${app.id}/commands`), api("GET", `/applications/${app.id}/guilds/${g}/commands`)]);
    const show = (c) => ({ id: c.id, name: c.name, description: c.description });
    return { global: global.map(show), server: local.map(show),
      note: "Commands need a running bot to answer them; this MCP server only registers and removes them." };
  }, READ);

  tool("delete_command", "Remove a slash command registered by this bot (e.g. leftovers from an old bot program).", {
    server, command: z.string().describe("Name or id"), scope: z.enum(["server", "global"]).default("server"),
  }, async ({ server: s, command, scope }) => {
    const g = await guildId(s);
    const app = await api("GET", "/oauth2/applications/@me");
    const base = scope === "global" ? `/applications/${app.id}/commands` : `/applications/${app.id}/guilds/${g}/commands`;
    const list = await api("GET", base);
    const c = list.find((x) => x.id === command || x.name === command.replace(/^\//, ""));
    if (!c) throw new DiscordError(`No ${scope} command "${command}".`);
    await api("DELETE", `${base}/${c.id}`);
    return { deleted: `/${c.name}`, scope };
  }, DESTRUCTIVE);

}
