import { z } from "zod";
import {
  api, guildId, channel, category, role, member, bits, defined, server, channelRef, reason, CHANNEL_TYPES, TYPE_NAMES,
  PERMISSION_LIST, Embed, toEmbed, FileInput, loadFiles, attachmentsMeta, LinkButton, linkButtons, messageLink,
  DiscordError, hasNews,
} from "../discord.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const Tag = z.object({
  name: z.string(),
  emoji: z.string().optional().describe("Unicode emoji"),
  moderated: z.boolean().optional().describe("Only moderators can apply it"),
});

const Override = z.object({
  target: z.string().describe('Role name/id, "@everyone", or a member (prefix with "user:" e.g. "user:alice")'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});

export async function overwrite(g, o) {
  if (o.target.startsWith("user:")) {
    const m = await member(g, o.target.slice(5));
    return { id: m.user.id, type: 1, allow: bits(o.allow), deny: bits(o.deny) };
  }
  const r = await role(g, o.target);
  return { id: r.id, type: 0, allow: bits(o.allow), deny: bits(o.deny) };
}

export function tagList(existing, wanted) {
  const byName = new Map((existing || []).map((t) => [t.name.toLowerCase(), t]));
  return wanted.map((t) => {
    const old = byName.get(t.name.toLowerCase());
    return defined({
      id: old?.id, name: t.name,
      emoji_name: t.emoji !== undefined ? t.emoji : old?.emoji_name ?? undefined,
      emoji_id: t.emoji !== undefined ? undefined : old?.emoji_id ?? undefined,
      moderated: t.moderated ?? old?.moderated,
    });
  });
}

const LAYOUT = { list: 1, gallery: 2 };
const SORT = { latest_activity: 0, creation_date: 1 };

export default function register(t) {
  const tool = t("channels");
  tool("create_category", "Create a channel category.", {
    server, name: z.string(), position: z.number().int().optional(),
    overrides: z.array(Override).optional().describe("Permission overrides, e.g. hide it from @everyone"),
    reason,
  }, async ({ server: s, name, position, overrides, reason: r }) => {
    const g = await guildId(s);
    const permission_overwrites = overrides ? await Promise.all(overrides.map((o) => overwrite(g, o))) : undefined;
    const c = await api("POST", `/guilds/${g}/channels`, defined({ name, type: 4, position, permission_overwrites }), { reason: r });
    return { created: c.name, id: c.id };
  });

  tool("create_channel",
    `Create a text, announcement, forum, media, voice or stage channel. Inside a category it takes the category's permissions unless overrides are given. Permission names: ${PERMISSION_LIST}.`, {
      server, name: z.string(),
      type: z.enum(["text", "announcement", "forum", "media", "voice", "stage"]).default("text"),
      category: z.string().optional().describe("Category name or id"),
      topic: z.string().optional().describe("Topic, or the guidelines of a forum"),
      position: z.number().int().optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      nsfw: z.boolean().optional(),
      overrides: z.array(Override).optional(),
      private: z.boolean().optional().describe("Hide from @everyone (add overrides to let roles see it)"),
      bitrate: z.number().int().optional().describe("Voice: bits per second, e.g. 64000"),
      user_limit: z.number().int().min(0).max(99).optional().describe("Voice: 0 = no limit"),
      forum_tags: z.array(Tag).optional(),
      forum_default_reaction: z.string().optional().describe("Forum: unicode emoji added under every post"),
      forum_layout: z.enum(["list", "gallery"]).optional(),
      forum_sort: z.enum(["latest_activity", "creation_date"]).optional(),
      reason,
    }, async (a) => {
      const g = await guildId(a.server);
      let type = a.type, note;
      if (type === "announcement" && !hasNews(await api("GET", `/guilds/${g}`))) {
        type = "text";
        note = "Announcement channels need Community to be turned on (edit_server community: true), so this was made as a normal text channel. After turning Community on, it can be switched to an announcement channel in its settings.";
      }
      const parent = a.category ? await category(g, a.category) : undefined;
      let permission_overwrites = a.overrides ? await Promise.all(a.overrides.map((o) => overwrite(g, o))) : undefined;
      if (a.private) {
        permission_overwrites = [...(permission_overwrites || parent?.permission_overwrites || []).filter((o) => o.id !== g),
          { id: g, type: 0, allow: "0", deny: bits(["ViewChannel"]) }];
      }
      const c = await api("POST", `/guilds/${g}/channels`, defined({
        name: a.name, type: CHANNEL_TYPES[type], parent_id: parent?.id, topic: a.topic, position: a.position,
        rate_limit_per_user: a.slowmode_seconds, nsfw: a.nsfw, permission_overwrites, bitrate: a.bitrate,
        user_limit: a.user_limit, available_tags: a.forum_tags ? tagList([], a.forum_tags) : undefined,
        default_reaction_emoji: a.forum_default_reaction ? { emoji_name: a.forum_default_reaction } : undefined,
        default_forum_layout: a.forum_layout && LAYOUT[a.forum_layout], default_sort_order: a.forum_sort && SORT[a.forum_sort],
      }), { reason: a.reason });
      return defined({ created: c.name, type, id: c.id, category: parent?.name, note });
    });

  tool("edit_channel", "Change a channel, category or thread: name, topic, category, position, slowmode, NSFW, voice settings, forum settings.", {
    server, channel: channelRef,
    name: z.string().optional(), topic: z.string().optional(),
    category: z.string().optional().describe('Category name/id, or "none" to take it out of its category'),
    sync_permissions: z.boolean().optional().describe("With category: copy the category's permissions"),
    position: z.number().int().optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    nsfw: z.boolean().optional(),
    bitrate: z.number().int().optional(), user_limit: z.number().int().min(0).max(99).optional(),
    forum_default_reaction: z.string().optional().describe('Unicode emoji, or "none"'),
    forum_layout: z.enum(["list", "gallery"]).optional(),
    forum_sort: z.enum(["latest_activity", "creation_date"]).optional(),
    reason,
  }, async (a) => {
    const g = await guildId(a.server);
    const c = await channel(g, a.channel);
    const body = defined({
      name: a.name, topic: a.topic, position: a.position, rate_limit_per_user: a.slowmode_seconds, nsfw: a.nsfw,
      bitrate: a.bitrate, user_limit: a.user_limit,
      default_reaction_emoji: a.forum_default_reaction === undefined ? undefined
        : a.forum_default_reaction === "none" ? null : { emoji_name: a.forum_default_reaction },
      default_forum_layout: a.forum_layout && LAYOUT[a.forum_layout], default_sort_order: a.forum_sort && SORT[a.forum_sort],
    });
    if (a.category !== undefined) body.parent_id = a.category === "none" ? null : (await category(g, a.category)).id;
    if (a.sync_permissions !== undefined) body.lock_permissions = a.sync_permissions;
    const out = await api("PATCH", `/channels/${c.id}`, body, { reason: a.reason });
    return { updated: out.name, id: out.id, changed: Object.keys(body) };
  });

  tool("delete_channel", "Delete a channel, category or thread. Cannot be undone. Channels inside a deleted category are kept, without category.", {
    server, channel: channelRef, reason,
  }, async ({ server: s, channel: ch, reason: r }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    await api("DELETE", `/channels/${c.id}`, undefined, { reason: r });
    return { deleted: c.name, type: TYPE_NAMES[c.type] };
  }, DESTRUCTIVE);

  tool("set_permissions",
    `Set what a role, @everyone or a member can do in a channel or category (allow, deny, or remove the override). Permission names: ${PERMISSION_LIST}.`, {
      server, channel: channelRef,
      target: z.string().describe('Role name/id, "@everyone", or "user:<member>"'),
      allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]),
      merge: z.boolean().default(true).describe("Keep the override's other permissions; false replaces it"),
      remove: z.boolean().optional().describe("Delete this override completely"),
      reason,
    }, async (a) => {
      const g = await guildId(a.server);
      const c = await channel(g, a.channel);
      const o = await overwrite(g, { target: a.target, allow: a.allow, deny: a.deny });
      if (a.remove) {
        await api("DELETE", `/channels/${c.id}/permissions/${o.id}`, undefined, { reason: a.reason });
        return { channel: c.name, target: a.target, override: "removed" };
      }
      let allow = BigInt(o.allow);
      let deny = BigInt(o.deny);
      if (a.merge) {
        const old = (c.permission_overwrites || []).find((x) => x.id === o.id);
        if (old) {
          allow = (BigInt(old.allow) & ~deny) | allow;
          deny = (BigInt(old.deny) & ~allow) | deny;
        }
      }
      await api("PUT", `/channels/${c.id}/permissions/${o.id}`, { type: o.type, allow: allow.toString(), deny: deny.toString() }, { reason: a.reason });
      return { channel: c.name, target: a.target, allow: a.allow, deny: a.deny };
    });

  tool("reorder_channels",
    "Put channels in an order. Give the full order of categories (top to bottom), or the channels of one category in order, or both.", {
      server,
      categories: z.array(z.string()).optional().describe("Every category, top to bottom"),
      channels: z.array(z.string()).optional().describe("Channels in the order they should appear"),
      move_to_category: z.string().optional().describe("Also move the listed channels into this category"),
    }, async ({ server: s, categories, channels, move_to_category }) => {
      const g = await guildId(s);
      const updates = [];
      if (categories) {
        for (const [i, ref] of categories.entries()) updates.push({ id: (await category(g, ref)).id, position: i });
      }
      if (channels) {
        const parent = move_to_category ? (await category(g, move_to_category)).id : undefined;
        for (const [i, ref] of channels.entries()) {
          updates.push(defined({ id: (await channel(g, ref)).id, position: i, parent_id: parent }));
        }
      }
      if (!updates.length) throw new DiscordError("Give categories or channels.");
      await api("PATCH", `/guilds/${g}/channels`, updates);
      return { reordered: updates.length };
    });

  tool("clone_channel", "Make a copy of a channel with the same settings and permissions (no messages).", {
    server, channel: channelRef, name: z.string().optional(),
  }, async ({ server: s, channel: ch, name }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const copy = await api("POST", `/guilds/${g}/channels`, defined({
      name: name || c.name, type: c.type, topic: c.topic, parent_id: c.parent_id, nsfw: c.nsfw, bitrate: c.bitrate,
      user_limit: c.user_limit, rate_limit_per_user: c.rate_limit_per_user, permission_overwrites: c.permission_overwrites,
      available_tags: c.available_tags?.map(({ id, ...t }) => t), default_reaction_emoji: c.default_reaction_emoji,
      position: c.position + 1,
    }));
    return { created: copy.name, id: copy.id };
  });

  // ------------------------------------------------------------------ forums

  tool("set_forum_tags", "Replace the whole tag list of a forum or media channel. Existing tags keep their emoji unless a new one is given.", {
    server, forum: z.string(), tags: z.array(Tag),
  }, async ({ server: s, forum, tags }) => {
    const g = await guildId(s);
    const c = await channel(g, forum, [15, 16]);
    const out = await api("PATCH", `/channels/${c.id}`, { available_tags: tagList(c.available_tags, tags) });
    return { forum: out.name, tags: out.available_tags.map((t) => (t.emoji_name ? `${t.emoji_name} ${t.name}` : t.name)) };
  });

  tool("add_forum_tags", "Add tags to a forum or media channel (or update the emoji of existing ones), keeping all other tags.", {
    server, forum: z.string(), tags: z.array(Tag),
  }, async ({ server: s, forum, tags }) => {
    const g = await guildId(s);
    const c = await channel(g, forum, [15, 16]);
    const existing = c.available_tags || [];
    const wanted = existing.map((t) => tags.find((n) => n.name.toLowerCase() === t.name.toLowerCase()) || { name: t.name });
    for (const t of tags) if (!existing.some((e) => e.name.toLowerCase() === t.name.toLowerCase())) wanted.push(t);
    const out = await api("PATCH", `/channels/${c.id}`, { available_tags: tagList(existing, wanted) });
    return { forum: out.name, tags: out.available_tags.map((t) => (t.emoji_name ? `${t.emoji_name} ${t.name}` : t.name)) };
  });

  tool("create_forum_post", "Create a post in a forum or media channel, with tags, embeds, files and link buttons.", {
    server, forum: z.string(), title: z.string(),
    content: z.string().optional(), embeds: z.array(Embed).optional(), files: z.array(FileInput).optional(),
    link_buttons: z.array(LinkButton).optional(),
    tags: z.array(z.string()).optional().describe("Tag names that exist in the forum"),
    slowmode_seconds: z.number().int().optional(),
  }, async (a) => {
    const g = await guildId(a.server);
    const c = await channel(g, a.forum, [15, 16]);
    const applied_tags = (a.tags || []).map((t) => {
      const found = (c.available_tags || []).find((x) => x.name.toLowerCase() === t.toLowerCase());
      if (!found) throw new DiscordError(`The forum has no tag "${t}". Tags: ${(c.available_tags || []).map((x) => x.name).join(", ")}`);
      return found.id;
    });
    if (!a.content && !a.embeds?.length && !a.files?.length) throw new DiscordError("Give content, embeds or files.");
    const files = await loadFiles(a.files);
    const th = await api("POST", `/channels/${c.id}/threads`, defined({
      name: a.title, applied_tags, rate_limit_per_user: a.slowmode_seconds,
      message: defined({ content: a.content, embeds: a.embeds?.map(toEmbed), components: linkButtons(a.link_buttons),
        attachments: attachmentsMeta(files), allowed_mentions: { parse: [] } }),
    }), { files });
    return { created: th.name, thread_id: th.id, link: `https://discord.com/channels/${g}/${th.id}` };
  });

  // ------------------------------------------------------------------ threads

  tool("create_thread", "Start a thread in a text or announcement channel, from a message or on its own.", {
    server, channel: channelRef, name: z.string(),
    message_id: z.string().optional().describe("Start the thread from this message"),
    private: z.boolean().optional().describe("Private thread (text channels only)"),
    auto_archive_minutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional(),
  }, async ({ server: s, channel: ch, name, message_id, private: priv, auto_archive_minutes }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const path = message_id ? `/channels/${c.id}/messages/${message_id}/threads` : `/channels/${c.id}/threads`;
    const th = await api("POST", path, defined({
      name, auto_archive_duration: auto_archive_minutes,
      type: message_id ? undefined : priv ? 12 : c.type === 5 ? 10 : 11,
    }));
    return { created: th.name, thread_id: th.id, link: `https://discord.com/channels/${g}/${th.id}` };
  });

  tool("list_threads", "List the active threads and forum posts of a server, or the archived ones of a channel.", {
    server, channel: z.string().optional().describe("Only this channel; needed for archived"),
    archived: z.boolean().optional(),
  }, async ({ server: s, channel: ch, archived }) => {
    const g = await guildId(s);
    let threads;
    if (archived) {
      if (!ch) throw new DiscordError("Name the channel to list archived threads.");
      const c = await channel(g, ch);
      threads = (await api("GET", `/channels/${c.id}/threads/archived/public?limit=50`)).threads;
    } else {
      threads = (await api("GET", `/guilds/${g}/threads/active`)).threads;
      if (ch) {
        const c = await channel(g, ch);
        threads = threads.filter((t) => t.parent_id === c.id);
      }
    }
    return threads.map((t) => defined({ id: t.id, name: t.name, parent: t.parent_id, messages: t.message_count,
      archived: t.thread_metadata?.archived || undefined, locked: t.thread_metadata?.locked || undefined,
      tags: t.applied_tags?.length ? t.applied_tags : undefined }));
  }, READ);

  tool("edit_thread", "Rename, archive, lock, pin (forum posts) or change the tags of a thread or forum post.", {
    server, thread: z.string().describe("Thread name, id or link"),
    name: z.string().optional(), archived: z.boolean().optional(), locked: z.boolean().optional(),
    pinned: z.boolean().optional().describe("Pin the post at the top of its forum"),
    tags: z.array(z.string()).optional().describe("Replace the post's tags (forum tag names)"),
    reason,
  }, async (a) => {
    const g = await guildId(a.server);
    const t = await channel(g, a.thread, [10, 11, 12]);
    let applied_tags;
    if (a.tags) {
      const parent = await api("GET", `/channels/${t.parent_id}`);
      applied_tags = a.tags.map((n) => {
        const found = (parent.available_tags || []).find((x) => x.name.toLowerCase() === n.toLowerCase());
        if (!found) throw new DiscordError(`No tag "${n}" in ${parent.name}.`);
        return found.id;
      });
    }
    const flags = a.pinned === undefined ? undefined : a.pinned ? (t.flags | 2) : (t.flags & ~2);
    const out = await api("PATCH", `/channels/${t.id}`, defined({ name: a.name, archived: a.archived, locked: a.locked, applied_tags, flags }), { reason: a.reason });
    return { updated: out.name, id: out.id };
  });

  tool("follow_announcement_channel", "Make an announcement channel's published posts appear in another channel (also across servers).", {
    server, announcement_channel: z.string(), target_channel: z.string().describe("Channel id (can be in another server the bot is in)"),
  }, async ({ server: s, announcement_channel, target_channel }) => {
    const g = await guildId(s);
    const src = await channel(g, announcement_channel, [5]);
    const target = /^\d{15,}$/.test(target_channel) ? target_channel : (await channel(g, target_channel)).id;
    const out = await api("POST", `/channels/${src.id}/followers`, { webhook_channel_id: target });
    return { following: src.name, into_channel: target, webhook: out.webhook_id };
  });
}
