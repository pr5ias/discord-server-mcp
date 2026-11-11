import { z } from "zod";
import {
  api, guildId, channel, role, member, reactionEmoji, defined, server, channelRef, reason, Embed, toEmbed, FileInput,
  loadFiles, attachmentsMeta, LinkButton, linkButtons, messageLink, DiscordError,
} from "../discord.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const Poll = z.object({
  question: z.string(),
  answers: z.array(z.string()).min(1).max(10),
  duration_hours: z.number().int().min(1).max(768).default(24),
  multiple_choice: z.boolean().optional(),
});

/** Builds content + allowed_mentions so only the pings that were asked for actually notify. */
async function mentions(g, { content, ping_roles, ping_users, ping_everyone }) {
  const roles = [];
  const users = [];
  const prefix = [];
  for (const r of ping_roles || []) {
    const found = await role(g, r);
    if (found.id === g) {
      prefix.push("@everyone");
      ping_everyone = true;
    } else {
      roles.push(found.id);
      prefix.push(`<@&${found.id}>`);
    }
  }
  for (const u of ping_users || []) {
    const m = await member(g, u);
    users.push(m.user.id);
    prefix.push(`<@${m.user.id}>`);
  }
  if (ping_everyone && !prefix.includes("@everyone")) prefix.unshift("@everyone");
  return {
    content: [prefix.join(" "), content].filter(Boolean).join("\n") || undefined,
    allowed_mentions: { parse: ping_everyone ? ["everyone"] : [], roles, users, replied_user: false },
  };
}

function summary(m) {
  return defined({
    id: m.id, author: m.author?.global_name || m.author?.username, bot: m.author?.bot || undefined, time: m.timestamp,
    edited: m.edited_timestamp || undefined, content: m.content || undefined,
    embeds: m.embeds?.length ? m.embeds.map((e) => defined({ title: e.title, description: e.description?.slice(0, 300),
      image: e.image?.url, fields: e.fields?.map((f) => f.name) })) : undefined,
    files: m.attachments?.length ? m.attachments.map((a) => a.url) : undefined,
    reactions: m.reactions?.length ? m.reactions.map((r) => `${r.emoji.name} ${r.count}`) : undefined,
    reply_to: m.message_reference?.message_id, pinned: m.pinned || undefined,
    thread: m.thread ? m.thread.id : undefined,
  });
}

export default function register(t) {
  const tool = t("messages");
  tool("read_messages", "Read messages of a channel or thread (newest last). Use before/after to page.", {
    server, channel: channelRef, limit: z.number().int().min(1).max(100).default(25),
    before: z.string().optional().describe("Message id"), after: z.string().optional().describe("Message id"),
  }, async ({ server: s, channel: ch, limit, before, after }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const q = new URLSearchParams(defined({ limit: String(limit), before, after }));
    const msgs = await api("GET", `/channels/${c.id}/messages?${q}`);
    return { channel: c.name, messages: msgs.reverse().map(summary) };
  }, READ);

  tool("get_message", "Read one message in full (content, embeds, files, reactions).", {
    server, channel: channelRef, message_id: z.string(),
  }, async ({ server: s, channel: ch, message_id }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    return api("GET", `/channels/${c.id}/messages/${message_id}`);
  }, READ);

  tool("list_pins", "List the pinned messages of a channel.", { server, channel: channelRef }, async ({ server: s, channel: ch }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    return (await api("GET", `/channels/${c.id}/pins`)).map(summary);
  }, READ);

  tool("send_message",
    'Send a message to a channel or thread: text, embeds, files/images (local paths or URLs; show one inside an embed with image "attachment://name.png"), link buttons, a poll, a reply, and pings. Nobody is pinged unless listed in ping_roles/ping_users/ping_everyone.', {
      server, channel: channelRef,
      content: z.string().optional(), embeds: z.array(Embed).max(10).optional(), files: z.array(FileInput).max(10).optional(),
      link_buttons: z.array(LinkButton).max(25).optional(), poll: Poll.optional(),
      reply_to: z.string().optional().describe("Message id to reply to"),
      ping_roles: z.array(z.string()).optional().describe("Roles to ping (name or id)"),
      ping_users: z.array(z.string()).optional().describe("Members to ping"),
      ping_everyone: z.boolean().optional(),
      silent: z.boolean().optional().describe("Send without push notifications"),
      suppress_embeds: z.boolean().optional().describe("Hide link previews"),
      pin: z.boolean().optional(),
      publish: z.boolean().optional().describe("Announcement channels: send to following servers"),
    }, async (a) => {
      if (!a.content && !a.embeds?.length && !a.files?.length && !a.poll) throw new DiscordError("Give content, embeds, files or a poll.");
      const g = await guildId(a.server);
      const c = await channel(g, a.channel);
      const files = await loadFiles(a.files);
      const m = await mentions(g, a);
      const flags = (a.silent ? 4096 : 0) | (a.suppress_embeds ? 4 : 0);
      const msg = await api("POST", `/channels/${c.id}/messages`, defined({
        content: m.content, allowed_mentions: m.allowed_mentions, embeds: a.embeds?.map(toEmbed),
        components: linkButtons(a.link_buttons), attachments: attachmentsMeta(files), flags: flags || undefined,
        message_reference: a.reply_to ? { message_id: a.reply_to, fail_if_not_exists: false } : undefined,
        poll: a.poll ? { question: { text: a.poll.question }, answers: a.poll.answers.map((t) => ({ poll_media: { text: t } })),
          duration: a.poll.duration_hours, allow_multiselect: !!a.poll.multiple_choice } : undefined,
      }), { files });
      if (a.pin) await api("PUT", `/channels/${c.id}/messages/pins/${msg.id}`).catch(() => api("PUT", `/channels/${c.id}/pins/${msg.id}`));
      if (a.publish) {
        if (c.type !== 5) throw new DiscordError(`Sent, but ${c.name} is not an announcement channel, so it was not published.`);
        await api("POST", `/channels/${c.id}/messages/${msg.id}/crosspost`);
      }
      return { sent: true, channel: c.name, message_id: msg.id, link: messageLink(g, c.id, msg.id) };
    });

  tool("edit_message", "Edit a message the bot sent: text, embeds, link buttons, files (replaces the attachments when given).", {
    server, channel: channelRef, message_id: z.string(),
    content: z.string().optional().describe('New text ("" clears it)'), embeds: z.array(Embed).max(10).optional(),
    files: z.array(FileInput).max(10).optional(), link_buttons: z.array(LinkButton).optional(),
    suppress_embeds: z.boolean().optional(),
  }, async (a) => {
    const g = await guildId(a.server);
    const c = await channel(g, a.channel);
    const files = await loadFiles(a.files);
    const body = defined({
      content: a.content, embeds: a.embeds?.map(toEmbed), components: a.link_buttons ? linkButtons(a.link_buttons) || [] : undefined,
      attachments: a.files ? attachmentsMeta(files) || [] : undefined, flags: a.suppress_embeds === undefined ? undefined : a.suppress_embeds ? 4 : 0,
      allowed_mentions: { parse: [] },
    });
    await api("PATCH", `/channels/${c.id}/messages/${a.message_id}`, body, { files });
    return { edited: a.message_id, link: messageLink(g, c.id, a.message_id) };
  });

  tool("delete_messages", "Delete one or more messages (up to 100). Messages older than 14 days are deleted one by one.", {
    server, channel: channelRef, message_ids: z.array(z.string()).min(1).max(100), reason,
  }, async ({ server: s, channel: ch, message_ids, reason: r }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000 + 60000;
    const age = (id) => Number(BigInt(id) >> 22n) + 1420070400000;
    const recent = message_ids.filter((id) => age(id) > cutoff);
    const old = message_ids.filter((id) => age(id) <= cutoff);
    if (recent.length >= 2) await api("POST", `/channels/${c.id}/messages/bulk-delete`, { messages: recent }, { reason: r });
    else old.push(...recent);
    for (const id of old) await api("DELETE", `/channels/${c.id}/messages/${id}`, undefined, { reason: r });
    return { deleted: message_ids.length, channel: c.name };
  }, DESTRUCTIVE);

  tool("purge_messages", "Delete the latest N messages of a channel (optionally only from one member). Cannot be undone.", {
    server, channel: channelRef, count: z.number().int().min(1).max(100),
    from: z.string().optional().describe("Only messages from this member"), reason,
  }, async ({ server: s, channel: ch, count, from, reason: r }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    let msgs = await api("GET", `/channels/${c.id}/messages?limit=100`);
    if (from) {
      const m = await member(g, from);
      msgs = msgs.filter((x) => x.author.id === m.user.id);
    }
    const ids = msgs.slice(0, count).map((x) => x.id);
    if (!ids.length) return { deleted: 0 };
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000 + 60000;
    const age = (id) => Number(BigInt(id) >> 22n) + 1420070400000;
    const recent = ids.filter((id) => age(id) > cutoff);
    const old = ids.filter((id) => age(id) <= cutoff);
    if (recent.length >= 2) await api("POST", `/channels/${c.id}/messages/bulk-delete`, { messages: recent }, { reason: r });
    else old.push(...recent);
    for (const id of old) await api("DELETE", `/channels/${c.id}/messages/${id}`, undefined, { reason: r });
    return { deleted: ids.length, channel: c.name };
  }, DESTRUCTIVE);

  tool("pin_message", "Pin or unpin a message.", {
    server, channel: channelRef, message_id: z.string(), unpin: z.boolean().optional(),
  }, async ({ server: s, channel: ch, message_id, unpin }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const method = unpin ? "DELETE" : "PUT";
    await api(method, `/channels/${c.id}/messages/pins/${message_id}`).catch(() => api(method, `/channels/${c.id}/pins/${message_id}`));
    return { message_id, pinned: !unpin };
  });

  tool("publish_message", "Publish a message in an announcement channel to the servers that follow it.", {
    server, channel: channelRef, message_id: z.string(),
  }, async ({ server: s, channel: ch, message_id }) => {
    const g = await guildId(s);
    const c = await channel(g, ch, [5]);
    await api("POST", `/channels/${c.id}/messages/${message_id}/crosspost`);
    return { published: message_id };
  });

  tool("react", "Add reactions to a message, or remove them (the bot's own, someone's, one emoji for everyone, or all).", {
    server, channel: channelRef, message_id: z.string(),
    emojis: z.array(z.string()).optional().describe('Unicode emoji, <:name:id>, or a server emoji name'),
    remove: z.enum(["mine", "all", "emoji", "user"]).optional().describe("Remove instead: mine, all reactions, every reaction of these emojis, or a user's"),
    user: z.string().optional().describe('For remove "user"'),
  }, async ({ server: s, channel: ch, message_id, emojis, remove, user }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const base = `/channels/${c.id}/messages/${message_id}/reactions`;
    if (remove === "all") {
      await api("DELETE", base);
      return { removed: "all" };
    }
    if (!emojis?.length) throw new DiscordError("Give emojis.");
    for (const e of emojis) {
      const code = await reactionEmoji(g, e);
      if (!remove) await api("PUT", `${base}/${code}/@me`);
      else if (remove === "mine") await api("DELETE", `${base}/${code}/@me`);
      else if (remove === "emoji") await api("DELETE", `${base}/${code}`);
      else {
        if (!user) throw new DiscordError('Give "user".');
        const m = await member(g, user);
        await api("DELETE", `${base}/${code}/${m.user.id}`);
      }
    }
    return { message_id, emojis, action: remove ? `removed (${remove})` : "added" };
  });

  tool("end_poll", "Close a poll early.", { server, channel: channelRef, message_id: z.string() }, async ({ server: s, channel: ch, message_id }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    await api("POST", `/channels/${c.id}/polls/${message_id}/expire`);
    return { ended: message_id };
  });
}
