import { z } from "zod";
import {
  api, guildId, me, channel, botsWithServers, imageData, defined, server, reason, TYPE_NAMES, permNames, DiscordError, roleAbove, topRole, byRank,
} from "../discord.js";
import { READ, DESTRUCTIVE } from "../tool.js";
import { config } from "../config.js";

const VERIFICATION = { none: 0, low: 1, medium: 2, high: 3, very_high: 4 };
const NOTIFICATIONS = { all_messages: 0, only_mentions: 1 };
const CONTENT_FILTER = { disabled: 0, members_without_roles: 1, all_members: 2 };

const hex = (n) => (n ? "#" + n.toString(16).padStart(6, "0") : undefined);

export default function register(t) {
  const tool = t("server");
  tool("list_servers",
    "List every Discord server the configured bots can work on (the servers they were invited to): owner, members, which bot and whether it is administrator there, plus the links to add each bot to another server.",
    {}, async () => {
      const servers = [];
      const bots = [];
      for (const x of await botsWithServers()) {
        if (x.error) {
          bots.push({ bot: x.bot.name, error: x.error });
          continue;
        }
        bots.push({ bot: x.bot.name, add_to_another_server: `https://discord.com/oauth2/authorize?client_id=${x.user.id}&scope=bot+applications.commands&permissions=8` });
        for (const g of x.servers) {
          const info = await api("GET", `/guilds/${g.id}`, undefined, { token: x.bot.token }).catch(() => null);
          const owner = info ? await api("GET", `/guilds/${g.id}/members/${info.owner_id}`, undefined, { token: x.bot.token }).catch(() => null) : null;
          servers.push(defined({
            id: g.id, name: g.name, members: g.approximate_member_count,
            owner: owner ? owner.user.global_name || owner.user.username : info?.owner_id,
            bot: x.bot.name, bot_is_admin: permNames(g.permissions).includes("Administrator"),
          }));
        }
      }
      // Mark servers several bots are in, and which one is used there by default.
      const count = {};
      for (const sv of servers) count[sv.id] = (count[sv.id] || 0) + 1;
      for (const sv of servers) {
        if (count[sv.id] < 2) continue;
        const me = config.bots.find((b) => b.name === sv.bot);
        const bound = config.serverBots?.[sv.id];
        const first = servers.find((x) => x.id === sv.id);
        sv.shared_with_other_bots = true;
        sv.used_by_default = bound ? bound === me?.id || bound === me?.name : first === sv;
      }
      return {
        servers, bots,
        how_it_works: "A bot can only see and change servers it was invited to; anyone with Manage Server there can invite it. Tools use the bot that is in the server you name.",
      };
    }, READ);

  tool("get_server",
    "Overview of a server: settings, every category with its channels (type, topic, forum tags), roles (top to bottom) and the bot's own permissions. Start here before changing anything.",
    { server },
    async ({ server: s }) => {
      const g = await guildId(s);
      const bot = await me();
      const [info, chans, roles, botMember] = await Promise.all([
        api("GET", `/guilds/${g}?with_counts=true`),
        api("GET", `/guilds/${g}/channels`),
        api("GET", `/guilds/${g}/roles`),
        api("GET", `/guilds/${g}/members/${bot.id}`),
      ]);
      const byPos = (a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      const describe = (c) => defined({
        id: c.id, name: c.name, type: TYPE_NAMES[c.type] ?? c.type, topic: c.topic || undefined,
        nsfw: c.nsfw || undefined, slowmode: c.rate_limit_per_user || undefined,
        tags: c.available_tags?.length ? c.available_tags.map((t) => (t.emoji_name ? `${t.emoji_name} ${t.name}` : t.name)) : undefined,
        permission_overrides: c.permission_overwrites?.length || undefined,
      });
      const botRoles = new Set(botMember.roles);
      let botPerms = 0n;
      for (const r of roles) if (botRoles.has(r.id) || r.id === g) botPerms |= BigInt(r.permissions);
      const sortedRoles = [...roles].sort(byRank);
      const botTop = topRole(roles, [...botRoles]);
      return {
        server: defined({
          id: info.id, name: info.name, description: info.description || undefined,
          members: info.approximate_member_count, online: info.approximate_presence_count,
          owner_id: info.owner_id, boost_tier: info.premium_tier, verification_level: info.verification_level,
          features: info.features?.length ? info.features : undefined,
          rules_channel: info.rules_channel_id || undefined, system_channel: info.system_channel_id || undefined,
        }),
        uncategorised: chans.filter((c) => c.type !== 4 && !c.parent_id).sort(byPos).map(describe),
        categories: chans.filter((c) => c.type === 4).sort(byPos).map((cat) => ({
          id: cat.id, name: cat.name,
          channels: chans.filter((c) => c.parent_id === cat.id).sort(byPos).map(describe),
        })),
        roles: sortedRoles.map((r) => defined({
          id: r.id, name: r.name, color: hex(r.color), shown_separately: r.hoist || undefined,
          managed: r.managed || undefined, bot_can_manage: r.id !== g && !r.managed ? !!botTop && roleAbove(botTop, r) : undefined,
        })),
        bot: {
          name: bot.username, id: bot.id,
          administrator: permNames(botPerms).includes("Administrator"),
          permissions: permNames(botPerms).includes("Administrator") ? ["Administrator"] : permNames(botPerms),
        },
      };
    }, READ);

  tool("edit_server", "Change server settings: name, description, icon, banner, splash, verification level, default notifications, content filter, AFK, system and rules channels.", {
    server,
    name: z.string().optional(),
    description: z.string().optional().describe("Only for Community servers"),
    icon: z.string().optional().describe('Image path or URL, or "none" to remove'),
    banner: z.string().optional().describe('Image path or URL (needs boost level 2), or "none"'),
    splash: z.string().optional().describe('Invite background image path or URL (needs boost level 1), or "none"'),
    verification_level: z.enum(["none", "low", "medium", "high", "very_high"]).optional(),
    default_notifications: z.enum(["all_messages", "only_mentions"]).optional(),
    content_filter: z.enum(["disabled", "members_without_roles", "all_members"]).optional(),
    afk_channel: z.string().optional().describe('Voice channel, or "none"'),
    afk_timeout_seconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]).optional(),
    system_channel: z.string().optional().describe('Channel for join messages, or "none"'),
    rules_channel: z.string().optional().describe("Community servers only"),
    public_updates_channel: z.string().optional().describe("Community servers only"),
    community: z.boolean().optional().describe("Turn Community on (needs rules_channel and public_updates_channel; raises verification to low and the content filter to all members if lower). Unlocks onboarding, welcome screen, announcement channels and forums insights"),
    join_messages: z.boolean().optional().describe("Discord's own welcome message in the system channel when someone joins"),
    reason,
  }, async (a) => {
    const g = await guildId(a.server);
    const current = a.community !== undefined || a.join_messages !== undefined ? await api("GET", `/guilds/${g}`) : null;
    const ch = async (v) => (v === undefined ? undefined : v === "none" ? null : (await channel(g, v)).id);
    const body = defined({
      name: a.name, description: a.description,
      icon: a.icon === undefined ? undefined : await imageData(a.icon),
      banner: a.banner === undefined ? undefined : await imageData(a.banner),
      splash: a.splash === undefined ? undefined : await imageData(a.splash),
      verification_level: a.verification_level && VERIFICATION[a.verification_level],
      default_message_notifications: a.default_notifications && NOTIFICATIONS[a.default_notifications],
      explicit_content_filter: a.content_filter && CONTENT_FILTER[a.content_filter],
      afk_channel_id: await ch(a.afk_channel), afk_timeout: a.afk_timeout_seconds,
      system_channel_id: await ch(a.system_channel), rules_channel_id: await ch(a.rules_channel),
      public_updates_channel_id: await ch(a.public_updates_channel),
    });
    if (a.community !== undefined) {
      const features = new Set(current.features || []);
      if (a.community) {
        features.add("COMMUNITY");
        if (!body.rules_channel_id && !current.rules_channel_id) throw new DiscordError("Community needs rules_channel.");
        if (!body.public_updates_channel_id && !current.public_updates_channel_id) throw new DiscordError("Community needs public_updates_channel (a staff-only channel for Discord's notices).");
        if ((body.verification_level ?? current.verification_level) < 1) body.verification_level = 1;
        body.explicit_content_filter = 2;
      } else features.delete("COMMUNITY");
      body.features = [...features];
    }
    if (a.join_messages !== undefined) {
      body.system_channel_flags = a.join_messages ? current.system_channel_flags & ~1 : current.system_channel_flags | 1;
    }
    const out = await api("PATCH", `/guilds/${g}`, body, { reason: a.reason });
    return { updated: out.name, changed: Object.keys(body) };
  });

  tool("create_server",
    "Create a new server owned by the bot. Discord only allows this for bots in fewer than 10 servers and may refuse it entirely; then create the server in the Discord app and invite the bot.",
    { name: z.string(), icon: z.string().optional().describe("Image path or URL") },
    async ({ name, icon }) => {
      const out = await api("POST", "/guilds", defined({ name, icon: icon ? await imageData(icon) : undefined }));
      return { created: out.name, id: out.id, note: "The bot owns this server. Create an invite to join it." };
    });

  tool("leave_server", "Make the bot leave a server. It must be invited again to come back.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    if (!s) throw new DiscordError('Name the server explicitly to leave it.');
    await api("DELETE", `/users/@me/guilds/${g}`);
    return { left: g };
  }, DESTRUCTIVE);

  tool("get_audit_log", "Recent entries of the server's audit log (who changed what).", {
    server, limit: z.number().int().min(1).max(100).default(25),
    user: z.string().optional().describe("Only actions by this user id"),
    action_type: z.number().int().optional().describe("Discord audit log action type number"),
  }, async ({ server: s, limit, user, action_type }) => {
    const g = await guildId(s);
    const q = new URLSearchParams(defined({ limit: String(limit), user_id: user, action_type: action_type?.toString() }));
    const log = await api("GET", `/guilds/${g}/audit-logs?${q}`);
    const users = Object.fromEntries((log.users || []).map((u) => [u.id, u.username]));
    return log.audit_log_entries.map((e) => defined({
      id: e.id, action: e.action_type, by: users[e.user_id] || e.user_id, target: e.target_id, reason: e.reason,
      changes: e.changes?.map((c) => `${c.key}: ${JSON.stringify(c.old_value)} -> ${JSON.stringify(c.new_value)}`),
    }));
  }, READ);

  tool("list_invites", "List the server's invites.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const list = await api("GET", `/guilds/${g}/invites`);
    return list.map((i) => defined({ code: i.code, url: `https://discord.gg/${i.code}`, channel: i.channel?.name,
      by: i.inviter?.username, uses: i.uses, max_uses: i.max_uses || undefined, expires: i.expires_at || "never" }));
  }, READ);

  tool("create_invite", "Create an invite link to a channel.", {
    server, channel: z.string().describe("Channel name or id"),
    max_age_hours: z.number().min(0).max(168).default(0).describe("0 = never expires"),
    max_uses: z.number().int().min(0).max(100).default(0).describe("0 = unlimited"),
    temporary: z.boolean().optional().describe("Kick members who leave without a role"),
    unique: z.boolean().optional(),
  }, async ({ server: s, channel: ch, max_age_hours, max_uses, temporary, unique }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const inv = await api("POST", `/channels/${c.id}/invites`, { max_age: Math.round(max_age_hours * 3600), max_uses, temporary, unique });
    return { url: `https://discord.gg/${inv.code}`, channel: c.name, expires: inv.expires_at || "never" };
  });

  tool("delete_invite", "Delete an invite by its code.", { code: z.string(), reason }, async ({ code, reason: r }) => {
    await api("DELETE", `/invites/${code.replace(/.*\//, "")}`, undefined, { reason: r });
    return { deleted: code };
  }, DESTRUCTIVE);

  tool("edit_welcome_screen", "Set the welcome screen of a Community server (description and up to 5 recommended channels).", {
    server, enabled: z.boolean().optional(), description: z.string().optional(),
    channels: z.array(z.object({ channel: z.string(), description: z.string(), emoji: z.string().optional() })).max(5).optional(),
  }, async ({ server: s, enabled, description, channels }) => {
    const g = await guildId(s);
    const welcome_channels = channels
      ? await Promise.all(channels.map(async (c) => ({ channel_id: (await channel(g, c.channel)).id, description: c.description, emoji_name: c.emoji })))
      : undefined;
    const out = await api("PATCH", `/guilds/${g}/welcome-screen`, defined({ enabled, description, welcome_channels }));
    return out;
  });
}
