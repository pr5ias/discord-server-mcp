// Everyday moderation and insight helpers: lock/unlock, permission sync and copy, stats, activity,
// who reacted, poll results and a member export.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { api, guildId, channel, role, bits, defined, server, channelRef, reason, reactionEmoji, DiscordError, TYPE_NAMES } from "../discord.js";
import { READ } from "../tool.js";

export const LOCK = ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads", "AddReactions", "Connect"];

export async function setOverride(c, targetId, allowAdd, denyAdd, r) {
  const old = (c.permission_overwrites || []).find((o) => o.id === targetId);
  let allow = BigInt(old?.allow || 0);
  let deny = BigInt(old?.deny || 0);
  const a = BigInt(bits(allowAdd));
  const d = BigInt(bits(denyAdd));
  allow = (allow & ~d) | a;
  deny = (deny & ~a) | d;
  // Clearing back to neutral: drop the bits from both.
  return api("PUT", `/channels/${c.id}/permissions/${targetId}`, { type: old?.type ?? 0, allow: allow.toString(), deny: deny.toString() }, { reason: r });
}

export default function register(t) {
  let tool = t("channels");

  tool("lock_channel", "Lock a channel (or every channel of a category): members can still read but not write, react, start threads or join voice. Staff with their own permissions keep access.", {
    server, channel: channelRef, role: z.string().default("@everyone").describe("Who to lock out"), reason,
  }, async ({ server: s, channel: ch, role: r, reason: why }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const target = await role(g, r);
    const list = c.type === 4 ? (await api("GET", `/guilds/${g}/channels`)).filter((x) => x.parent_id === c.id).concat([c]) : [c];
    for (const x of list) await setOverride(x, target.id, [], LOCK, why);
    return { locked: list.map((x) => x.name), for: target.name };
  });

  tool("unlock_channel", "Undo lock_channel: remove the write restrictions it added (other permissions stay as they are).", {
    server, channel: channelRef, role: z.string().default("@everyone"), reason,
  }, async ({ server: s, channel: ch, role: r, reason: why }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const target = await role(g, r);
    const list = c.type === 4 ? (await api("GET", `/guilds/${g}/channels`)).filter((x) => x.parent_id === c.id).concat([c]) : [c];
    const lockBits = BigInt(bits(LOCK));
    for (const x of list) {
      const old = (x.permission_overwrites || []).find((o) => o.id === target.id);
      if (!old) continue;
      await api("PUT", `/channels/${x.id}/permissions/${target.id}`, { type: old.type, allow: old.allow, deny: (BigInt(old.deny) & ~lockBits).toString() }, { reason: why });
    }
    return { unlocked: list.map((x) => x.name), for: target.name };
  });

  tool("sync_permissions", "Make channels use exactly their category's permissions again (removes their own overrides).", {
    server, channels: z.array(z.string()).min(1),
  }, async ({ server: s, channels }) => {
    const g = await guildId(s);
    const out = [];
    for (const ref of channels) {
      const c = await channel(g, ref);
      if (!c.parent_id) throw new DiscordError(`#${c.name} is not in a category.`);
      const parent = await api("GET", `/channels/${c.parent_id}`);
      await api("PATCH", `/channels/${c.id}`, { permission_overwrites: parent.permission_overwrites });
      out.push(c.name);
    }
    return { synced: out };
  });

  tool("copy_permissions", "Copy all permission overrides from one channel or category to others.", {
    server, from: z.string(), to: z.array(z.string()).min(1),
  }, async ({ server: s, from, to }) => {
    const g = await guildId(s);
    const src = await channel(g, from);
    const out = [];
    for (const ref of to) {
      const c = await channel(g, ref);
      await api("PATCH", `/channels/${c.id}`, { permission_overwrites: src.permission_overwrites || [] });
      out.push(c.name);
    }
    return { from: src.name, copied_to: out };
  });

  // ------------------------------------------------------------------ insight
  tool = t("server");

  tool("server_stats", "Numbers for a server: members and online, channels by type, roles, emojis, stickers, boosts, threads, and how many channels are private.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const [info, chans, roles, emojis, stickers, threads] = await Promise.all([
      api("GET", `/guilds/${g}?with_counts=true`), api("GET", `/guilds/${g}/channels`), api("GET", `/guilds/${g}/roles`),
      api("GET", `/guilds/${g}/emojis`), api("GET", `/guilds/${g}/stickers`), api("GET", `/guilds/${g}/threads/active`).then((r) => r.threads).catch(() => [])]);
    const byType = {};
    for (const c of chans) byType[TYPE_NAMES[c.type] || c.type] = (byType[TYPE_NAMES[c.type] || c.type] || 0) + 1;
    const priv = chans.filter((c) => (c.permission_overwrites || []).some((o) => o.id === g && BigInt(o.deny) & (1n << 10n))).length;
    return { server: info.name, members: info.approximate_member_count, online: info.approximate_presence_count,
      channels: byType, private_channels_or_categories: priv, roles: roles.length - 1, emojis: emojis.length, stickers: stickers.length,
      active_threads: threads.length, boosts: info.premium_subscription_count, boost_level: info.premium_tier, created: new Date(Number(BigInt(g) >> 22n) + 1420070400000).toISOString().slice(0, 10) };
  }, READ);

  tool("channel_activity", "Which channels are busiest: messages per channel (and top posters) over the last days, from recent history.", {
    server, days: z.number().int().min(1).max(30).default(7), max_per_channel: z.number().int().min(50).max(1000).default(300),
  }, async ({ server: s, days, max_per_channel }) => {
    const g = await guildId(s);
    const since = Date.now() - days * 86400000;
    const chans = (await api("GET", `/guilds/${g}/channels`)).filter((c) => [0, 5].includes(c.type));
    const rows = [];
    const posters = {};
    for (const c of chans) {
      let count = 0;
      let before;
      outer: while (count < max_per_channel) {
        const page = await api("GET", `/channels/${c.id}/messages?limit=100${before ? `&before=${before}` : ""}`).catch(() => []);
        if (!page.length) break;
        for (const m of page) {
          if (Date.parse(m.timestamp) < since) break outer;
          count++;
          if (!m.author.bot) posters[m.author.username] = (posters[m.author.username] || 0) + 1;
        }
        before = page.at(-1).id;
        if (page.length < 100) break;
      }
      rows.push({ channel: c.name, messages: count, capped: count >= max_per_channel || undefined });
    }
    rows.sort((a, b) => b.messages - a.messages);
    return { days, channels: rows, top_posters: Object.entries(posters).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, messages: n })),
      quiet_channels: rows.filter((r) => !r.messages).map((r) => r.channel) };
  }, READ);

  tool("list_reactions", "Who reacted to a message with an emoji (up to 100 users), or the totals for every emoji.", {
    server, channel: channelRef, message_id: z.string(), emoji: z.string().optional(),
  }, async ({ server: s, channel: ch, message_id, emoji }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    if (!emoji) {
      const m = await api("GET", `/channels/${c.id}/messages/${message_id}`);
      return { reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji.name, count: r.count })) };
    }
    const users = await api("GET", `/channels/${c.id}/messages/${message_id}/reactions/${await reactionEmoji(g, emoji)}?limit=100`);
    return { emoji, count: users.length, users: users.map((u) => u.global_name || u.username) };
  }, READ);

  tool("poll_results", "Results of a poll message: votes per answer, total, and whether it has ended.", {
    server, channel: channelRef, message_id: z.string(), voters: z.boolean().optional().describe("Also list who voted for each answer"),
  }, async ({ server: s, channel: ch, message_id, voters }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const m = await api("GET", `/channels/${c.id}/messages/${message_id}`);
    if (!m.poll) throw new DiscordError("That message has no poll.");
    const counts = Object.fromEntries((m.poll.results?.answer_counts || []).map((x) => [x.id, x.count]));
    const answers = [];
    for (const a of m.poll.answers) {
      const row = { answer: a.poll_media.text, votes: counts[a.answer_id] || 0 };
      if (voters) row.voters = (await api("GET", `/channels/${c.id}/polls/${message_id}/answers/${a.answer_id}?limit=100`)).users.map((u) => u.username);
      answers.push(row);
    }
    return { question: m.poll.question.text, total: answers.reduce((n, a) => n + a.votes, 0), ended: Boolean(m.poll.results?.is_finalized),
      expires: m.poll.expiry, answers };
  }, READ);

  // ------------------------------------------------------------------ members
  tool = t("members");

  tool("export_members", "Save the member list (name, id, roles, join date, bot or not) to a CSV file on this computer. Needs Server Members intent.", {
    server, file: z.string().optional().describe("Default: ~/.discord-mcp/exports/<server>-members.csv"),
  }, async ({ server: s, file }) => {
    const g = await guildId(s);
    const [info, roles] = await Promise.all([api("GET", `/guilds/${g}`), api("GET", `/guilds/${g}/roles`)]);
    const names = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    const all = [];
    let after = "0";
    try {
      for (;;) {
        const page = await api("GET", `/guilds/${g}/members?limit=1000&after=${after}`);
        all.push(...page);
        if (page.length < 1000) break;
        after = page.at(-1).user.id;
      }
    } catch (e) {
      throw new DiscordError(`${e.message}\nTurn on Server Members intent (Developer Portal > Bot) and try again.`);
    }
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["username,display_name,id,bot,joined,roles", ...all.map((m) => [m.user.username, m.nick || m.user.global_name, m.user.id,
      m.user.bot ? "yes" : "no", m.joined_at?.slice(0, 10), m.roles.map((r) => names[r]).join("; ")].map(q).join(","))].join("\n");
    const path = file || join(homedir(), ".discord-mcp", "exports", `${info.name.replace(/[^\p{L}\p{N}_-]+/gu, "_")}-members.csv`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, csv);
    return { saved_to: path, members: all.length };
  }, READ);

}
