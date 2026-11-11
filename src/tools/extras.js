import { z } from "zod";
import {
  api, guildId, channel, role, imageData, loadFile, defined, server, channelRef, reason, Embed, toEmbed, FileInput,
  loadFiles, attachmentsMeta, LinkButton, linkButtons, DiscordError,
} from "../discord.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const EVENT_STATUS = { scheduled: 1, active: 2, completed: 3, canceled: 4 };

export default function register(t) {
  let tool = t("expressions");
  // ------------------------------------------------------------------ emojis and stickers

  tool("list_emojis", "List the server's custom emojis and stickers.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const [emojis, stickers] = await Promise.all([api("GET", `/guilds/${g}/emojis`), api("GET", `/guilds/${g}/stickers`)]);
    return {
      emojis: emojis.map((e) => ({ name: e.name, id: e.id, use_as: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>` })),
      stickers: stickers.map((st) => ({ name: st.name, id: st.id, tags: st.tags })),
    };
  }, READ);

  tool("create_emoji", "Add a custom emoji from an image (path or URL, max 256 KB; PNG, JPG, GIF or WebP).", {
    server, name: z.string().regex(/^\w{2,32}$/), image: z.string(), roles: z.array(z.string()).optional().describe("Only these roles can use it"), reason,
  }, async ({ server: s, name, image, roles, reason: r }) => {
    const g = await guildId(s);
    const roleIds = roles ? await Promise.all(roles.map(async (x) => (await role(g, x)).id)) : undefined;
    const e = await api("POST", `/guilds/${g}/emojis`, defined({ name, image: await imageData(image), roles: roleIds }), { reason: r });
    return { created: e.name, use_as: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>` };
  });

  tool("delete_emoji", "Delete a custom emoji.", { server, emoji: z.string().describe("Name or id"), reason }, async ({ server: s, emoji, reason: r }) => {
    const g = await guildId(s);
    const list = await api("GET", `/guilds/${g}/emojis`);
    const e = list.find((x) => x.id === emoji || x.name.toLowerCase() === emoji.replace(/:/g, "").toLowerCase());
    if (!e) throw new DiscordError(`No emoji "${emoji}".`);
    await api("DELETE", `/guilds/${g}/emojis/${e.id}`, undefined, { reason: r });
    return { deleted: e.name };
  }, DESTRUCTIVE);

  tool("create_sticker", "Add a sticker from a PNG, APNG, GIF or Lottie JSON file (max 512 KB, 320x320).", {
    server, name: z.string(), file: z.string().describe("Path or URL"), emoji_tag: z.string().describe("A related unicode emoji"),
    description: z.string().optional(),
  }, async ({ server: s, name, file, emoji_tag, description }) => {
    const g = await guildId(s);
    const f = await loadFile(file);
    const form = new FormData();
    form.append("name", name);
    form.append("tags", emoji_tag);
    form.append("description", description || "");
    form.append("file", new Blob([f.data], { type: f.type }), f.name);
    const data = await api("POST", `/guilds/${g}/stickers`, undefined, { form });
    return { created: data.name, id: data.id };
  });

  tool("delete_sticker", "Delete a sticker.", { server, sticker: z.string().describe("Name or id") }, async ({ server: s, sticker }) => {
    const g = await guildId(s);
    const list = await api("GET", `/guilds/${g}/stickers`);
    const st = list.find((x) => x.id === sticker || x.name.toLowerCase() === sticker.toLowerCase());
    if (!st) throw new DiscordError(`No sticker "${sticker}".`);
    await api("DELETE", `/guilds/${g}/stickers/${st.id}`);
    return { deleted: st.name };
  }, DESTRUCTIVE);

  // ------------------------------------------------------------------ webhooks
  tool = t("automation");

  tool("list_webhooks", "List the webhooks of the server or of one channel.", {
    server, channel: z.string().optional(),
  }, async ({ server: s, channel: ch }) => {
    const g = await guildId(s);
    const list = ch ? await api("GET", `/channels/${(await channel(g, ch)).id}/webhooks`) : await api("GET", `/guilds/${g}/webhooks`);
    return list.map((w) => defined({ id: w.id, name: w.name, channel: w.channel_id, by: w.user?.username, type: w.type }));
  }, READ);

  tool("create_webhook", "Create a webhook in a channel. Messages sent through it can use any name and avatar.", {
    server, channel: channelRef, name: z.string(), avatar: z.string().optional().describe("Image path or URL"), reason,
  }, async ({ server: s, channel: ch, name, avatar, reason: r }) => {
    const g = await guildId(s);
    const c = await channel(g, ch);
    const w = await api("POST", `/channels/${c.id}/webhooks`, defined({ name, avatar: avatar ? await imageData(avatar) : undefined }), { reason: r });
    return { created: w.name, id: w.id, channel: c.name, note: "The webhook URL is secret; it was not printed." };
  });

  tool("delete_webhook", "Delete a webhook.", { webhook_id: z.string(), reason }, async ({ webhook_id, reason: r }) => {
    await api("DELETE", `/webhooks/${webhook_id}`, undefined, { reason: r });
    return { deleted: webhook_id };
  }, DESTRUCTIVE);

  tool("send_webhook_message",
    "Send a message through a webhook with a custom name and avatar (e.g. posting as the server or a project). Creates a webhook in the channel if none of the bot's exists.", {
      server, channel: channelRef,
      username: z.string().optional().describe("Name shown on the message"),
      avatar_url: z.string().optional().describe("Avatar image URL shown on the message"),
      content: z.string().optional(), embeds: z.array(Embed).max(10).optional(), files: z.array(FileInput).max(10).optional(),
      link_buttons: z.array(LinkButton).optional(),
      thread: z.string().optional().describe("Thread or forum post id to send into"),
      thread_name: z.string().optional().describe("Forum channels: create a new post with this title"),
    }, async (a) => {
      if (!a.content && !a.embeds?.length && !a.files?.length) throw new DiscordError("Give content, embeds or files.");
      const g = await guildId(a.server);
      const c = await channel(g, a.channel);
      const me = await api("GET", "/users/@me");
      const hooks = await api("GET", `/channels/${c.id}/webhooks`);
      let hook = hooks.find((w) => w.user?.id === me.id && w.token);
      if (!hook) hook = await api("POST", `/channels/${c.id}/webhooks`, { name: "MCP Webhook" });
      const files = await loadFiles(a.files);
      const q = new URLSearchParams(defined({ wait: "true", thread_id: a.thread, with_components: a.link_buttons ? "true" : undefined }));
      const msg = await api("POST", `/webhooks/${hook.id}/${hook.token}?${q}`, defined({
        content: a.content, username: a.username, avatar_url: a.avatar_url, embeds: a.embeds?.map(toEmbed),
        components: linkButtons(a.link_buttons), attachments: attachmentsMeta(files), thread_name: a.thread_name,
        allowed_mentions: { parse: [] },
      }), { files });
      return { sent: true, message_id: msg.id, webhook_id: hook.id, link: `https://discord.com/channels/${g}/${msg.channel_id}/${msg.id}` };
    });

  tool("edit_webhook_message", "Edit a message that was sent through one of the bot's webhooks.", {
    server, channel: channelRef, message_id: z.string(), content: z.string().optional(), embeds: z.array(Embed).max(10).optional(),
    files: z.array(FileInput).max(10).optional(), thread: z.string().optional(),
  }, async (a) => {
    const g = await guildId(a.server);
    const c = await channel(g, a.channel);
    const me = await api("GET", "/users/@me");
    const hooks = await api("GET", `/channels/${c.id}/webhooks`);
    const files = await loadFiles(a.files);
    const q = a.thread ? `?thread_id=${a.thread}` : "";
    for (const hook of hooks.filter((w) => w.user?.id === me.id && w.token)) {
      try {
        await api("PATCH", `/webhooks/${hook.id}/${hook.token}/messages/${a.message_id}${q}`, defined({
          content: a.content, embeds: a.embeds?.map(toEmbed), attachments: a.files ? attachmentsMeta(files) || [] : undefined,
        }), { files });
        return { edited: a.message_id };
      } catch (e) {
        if (!String(e.message).includes("10008") && !String(e.message).includes("404")) throw e;
      }
    }
    throw new DiscordError("That message was not sent by one of the bot's webhooks in this channel.");
  });

  // ------------------------------------------------------------------ scheduled events

  tool("list_events", "List scheduled events.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const list = await api("GET", `/guilds/${g}/scheduled-events?with_user_count=true`);
    return list.map((e) => defined({ id: e.id, name: e.name, start: e.scheduled_start_time, end: e.scheduled_end_time,
      where: e.entity_metadata?.location || e.channel_id, status: Object.keys(EVENT_STATUS)[e.status - 1], interested: e.user_count }));
  }, READ);

  tool("create_event", "Create a scheduled event in a voice/stage channel or at an external place or link.", {
    server, name: z.string(), start: z.string().describe("ISO date-time, e.g. 2026-12-01T20:00:00Z"),
    end: z.string().optional().describe("Required for external events"),
    channel: z.string().optional().describe("Voice or stage channel"),
    location: z.string().optional().describe("External place or link (used when no channel)"),
    description: z.string().optional(), image: z.string().optional().describe("Cover image path or URL"),
  }, async (a) => {
    const g = await guildId(a.server);
    let body;
    if (a.channel) {
      const c = await channel(g, a.channel, [2, 13]);
      body = { channel_id: c.id, entity_type: c.type === 13 ? 1 : 2 };
    } else {
      if (!a.location || !a.end) throw new DiscordError("External events need location and end.");
      body = { entity_type: 3, entity_metadata: { location: a.location } };
    }
    const e = await api("POST", `/guilds/${g}/scheduled-events`, defined({
      ...body, name: a.name, privacy_level: 2, scheduled_start_time: a.start, scheduled_end_time: a.end,
      description: a.description, image: a.image ? await imageData(a.image) : undefined,
    }));
    return { created: e.name, id: e.id, link: `https://discord.com/events/${g}/${e.id}` };
  });

  tool("edit_event", "Change, start, end or cancel a scheduled event.", {
    server, event_id: z.string(), name: z.string().optional(), start: z.string().optional(), end: z.string().optional(),
    description: z.string().optional(), location: z.string().optional(),
    status: z.enum(["active", "completed", "canceled"]).optional(),
  }, async (a) => {
    const g = await guildId(a.server);
    const e = await api("PATCH", `/guilds/${g}/scheduled-events/${a.event_id}`, defined({
      name: a.name, scheduled_start_time: a.start, scheduled_end_time: a.end, description: a.description,
      entity_metadata: a.location ? { location: a.location } : undefined, status: a.status && EVENT_STATUS[a.status],
    }));
    return { updated: e.name };
  });

  tool("delete_event", "Delete a scheduled event.", { server, event_id: z.string() }, async ({ server: s, event_id }) => {
    const g = await guildId(s);
    await api("DELETE", `/guilds/${g}/scheduled-events/${event_id}`);
    return { deleted: event_id };
  }, DESTRUCTIVE);

  // ------------------------------------------------------------------ automod

  tool("list_automod_rules", "List AutoMod rules.", { server }, async ({ server: s }) => {
    const g = await guildId(s);
    const rules = await api("GET", `/guilds/${g}/auto-moderation/rules`);
    return rules.map((r) => defined({ id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger_type,
      keywords: r.trigger_metadata?.keyword_filter, actions: r.actions.map((x) => x.type) }));
  }, READ);

  tool("create_automod_rule", "Create an AutoMod rule that blocks messages with given words/patterns, spam, or too many mentions.", {
    server, name: z.string(),
    trigger: z.enum(["keywords", "spam", "mention_spam", "preset"]).default("keywords"),
    keywords: z.array(z.string()).optional().describe("Words; * works as wildcard, e.g. *badword*"),
    regex: z.array(z.string()).optional(), allow: z.array(z.string()).optional().describe("Words that never trigger"),
    presets: z.array(z.enum(["profanity", "sexual_content", "slurs"])).optional(),
    mention_limit: z.number().int().min(1).max(50).optional(),
    block_message: z.string().optional().describe("Text shown to the member when blocked"),
    alert_channel: z.string().optional().describe("Also post an alert here"),
    timeout_minutes: z.number().int().min(1).max(40320).optional().describe("Also time the member out (keywords/mentions only)"),
    exempt_roles: z.array(z.string()).optional(), exempt_channels: z.array(z.string()).optional(),
  }, async (a) => {
    const g = await guildId(a.server);
    const TRIGGER = { keywords: 1, spam: 3, preset: 4, mention_spam: 5 };
    const PRESET = { profanity: 1, sexual_content: 2, slurs: 3 };
    const actions = [{ type: 1, metadata: defined({ custom_message: a.block_message }) }];
    if (a.alert_channel) actions.push({ type: 2, metadata: { channel_id: (await channel(g, a.alert_channel)).id } });
    if (a.timeout_minutes) actions.push({ type: 3, metadata: { duration_seconds: a.timeout_minutes * 60 } });
    const rule = await api("POST", `/guilds/${g}/auto-moderation/rules`, defined({
      name: a.name, event_type: 1, trigger_type: TRIGGER[a.trigger], enabled: true, actions,
      trigger_metadata: defined({ keyword_filter: a.keywords, regex_patterns: a.regex, allow_list: a.allow,
        presets: a.presets?.map((p) => PRESET[p]), mention_total_limit: a.mention_limit }),
      exempt_roles: a.exempt_roles ? await Promise.all(a.exempt_roles.map(async (r) => (await role(g, r)).id)) : undefined,
      exempt_channels: a.exempt_channels ? await Promise.all(a.exempt_channels.map(async (c) => (await channel(g, c)).id)) : undefined,
    }));
    return { created: rule.name, id: rule.id };
  });

  tool("delete_automod_rule", "Delete an AutoMod rule.", { server, rule_id: z.string() }, async ({ server: s, rule_id }) => {
    const g = await guildId(s);
    await api("DELETE", `/guilds/${g}/auto-moderation/rules/${rule_id}`);
    return { deleted: rule_id };
  }, DESTRUCTIVE);

  // ------------------------------------------------------------------ anything else
  tool = t("api");

  tool("discord_api",
    "Call any Discord REST API endpoint directly (https://discord.com/developers/docs), for anything the other tools do not cover. Path starts with /, e.g. /guilds/{id}/onboarding. {guild} in the path is replaced with the server id.", {
      server, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string(),
      body: z.any().optional().describe("JSON body"), files: z.array(FileInput).optional(), reason,
    }, async ({ server: s, method, path, body, files, reason: r }) => {
      let p = path;
      if (p.includes("{guild}")) p = p.replaceAll("{guild}", await guildId(s));
      if (!p.startsWith("/")) p = "/" + p;
      return (await api(method, p, body, { files: await loadFiles(files), reason: r })) ?? "done";
    });
}
