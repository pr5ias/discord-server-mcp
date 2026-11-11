import { z } from "zod";
import {
  api, guildId, channel, role, member, bits, permNames, color, imageData, defined, server, reason, PERMISSION_LIST,
  DiscordError, me, topRole, roleAbove, byRank,
} from "../discord.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const hex = (n) => (n ? "#" + n.toString(16).padStart(6, "0") : undefined);

function memberSummary(m, roleNames) {
  return defined({
    id: m.user.id, username: m.user.username, display_name: m.nick || m.user.global_name || undefined,
    bot: m.user.bot || undefined, joined: m.joined_at?.slice(0, 10),
    roles: m.roles.map((r) => roleNames[r] || r),
    timed_out_until: m.communication_disabled_until && new Date(m.communication_disabled_until) > new Date()
      ? m.communication_disabled_until : undefined,
  });
}

export default function register(t) {
  const tool = t("members");
  // ------------------------------------------------------------------ roles

  tool("list_roles", "List roles (top to bottom) with colour, permissions and member count hints.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const roles = await api("GET", `/guilds/${g}/roles`);
    return roles.sort((a, b) => b.position - a.position).map((r) => defined({
      id: r.id, name: r.name, color: hex(r.color), shown_separately: r.hoist || undefined, mentionable: r.mentionable || undefined,
      managed: r.managed || undefined, icon: r.unicode_emoji || undefined, permissions: permNames(r.permissions),
    }));
  }, READ);

  tool("create_role", `Create a role. Permission names: ${PERMISSION_LIST}.`, {
    server, name: z.string(), color: z.union([z.string(), z.number()]).optional(),
    shown_separately: z.boolean().optional().describe("Show members with this role in their own group"),
    mentionable: z.boolean().optional(), permissions: z.array(z.string()).optional().describe("Default: none of its own (members still get what @everyone allows)"),
    icon_emoji: z.string().optional().describe("Unicode emoji shown next to names (needs boost level 2)"),
    icon_image: z.string().optional().describe("Image path or URL (needs boost level 2)"),
    reason,
  }, async (a) => {
    const g = await guildId(a.server);
    const r = await api("POST", `/guilds/${g}/roles`, defined({
      name: a.name, color: color(a.color), hoist: a.shown_separately, mentionable: a.mentionable,
      permissions: a.permissions ? bits(a.permissions) : "0", unicode_emoji: a.icon_emoji,
      icon: a.icon_image ? await imageData(a.icon_image) : undefined,
    }), { reason: a.reason });
    return { created: r.name, id: r.id };
  });

  tool("edit_role", `Edit a role. "permissions" replaces all of them; use add_permissions/remove_permissions to change a few. Permission names: ${PERMISSION_LIST}.`, {
    server, role: z.string(), name: z.string().optional(), color: z.union([z.string(), z.number()]).optional(),
    shown_separately: z.boolean().optional(), mentionable: z.boolean().optional(),
    permissions: z.array(z.string()).optional(), add_permissions: z.array(z.string()).optional(),
    remove_permissions: z.array(z.string()).optional(),
    icon_emoji: z.string().optional().describe('Unicode emoji, or "none"'),
    icon_image: z.string().optional().describe('Image path or URL, or "none"'),
    reason,
  }, async (a) => {
    const g = await guildId(a.server);
    const target = await role(g, a.role);
    let permissions = a.permissions ? BigInt(bits(a.permissions)) : undefined;
    if (a.add_permissions || a.remove_permissions) {
      const current = (await api("GET", `/guilds/${g}/roles`)).find((r) => r.id === target.id);
      permissions = (permissions ?? BigInt(current.permissions)) | BigInt(bits(a.add_permissions));
      permissions &= ~BigInt(bits(a.remove_permissions));
    }
    const out = await api("PATCH", `/guilds/${g}/roles/${target.id}`, defined({
      name: a.name, color: color(a.color), hoist: a.shown_separately, mentionable: a.mentionable,
      permissions: permissions?.toString(),
      unicode_emoji: a.icon_emoji === undefined ? undefined : a.icon_emoji === "none" ? null : a.icon_emoji,
      icon: a.icon_image === undefined ? undefined : await imageData(a.icon_image),
    }), { reason: a.reason });
    return { updated: out.name, permissions: permNames(out.permissions) };
  });

  tool("delete_role", "Delete a role. Cannot be undone.", { server, role: z.string(), reason }, async ({ server: s, role: r, reason: why }) => {
    const g = await guildId(s);
    const target = await role(g, r);
    await api("DELETE", `/guilds/${g}/roles/${target.id}`, undefined, { reason: why });
    return { deleted: target.name };
  }, DESTRUCTIVE);

  tool("reorder_roles", "Put roles in order, top to bottom. Only roles below the bot's highest role can be moved.", {
    server, roles: z.array(z.string()).describe("Roles from top to bottom"),
  }, async ({ server: s, roles }) => {
    const g = await guildId(s);
    const [all, bot] = await Promise.all([api("GET", `/guilds/${g}/roles`), me()]);
    const botMember = await api("GET", `/guilds/${g}/members/${bot.id}`);
    const top = topRole(all, botMember.roles);
    const ranked = all.filter((r) => r.id !== g).sort(byRank);
    const movable = ranked.filter((r) => top && roleAbove(top, r));
    const picked = [];
    for (const ref of roles) {
      const r = await role(g, ref);
      if (!movable.some((x) => x.id === r.id)) throw new DiscordError(`${r.name} is at or above ${top?.name || "the bot's role"}, so the bot cannot move it. Drag the bot's role higher in Server Settings > Roles first.`);
      if (!picked.some((x) => x.id === r.id)) picked.push(r);
    }
    // The picked roles take the places they already hold among the movable roles, in the new order.
    const slots = picked.map((p) => movable.findIndex((x) => x.id === p.id)).sort((a, b) => a - b);
    const order = [...movable];
    slots.forEach((ix, i) => { order[ix] = picked[i]; });
    // Give every movable role its own position. New roles often share one position, and Discord only
    // honours an order when positions differ.
    const body = order.map((r, i) => ({ id: r.id, position: order.length - i }));
    const upper = ranked.filter((r) => !movable.includes(r));
    const lift = upper.length && upper.at(-1).position <= order.length
      ? upper.map((r, i) => ({ id: r.id, position: order.length + upper.length - i })) : [];
    try {
      await api("PATCH", `/guilds/${g}/roles`, [...body, ...lift]);
    } catch (e) {
      if (!lift.length) throw e;
      await api("PATCH", `/guilds/${g}/roles`, body);
    }
    return { order: picked.map((r) => r.name) };
  });

  // ------------------------------------------------------------------ members

  tool("list_members",
    "List server members with their roles. Needs the Server Members Intent enabled for the bot in the Developer Portal (Bot tab).", {
      server, limit: z.number().int().min(1).max(1000).default(100),
      role: z.string().optional().describe("Only members with this role"),
    }, async ({ server: s, limit, role: r }) => {
      const g = await guildId(s);
      const roles = await api("GET", `/guilds/${g}/roles`);
      const names = Object.fromEntries(roles.map((x) => [x.id, x.name]));
      let list;
      try {
        list = await api("GET", `/guilds/${g}/members?limit=${limit}`);
      } catch (e) {
        if (String(e.message).includes("403") || String(e.message).includes("50001")) {
          throw new DiscordError(`${e.message}\nTurn on "Server Members Intent" in the Developer Portal > your app > Bot, then try again.`);
        }
        throw e;
      }
      if (r) {
        const want = await role(g, r);
        list = list.filter((m) => m.roles.includes(want.id));
      }
      return list.map((m) => memberSummary(m, names));
    }, READ);

  tool("get_member", "Details of one member: names, roles, join date, timeout.", {
    server, member: z.string().describe('Id, mention, username, display name, or "bot"'),
  }, async ({ server: s, member: ref }) => {
    const g = await guildId(s);
    const m = await member(g, ref);
    const roles = await api("GET", `/guilds/${g}/roles`);
    return memberSummary(m, Object.fromEntries(roles.map((x) => [x.id, x.name])));
  }, READ);

  tool("set_member_roles", "Give roles to a member and/or take roles away.", {
    server, member: z.string(), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]), reason,
  }, async ({ server: s, member: ref, add, remove, reason: r }) => {
    const g = await guildId(s);
    const m = await member(g, ref);
    for (const x of add) await api("PUT", `/guilds/${g}/members/${m.user.id}/roles/${(await role(g, x)).id}`, undefined, { reason: r });
    for (const x of remove) await api("DELETE", `/guilds/${g}/members/${m.user.id}/roles/${(await role(g, x)).id}`, undefined, { reason: r });
    return { member: m.user.username, added: add, removed: remove };
  });

  tool("edit_member", "Change a member's nickname, server-mute/deafen them, or move/disconnect them in voice.", {
    server, member: z.string(),
    nickname: z.string().optional().describe('New nickname, or "" to reset'),
    mute: z.boolean().optional(), deafen: z.boolean().optional(),
    move_to_voice: z.string().optional().describe('Voice channel, or "disconnect"'),
    reason,
  }, async (a) => {
    const g = await guildId(a.server);
    const m = await member(g, a.member);
    let channel_id;
    if (a.move_to_voice !== undefined) channel_id = a.move_to_voice === "disconnect" ? null : (await channel(g, a.move_to_voice, [2, 13])).id;
    const body = defined({ nick: a.nickname === undefined ? undefined : a.nickname || null, mute: a.mute, deaf: a.deafen, channel_id });
    const isBot = m.user.id === (await api("GET", "/users/@me")).id;
    if (isBot && Object.keys(body).length === 1 && "nick" in body) {
      await api("PATCH", `/guilds/${g}/members/@me`, body, { reason: a.reason });
    } else {
      await api("PATCH", `/guilds/${g}/members/${m.user.id}`, body, { reason: a.reason });
    }
    return { member: m.user.username, changed: Object.keys(body) };
  });

  tool("timeout_member", "Time a member out (they cannot talk or react) for a while, or end a timeout with minutes 0.", {
    server, member: z.string(), minutes: z.number().min(0).max(40320).describe("0 ends the timeout; max 28 days"), reason,
  }, async ({ server: s, member: ref, minutes, reason: r }) => {
    const g = await guildId(s);
    const m = await member(g, ref);
    const until = minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null;
    await api("PATCH", `/guilds/${g}/members/${m.user.id}`, { communication_disabled_until: until }, { reason: r });
    return { member: m.user.username, timed_out_until: until || "ended" };
  });

  tool("kick_member", "Remove a member from the server (they can rejoin with an invite).", {
    server, member: z.string(), reason,
  }, async ({ server: s, member: ref, reason: r }) => {
    const g = await guildId(s);
    const m = await member(g, ref);
    await api("DELETE", `/guilds/${g}/members/${m.user.id}`, undefined, { reason: r });
    return { kicked: m.user.username };
  }, DESTRUCTIVE);

  tool("ban_member", "Ban a user from the server, optionally deleting their recent messages.", {
    server, user: z.string().describe("Member name/id, or a user id of someone not in the server"),
    delete_message_hours: z.number().min(0).max(168).default(0), reason,
  }, async ({ server: s, user, delete_message_hours, reason: r }) => {
    const g = await guildId(s);
    const id = /^\d{15,}$/.test(user) ? user : (await member(g, user)).user.id;
    await api("PUT", `/guilds/${g}/bans/${id}`, { delete_message_seconds: Math.round(delete_message_hours * 3600) }, { reason: r });
    return { banned: id };
  }, DESTRUCTIVE);

  tool("unban_user", "Lift a ban.", { server, user_id: z.string(), reason }, async ({ server: s, user_id, reason: r }) => {
    const g = await guildId(s);
    await api("DELETE", `/guilds/${g}/bans/${user_id}`, undefined, { reason: r });
    return { unbanned: user_id };
  });

  tool("list_bans", "List banned users.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const bans = await api("GET", `/guilds/${g}/bans?limit=1000`);
    return bans.map((b) => defined({ id: b.user.id, username: b.user.username, reason: b.reason || undefined }));
  }, READ);
}
