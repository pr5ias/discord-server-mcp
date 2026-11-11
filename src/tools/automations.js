// Tools to set up automations: role menus, welcome messages with auto-roles, and support tickets.
import { z } from "zod";
import { readFileSync } from "node:fs";
import { api, guildId, channel, category, role, member, me, defined, server, color, DiscordError, callContext, messageLink } from "../discord.js";
import { STAFF_COMMANDS, registerStaffCommands } from "../staff.js";
import { search } from "../modlog.js";
import { zoned, nextRun, armSchedules } from "../features.js";
import { automations, saveAutomations, newId, AUTOMATIONS_FILE, guildLocale } from "../automations.js";
import { text, LANGUAGES, TEXT_KEYS } from "../i18n.js";
import { status } from "../gateway.js";
import { config } from "../config.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const runningNote = () => (config.gateway === "off"
  ? "Live connection is off (DISCORD_GATEWAY=off): automations will not run until it is on."
  : "Works while this Discord tool is running (the Claude app open). To keep it working around the clock, run `discord-server-mcp run` on a computer or server that stays on.");

const Language = z.enum(LANGUAGES).default("auto").describe('Language of the texts members see: "auto" follows the server\'s language; "pt" = European Portuguese, "pt-BR" = Brazilian. Other languages: write them in texts');
const textsOf = (keys) => z.object(Object.fromEntries(keys.map((k) => [k, z.string().optional()]))).optional()
  .describe(`Replace any of these texts (placeholders in braces stay): ${keys.map((k) => `${k} ("${text(k)}")`).join(", ")}`);
const MENU_TEXTS = ["added", "removed", "menu_gone", "unknown_option", "role_error", "footer_buttons", "footer_reactions", "footer_unique"];
const TICKET_TEXTS = TEXT_KEYS.filter((k) => /^(ticket|close|claim|already_claimed|not_ticket|closing|tickets_closed|panel_|open_label)/.test(k));
const LOG_TEXTS = TEXT_KEYS.filter((k) => k.startsWith("log_"));
const STAFF_TEXTS = TEXT_KEYS.filter((k) => /^(cmd_|modlog_)/.test(k));
const LOG_EVENTS = ["messages", "members", "moderation", "server"];

/** Makes a channel visible only to these roles and the bot, if everyone can see it now. Returns true if changed. */
async function staffOnly(g, c, roleIds, botId) {
  const everyone = (c.permission_overwrites || []).find((o) => o.id === g);
  if (everyone && (BigInt(everyone.deny) & (1n << 10n))) return false;
  const view = String(1n << 10n);
  await api("PUT", `/channels/${c.id}/permissions/${g}`, { type: 0, allow: everyone?.allow || "0", deny: String(BigInt(everyone?.deny || 0) | (1n << 10n)) }, { reason: "Ticket log: staff only" });
  for (const r of roleIds) await api("PUT", `/channels/${c.id}/permissions/${r}`, { type: 0, allow: view, deny: "0" }, { reason: "Ticket log: staff only" });
  await api("PUT", `/channels/${c.id}/permissions/${botId}`, { type: 1, allow: String((1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n)), deny: "0" }, { reason: "Ticket log: staff only" });
  return true;
}

export default function register(t) {
  const tool = t("automation");

  tool("create_role_menu",
    "Post a message where members pick their own roles: buttons, a dropdown list (tidy for many roles, up to 25), or reactions. unique = only one role from the menu at a time (e.g. colours or regions). The bot's role must be above these roles.", {
      server, channel: z.string(),
      title: z.string(), description: z.string().optional(), color: z.union([z.string(), z.number()]).optional(),
      options: z.array(z.object({ role: z.string(), label: z.string().optional(), emoji: z.string().optional().describe("Unicode emoji"), description: z.string().optional() })).min(1).max(25),
      style: z.enum(["buttons", "dropdown", "reactions"]).default("buttons"),
      unique: z.boolean().default(false),
      placeholder: z.string().optional().describe("Dropdown: text shown before choosing"),
      language: Language, texts: textsOf([...MENU_TEXTS, "menu_placeholder", "menu_updated"]),
    }, async (a) => {
      const g = await guildId(a.server);
      const c = await channel(g, a.channel);
      const bot = await me();
      const locale = await guildLocale(g);
      const tx = (k) => text(k, { lang: a.language, locale, texts: a.texts });
      const opts = [];
      for (const o of a.options) {
        const r = await role(g, o.role);
        if (a.style === "reactions" && !o.emoji) throw new DiscordError(`Reaction menus need an emoji for every option (missing for ${r.name}).`);
        opts.push(defined({ role_id: r.id, label: o.label || r.name, emoji: o.emoji, description: o.description }));
      }
      const id = newId();
      const lines = opts.map((o) => `${o.emoji ? `${o.emoji} ` : ""}**${o.label}**${o.description ? ` — ${o.description}` : ""}`);
      const msg = await api("POST", `/channels/${c.id}/messages`, defined({
        embeds: [{ title: a.title, description: [a.description, "", ...lines].filter((x) => x !== undefined).join("\n").trim(), color: color(a.color) ?? 0x5865f2,
          footer: { text: tx(a.unique ? "footer_unique" : a.style === "reactions" ? "footer_reactions" : "footer_buttons") } }],
        components: a.style === "buttons" ? Array.from({ length: Math.ceil(opts.length / 5) }, (_, i) => ({ type: 1,
          components: opts.slice(i * 5, i * 5 + 5).map((o) => defined({ type: 2, style: 2, label: o.label.slice(0, 80), custom_id: `dsm:rr:${id}:${o.role_id}`,
            emoji: o.emoji ? { name: o.emoji } : undefined })) }))
          : a.style === "dropdown" ? [{ type: 1, components: [{ type: 3, custom_id: `dsm:rr:${id}:select`, placeholder: (a.placeholder || tx("menu_placeholder")).slice(0, 150),
            min_values: 0, max_values: a.unique ? 1 : opts.length,
            options: opts.map((o) => defined({ label: o.label.slice(0, 100), value: o.role_id, description: o.description?.slice(0, 100), emoji: o.emoji ? { name: o.emoji } : undefined })) }] }]
            : undefined,
        allowed_mentions: { parse: [] },
      }));
      if (a.style === "reactions") for (const o of opts) await api("PUT", `/channels/${c.id}/messages/${msg.id}/reactions/${encodeURIComponent(o.emoji)}/@me`);
      if (!callContext.getStore()?.dryRun) {
        automations().role_menus.push(defined({ id, guild: g, channel: c.id, message_id: msg.id, style: a.style, unique: a.unique, options: opts, bot: bot.id, title: a.title,
          language: a.language, texts: a.texts }));
        saveAutomations();
      }
      return { created: "role menu", id, link: messageLink(g, c.id, msg.id), note: runningNote() };
    });

  tool("set_welcome",
    "Welcome new members automatically: a message (and/or embed) in a channel, an optional DM, and roles given on join. Placeholders: {user} (mention), {username}, {server}, {member_count}. Needs Server Members intent. Replaces this server's previous welcome for this bot.", {
      server, channel: z.string().optional(), message: z.string().optional(),
      embed: z.object({ title: z.string().optional(), description: z.string().optional(), color: z.union([z.string(), z.number()]).optional(), image: z.string().optional() }).optional(),
      dm: z.string().optional(), auto_roles: z.array(z.string()).optional(), enabled: z.boolean().default(true),
    }, async (a) => {
      const g = await guildId(a.server);
      const bot = await me();
      const ch = a.channel ? (await channel(g, a.channel)).id : undefined;
      const auto = a.auto_roles ? await Promise.all(a.auto_roles.map(async (r) => (await role(g, r)).id)) : [];
      if (!ch && !a.dm && !auto.length) throw new DiscordError("Give a channel with a message/embed, a dm, or auto_roles.");
      const entry = defined({ id: newId(), guild: g, bot: bot.id, channel: ch, message: a.message,
        embed: a.embed ? defined({ ...a.embed, color: color(a.embed.color) }) : undefined, dm: a.dm, auto_role_ids: auto, enabled: a.enabled });
      if (callContext.getStore()?.dryRun) return { would_set: entry };
      const list = automations().welcomes.filter((w) => !(w.guild === g && w.bot === bot.id));
      list.push(entry);
      automations().welcomes = list;
      saveAutomations();
      const st = status.get(callContext.getStore()?.token || config.token);
      const [roles, member] = await Promise.all([api("GET", `/guilds/${g}/roles`), api("GET", `/guilds/${g}/members/${bot.id}`)]);
      const perms = roles.filter((r) => r.id === g || member.roles.includes(r.id)).reduce((p, r) => p | BigInt(r.permissions), 0n);
      const auditOk = (perms & 8n) !== 0n || (perms & 128n) !== 0n;
      return { saved: "welcome", id: entry.id, note: runningNote(),
        warning: st?.missing_privileged?.includes("GuildMembers") ? "Server Members intent is off, so joins are not seen yet. Turn it on in the Developer Portal (Bot tab) and restart the app." : undefined };
    });

  tool("create_ticket_panel",
    "Post a support panel with an \"Open ticket\" button. Each click creates a numbered private channel (ticket-0001-name, in the given category: use a \"Tickets\" category so staff see open tickets together) that only that member, the staff roles and the bot can see, with a Close button. Closing saves the transcript on this computer and, with log_channel, posts a summary with the transcript file there for staff; then the channel is deleted. Ticket channels are left out of the moderation log.", {
      server, channel: z.string().describe("Where the panel is posted"),
      category: z.string().optional().describe("Category for ticket channels"),
      category_only_when_open: z.boolean().default(true).describe("Make the category when the first ticket opens and remove it when the last one closes, so it only shows while there are open tickets"),
      staff_roles: z.array(z.string()).min(1),
      title: z.string().optional().describe('Default: "Support" in the server\'s language'),
      description: z.string().optional(),
      button_label: z.string().optional().describe('Default: "Open ticket" in the server\'s language'),
      welcome: z.string().optional().describe("First message in each ticket; {user} = the member"),
      ping_staff: z.boolean().default(false),
      log_channel: z.string().optional().describe("Staff channel for ticket updates: opened (with the Claim button), claimed, and closed with a summary and the transcript file (e.g. ticket-logs). It is made private to the staff roles if members can see it."),
      claim_button: z.boolean().default(true).describe("A Claim button so staff can show who is handling each ticket"),
      language: Language, texts: textsOf(TICKET_TEXTS),
    }, async (a) => {
      const g = await guildId(a.server);
      const locale = await guildLocale(g);
      const tx = (k) => text(k, { lang: a.language, locale, texts: a.texts });
      const c = await channel(g, a.channel);
      const cat = a.category && !a.category_only_when_open ? await category(g, a.category) : undefined;
      const logCh = a.log_channel ? await channel(g, a.log_channel) : undefined;
      const staff = await Promise.all(a.staff_roles.map(async (r) => (await role(g, r)).id));
      const bot = await me();
      const madePrivate = logCh ? await staffOnly(g, logCh, staff, bot.id) : false;
      const id = newId();
      const msg = await api("POST", `/channels/${c.id}/messages`, {
        embeds: [{ title: a.title || tx("panel_title"), description: a.description || tx("panel_description"), color: 0x5865f2 }],
        components: [{ type: 1, components: [{ type: 2, style: 1, label: (a.button_label || tx("open_label")).slice(0, 80), custom_id: `dsm:ticket:open:${id}`, emoji: { name: "🎫" } }] }],
      });
      if (!callContext.getStore()?.dryRun) {
        automations().ticket_panels.push(defined({ id, guild: g, panel_channel: c.id, message_id: msg.id, category_id: cat?.id, staff_role_ids: staff,
          category_name: a.category && a.category_only_when_open ? a.category : undefined,
          welcome: a.welcome, ping_staff: a.ping_staff, bot: bot.id, language: a.language, texts: a.texts,
          log_channel: logCh?.id, claim: a.claim_button ? undefined : false }));
        saveAutomations();
      }
      return defined({ created: "ticket panel", id, link: messageLink(g, c.id, msg.id), note: runningNote(),
        log_channel_now_private: madePrivate ? `${logCh.name} was visible to everyone, so it is now private to the staff roles.` : undefined });
    });

  tool("create_command",
    "Add a slash command to the server (e.g. /rules, /links, /ip) that answers with a fixed text and/or embed. Give translations so each member sees the command's name, description and answer in their own Discord language (keys: en, pt-BR, es, fr, de, it, ru, ja, zh-CN, ko, pl, tr or any Discord locale such as nl or sv-SE). Placeholders: {user}, {username}. Answers while this tool runs (or 24/7 with `discord-server-mcp run`). Calling it again with the same name updates it; remove it with remove_automation.", {
      server, name: z.string().regex(/^[-_\p{L}\p{N}]{1,32}$/u).describe("Main name: lowercase, no spaces, e.g. rules. Shown to members whose language has no translation"),
      description: z.string().min(1).max(100),
      response: z.string().max(2000).optional(),
      embed: z.object({ title: z.string().optional(), description: z.string().optional(), color: z.union([z.string(), z.number()]).optional(), image: z.string().optional() }).optional(),
      ephemeral: z.boolean().default(false).describe("Only the person who used it sees the answer"),
      translations: z.record(z.string(), z.object({
        name: z.string().regex(/^[-_\p{L}\p{N}]{1,32}$/u).optional(), description: z.string().max(100).optional(),
        response: z.string().max(2000).optional(), embed_title: z.string().max(256).optional(), embed_description: z.string().max(4096).optional(),
      })).optional().describe('e.g. {"en": {"name": "rules", "response": "…"}, "pt-BR": {"name": "regras", "response": "…"}}'),
    }, async (a) => {
      if (!a.response && !a.embed) throw new DiscordError("Give a response, an embed, or both.");
      const g = await guildId(a.server);
      const bot = await me();
      const name = a.name.toLowerCase();
      // Our language codes to Discord's locale codes.
      const DISCORD = ["id", "da", "de", "en-GB", "en-US", "es-ES", "es-419", "fr", "hr", "it", "lt", "hu", "nl", "no", "pl", "pt-BR", "ro", "fi", "sv-SE",
        "vi", "tr", "cs", "el", "bg", "ru", "uk", "hi", "th", "zh-CN", "ja", "zh-TW", "ko"];
      const toLocales = (k) => ({ en: ["en-US", "en-GB"], es: ["es-ES", "es-419"], pt: ["pt-BR"] }[k] || (DISCORD.includes(k) ? [k] : null));
      const names = {}, descriptions = {};
      for (const [k, v] of Object.entries(a.translations || {})) {
        const locales = toLocales(k);
        if (!locales) throw new DiscordError(`Unknown language "${k}". Use one of: en, es, pt, ${DISCORD.join(", ")}.`);
        for (const l of locales) {
          if (v.name) names[l] = v.name.toLowerCase();
          if (v.description) descriptions[l] = v.description;
        }
      }
      const body = { name, description: a.description, type: 1,
        name_localizations: Object.keys(names).length ? names : undefined, description_localizations: Object.keys(descriptions).length ? descriptions : undefined };
      const old = automations().commands.find((c) => c.guild === g && c.name === name && c.bot === bot.id);
      const created = old?.command_id
        ? await api("PATCH", `/applications/${bot.id}/guilds/${g}/commands/${old.command_id}`, body).catch(() => api("POST", `/applications/${bot.id}/guilds/${g}/commands`, body))
        : await api("POST", `/applications/${bot.id}/guilds/${g}/commands`, body);
      if (!callContext.getStore()?.dryRun) {
        const list = automations().commands.filter((c) => c !== old);
        list.push(defined({ id: old?.id || newId(), guild: g, bot: bot.id, command_id: created.id, name, response: a.response,
          embed: a.embed ? defined({ ...a.embed, color: color(a.embed.color) }) : undefined, ephemeral: a.ephemeral,
          translations: a.translations }));
        automations().commands = list;
        saveAutomations();
      }
      return defined({ created: `/${name}`, also_shown_as: Object.keys(names).length ? [...new Set(Object.values(names))].map((n) => `/${n}`) : undefined,
        note: `${runningNote()} It can take a minute to appear in Discord.` });
    });

  tool("set_support_forum",
    "Run a forum as a support desk: each new post gets the Open tag and a message with a Solved button; staff can claim it (In progress tag); Solved switches the tag to Solved and closes the post (locked if chosen); posts idle for some days can be closed. Optionally a staff channel gets a line when posts open (with the Claim button), are claimed and are solved. Tags are created if missing. Works alongside ticket panels. Calling it again for the same forum updates it.", {
      server, forum: z.string(), staff_roles: z.array(z.string()).min(1),
      tags: z.object({ open: z.string().optional(), in_progress: z.string().optional(), solved: z.string().optional() }).optional().describe("Tag names to use; default Open / In progress / Solved in the server's language. Existing tags with these names are reused"),
      log_channel: z.string().optional().describe("Staff channel for updates; made private to the staff roles if everyone can see it"),
      claim_button: z.boolean().default(true),
      lock_on_solve: z.boolean().default(true).describe("Solved posts are locked (no new messages) besides being closed"),
      close_after_days: z.number().int().min(1).max(90).optional().describe("Close posts with no messages for this many days"),
      welcome: z.boolean().default(true).describe("Post the welcome line on new posts (the buttons are always posted)"),
      ping_staff: z.boolean().default(false).describe("Ping the staff roles in the staff channel for each new post"),
      language: Language, texts: textsOf(TEXT_KEYS.filter((k) => k.startsWith("sf_"))),
      enabled: z.boolean().default(true),
    }, async (a) => {
      const g = await guildId(a.server);
      const f = await channel(g, a.forum);
      if (f.type !== 15) throw new DiscordError(`${f.name} is not a forum channel.`);
      const bot = await me();
      const locale = await guildLocale(g);
      const tx = (k) => text(k, { lang: a.language, locale, texts: a.texts });
      const staff = await Promise.all(a.staff_roles.map(async (r) => (await role(g, r)).id));
      const names = { open: a.tags?.open || tx("sf_tag_open"), in_progress: a.tags?.in_progress || tx("sf_tag_in_progress"), solved: a.tags?.solved || tx("sf_tag_solved") };
      const emoji = { open: "🟢", in_progress: "🟡", solved: "✅" };
      const tags = [...(f.available_tags || [])];
      for (const [k, n] of Object.entries(names)) if (!tags.some((t) => t.name.toLowerCase() === n.toLowerCase())) tags.push({ name: n, emoji_name: emoji[k] });
      if (tags.length > 20) throw new DiscordError("A forum can have at most 20 tags; remove some first.");
      const updated = await api("PATCH", `/channels/${f.id}`, { available_tags: tags });
      const ids = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, (updated.available_tags || []).find((t) => t.name.toLowerCase() === n.toLowerCase())?.id]));
      const logCh = a.log_channel ? await channel(g, a.log_channel) : undefined;
      const madePrivate = logCh ? await staffOnly(g, logCh, staff, bot.id) : false;
      const entry = defined({ id: newId(), guild: g, bot: bot.id, forum: f.id, staff_role_ids: staff, tags: ids, log_channel: logCh?.id,
        claim: a.claim_button ? undefined : false, lock_on_solve: a.lock_on_solve, close_after_days: a.close_after_days,
        welcome: a.welcome ? undefined : "", ping_staff: a.ping_staff || undefined, language: a.language, texts: a.texts, enabled: a.enabled });
      if (callContext.getStore()?.dryRun) return { would_set: entry };
      const old = automations().support_forums.find((x) => x.guild === g && x.bot === bot.id && x.forum === f.id);
      if (old) entry.id = old.id;
      automations().support_forums = [...automations().support_forums.filter((x) => x !== old), entry];
      saveAutomations();
      return defined({ saved: "support forum", id: entry.id, forum: f.name, tags: names, note: runningNote(),
        log_channel_now_private: madePrivate ? `${logCh.name} was visible to everyone, so it is now private to the staff roles.` : undefined,
        tip: "Staff can also use /ticket close (solves) and /ticket claim inside a post, if staff commands are on." });
    });

  tool("create_rule",
    "An automatic rule: when something happens, the bot does something. When: a message (containing words, matching a pattern, with a link or a file; in some channels; from some roles), a member joining, or a reaction (an emoji, on one message). Then, in order: reply, send a message to a channel, DM the member, give or take a role, delete the message, react, time the member out. Placeholders: {user}, {username}, {server}, {channel}, {content}. Examples: answer \"how do I join?\" with the IP; delete invite links from new members; give a role to whoever reacts ✅ on a message.", {
      server, name: z.string().max(80),
      when: z.object({
        event: z.enum(["message", "member_join", "reaction"]),
        words: z.array(z.string()).optional().describe("message: any of these words or phrases"),
        whole_words: z.boolean().default(true),
        regex: z.string().optional().describe("message: a regular expression instead of or besides words"),
        has_link: z.boolean().optional(), has_attachment: z.boolean().optional(),
        channels: z.array(z.string()).optional().describe("Only in these channels (or forums)"),
        only_roles: z.array(z.string()).optional(), except_roles: z.array(z.string()).optional().describe("e.g. the staff, so they are not affected"),
        emoji: z.string().optional().describe("reaction: this emoji"), message: z.string().optional().describe("reaction: only on this message (link or id)"),
      }),
      then: z.array(z.object({
        action: z.enum(["reply", "send", "dm", "add_role", "remove_role", "delete", "react", "timeout"]),
        text: z.string().max(2000).optional(), channel: z.string().optional().describe("send: where"),
        role: z.string().optional().describe("add_role / remove_role"), ping_role: z.string().optional().describe("send: role to mention"),
        emoji: z.string().optional().describe("react"), minutes: z.number().int().min(1).max(40320).optional().describe("timeout"),
      })).min(1).max(10),
      cooldown_seconds: z.number().int().min(0).max(86400).default(0).describe("Per member, so a rule does not fire again too soon"),
      enabled: z.boolean().default(true),
    }, async (a) => {
      const g = await guildId(a.server);
      const bot = await me();
      const chans = a.when.channels ? await Promise.all(a.when.channels.map(async (x) => (await channel(g, x)).id)) : undefined;
      const roleIds = async (list) => (list ? Promise.all(list.map(async (r) => (await role(g, r)).id)) : undefined);
      let messageId;
      if (a.when.message) messageId = a.when.message.split("/").pop();
      if (a.when.regex) {
        try {
          new RegExp(a.when.regex, "iu");
        } catch (e) {
          throw new DiscordError(`The pattern is not valid: ${e.message}`);
        }
      }
      const then = [];
      for (const x of a.then) {
        if (["reply", "send", "dm"].includes(x.action) && !x.text) throw new DiscordError(`${x.action} needs a text.`);
        if (["add_role", "remove_role"].includes(x.action) && !x.role) throw new DiscordError(`${x.action} needs a role.`);
        if (x.action === "send" && !x.channel) throw new DiscordError("send needs a channel.");
        if (x.action === "react" && !x.emoji) throw new DiscordError("react needs an emoji.");
        then.push(defined({ action: x.action, text: x.text, channel: x.channel ? (await channel(g, x.channel)).id : undefined,
          role: x.role ? (await role(g, x.role)).id : undefined, ping_role: x.ping_role ? (await role(g, x.ping_role)).id : undefined,
          emoji: x.emoji, minutes: x.minutes }));
      }
      if (a.when.event !== "message" && then.some((x) => ["reply", "delete", "react"].includes(x.action)) && a.when.event === "member_join") {
        throw new DiscordError("reply, delete and react need a message; for joins use send or dm.");
      }
      const entry = defined({ id: newId(), guild: g, bot: bot.id, name: a.name, cooldown_seconds: a.cooldown_seconds || undefined, enabled: a.enabled, then,
        when: defined({ event: a.when.event, words: a.when.words, whole_words: a.when.whole_words, regex: a.when.regex, has_link: a.when.has_link,
          has_attachment: a.when.has_attachment, channels: chans, only_roles: await roleIds(a.when.only_roles), except_roles: await roleIds(a.when.except_roles),
          emoji: a.when.emoji, message_id: messageId }) });
      if (callContext.getStore()?.dryRun) return { would_create: entry };
      automations().rules.push(entry);
      saveAutomations();
      const st = status.get(callContext.getStore()?.token || config.token);
      return defined({ created: "rule", id: entry.id, name: a.name, note: runningNote(),
        warning: a.when.event === "message" && st?.missing_privileged?.includes("MessageContent") ? "Message Content intent is off, so the bot cannot read messages for this rule. Turn it on in the Developer Portal (Bot tab) and restart the app." : undefined });
    });

  tool("create_verification",
    "Member verification: a message with the rules (given here or in a rules channel) and an \"I accept the rules\" button that gives a role; without rules it is a plain \"Enter the server\" button (and can take away an \"unverified\" role). Optionally hides the rest of the server until then: every channel @everyone can see now becomes visible only to the verified role (private channels stay as they are).", {
      server, channel: z.string(), role: z.string().describe("Role given on accepting, e.g. Member"),
      remove_role: z.string().optional(),
      rules: z.array(z.string()).max(25).optional().describe("The rules, shown numbered above the button"),
      rules_channel: z.string().optional().describe("Or the channel that has the rules"),
      title: z.string().optional(), description: z.string().optional().describe("Own text instead of the default"),
      button_label: z.string().optional(),
      hide_server_until_verified: z.boolean().default(false),
      language: Language, texts: textsOf(["verify_done", "verify_already", "role_error"]),
    }, async (a) => {
      const g = await guildId(a.server);
      const c = await channel(g, a.channel);
      const r = await role(g, a.role);
      const rr = a.remove_role ? await role(g, a.remove_role) : undefined;
      const bot = await me();
      const locale = await guildLocale(g);
      const tx = (k) => text(k, { lang: a.language, locale, texts: a.texts });
      const id = newId();
      // Only talk about rules when there are some to accept.
      const rulesCh = a.rules_channel ? await channel(g, a.rules_channel) : undefined;
      const hasRules = Boolean(a.rules?.length || rulesCh);
      const description = a.description
        || (a.rules?.length ? `${a.rules.map((r, i) => `**${i + 1}.** ${r}`).join("\n")}\n\n${tx("verify_click")}`
          : rulesCh ? text("verify_with_channel", { lang: a.language, locale, texts: a.texts, vars: { channel: `<#${rulesCh.id}>` } })
            : tx("verify_plain"));
      const msg = await api("POST", `/channels/${c.id}/messages`, {
        embeds: [{ title: a.title || tx(hasRules ? "verify_title" : "verify_title_plain"), description: description.slice(0, 4096), color: 0x57f287 }],
        components: [{ type: 1, components: [{ type: 2, style: 3, label: (a.button_label || tx(hasRules ? "verify_label" : "verify_label_plain")).slice(0, 80), custom_id: `dsm:verify:${id}`, emoji: { name: "✅" } }] }],
      });
      const hidden = [];
      if (a.hide_server_until_verified) {
        const view = 1n << 10n;
        for (const ch of await api("GET", `/guilds/${g}/channels`)) {
          if (ch.id === c.id || (ch.parent_id && !ch.permission_overwrites?.length)) continue;
          const ev = (ch.permission_overwrites || []).find((o) => o.id === g);
          if (ev && BigInt(ev.deny) & view) continue;
          await api("PUT", `/channels/${ch.id}/permissions/${g}`, { type: 0, allow: String(BigInt(ev?.allow || 0) & ~view), deny: String(BigInt(ev?.deny || 0) | view) }, { reason: "Verification" });
          await api("PUT", `/channels/${ch.id}/permissions/${r.id}`, { type: 0, allow: String(view), deny: "0" }, { reason: "Verification" });
          hidden.push(ch.name);
        }
        // The verification channel itself stays open to everyone.
        await api("PUT", `/channels/${c.id}/permissions/${g}`, { type: 0, allow: String(view), deny: "0" }, { reason: "Verification" });
      }
      if (!callContext.getStore()?.dryRun) {
        automations().verifications.push(defined({ id, guild: g, bot: bot.id, channel: c.id, message_id: msg.id, role: r.id, remove_role: rr?.id, language: a.language, texts: a.texts }));
        saveAutomations();
      }
      return defined({ created: "verification", id, link: messageLink(g, c.id, msg.id), gives: r.name,
        hidden_until_verified: hidden.length ? hidden : undefined, note: runningNote() });
    });

  tool("schedule_message",
    "Send a message later, or again and again: once at a time, or every N hours, days, weeks or months at the same local time (time zone aware). Optional role ping and end date. If the app was closed at the time, it is sent when it reopens within 6 hours, otherwise skipped to the next time.", {
      server, channel: z.string(),
      content: z.string().max(2000).optional(),
      embed: z.object({ title: z.string().optional(), description: z.string().optional(), color: z.union([z.string(), z.number()]).optional(), image: z.string().optional() }).optional(),
      at: z.string().describe('First time, ISO with offset or local to timezone, e.g. "2026-12-01T20:00" or "2026-12-01T20:00:00Z"'),
      timezone: z.string().default("UTC").describe("IANA zone, e.g. Europe/Lisbon"),
      every: z.enum(["hour", "day", "week", "month"]).optional(), interval: z.number().int().min(1).max(365).default(1),
      until: z.string().optional(),
      ping_role: z.string().optional(), ping_everyone: z.boolean().default(false),
      name: z.string().optional(),
    }, async (a) => {
      if (!a.content && !a.embed) throw new DiscordError("Give a content, an embed, or both.");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: a.timezone });
      } catch {
        throw new DiscordError(`Unknown time zone ${a.timezone}. Use one like Europe/Lisbon or America/Sao_Paulo.`);
      }
      const g = await guildId(a.server);
      const c = await channel(g, a.channel);
      const bot = await me();
      const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(a.at);
      const first = local ? zoned(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], a.timezone) : Date.parse(a.at);
      if (!Number.isFinite(first)) throw new DiscordError(`Cannot read the time "${a.at}".`);
      const entry = defined({ id: newId(), guild: g, bot: bot.id, channel: c.id, name: a.name, content: a.content,
        embed: a.embed ? defined({ title: a.embed.title, description: a.embed.description, color: color(a.embed.color), image: a.embed.image ? { url: a.embed.image } : undefined }) : undefined,
        first, timezone: a.timezone, every: a.every, interval: a.every ? a.interval : undefined, until: a.until ? Date.parse(a.until) : undefined,
        ping_role: a.ping_role ? (await role(g, a.ping_role)).id : undefined, ping_everyone: a.ping_everyone || undefined });
      entry.next = nextRun(entry);
      if (!entry.next) throw new DiscordError("That time has already passed.");
      if (callContext.getStore()?.dryRun) return { would_schedule: entry };
      automations().schedules.push(entry);
      saveAutomations();
      armSchedules();
      return { scheduled: entry.id, channel: c.name, next: new Date(entry.next).toISOString(),
        next_local: new Date(entry.next).toLocaleString("en-GB", { timeZone: a.timezone }), repeats: a.every ? `every ${a.interval > 1 ? `${a.interval} ` : ""}${a.every}${a.interval > 1 ? "s" : ""}` : "once",
        note: runningNote() };
    });

  tool("set_mod_log",
    "Post a moderation log in a channel or a forum: deleted and edited messages (with what they said), members joining and leaving, kicks, bans, unbans, timeouts, nickname and role changes (with who did it and why), AutoMod blocks, and channels or roles created or deleted. Use a staff-only channel. For separate channels per kind (as many servers do: message-log, member-log, mod-log), call it once per channel with its events. Calling it again for the same channel replaces that log. With a forum channel, each member gets one post with every event about them and tags per kind, so staff filter by member, by kind or both. Every entry is also kept on this computer for search_mod_log and /modlog.", {
      server, channel: z.string(),
      events: z.array(z.enum(LOG_EVENTS)).default(LOG_EVENTS).describe("messages = deleted/edited; members = joins/leaves; moderation = kicks, bans, timeouts, nicknames, roles, AutoMod; server = channels and roles created or deleted"),
      ignore_channels: z.array(z.string()).optional().describe("Channels to leave out (ticket channels are always left out)"),
      language: Language, texts: textsOf(LOG_TEXTS),
      enabled: z.boolean().default(true),
    }, async (a) => {
      const g = await guildId(a.server);
      const bot = await me();
      const c = await channel(g, a.channel);
      const ignore = a.ignore_channels ? await Promise.all(a.ignore_channels.map(async (x) => (await channel(g, x)).id)) : undefined;
      const entry = defined({ id: newId(), guild: g, bot: bot.id, channel: c.id, events: a.events, ignore_channels: ignore, language: a.language, texts: a.texts, enabled: a.enabled });
      if (callContext.getStore()?.dryRun) return { would_set: entry };
      // A forum channel gets one post per member and a tag per kind, so staff can filter by both.
      if (c.type === 15) {
        const locale = await guildLocale(g);
        const label = (k) => text(`log_kind_${k}`, { lang: a.language, locale, texts: a.texts });
        const tags = [...(c.available_tags || [])];
        for (const k of a.events) if (!tags.some((x) => x.name === label(k))) tags.push({ name: label(k), emoji_name: { messages: "💬", members: "👥", moderation: "🛡️", server: "⚙️" }[k] });
        // List view, newest activity first, and a guideline explaining how to filter.
        const updated = await api("PATCH", `/channels/${c.id}`, { available_tags: tags.slice(0, 20), default_forum_layout: 1, default_sort_order: 0,
          topic: c.topic || text("log_forum_topic", { lang: a.language, locale, texts: a.texts }) });
        entry.forum = true;
        entry.tags = Object.fromEntries(a.events.map((k) => [k, updated.available_tags.find((x) => x.name === label(k))?.id]));
        const old = automations().mod_logs.find((l) => l.guild === g && l.bot === bot.id && l.channel === c.id);
        if (old?.threads) entry.threads = old.threads;
      }
      automations().mod_logs = [...automations().mod_logs.filter((l) => !(l.guild === g && l.bot === bot.id && l.channel === c.id)), entry];
      saveAutomations();
      const st = status.get(callContext.getStore()?.token || config.token);
      const [roles, member] = await Promise.all([api("GET", `/guilds/${g}/roles`), api("GET", `/guilds/${g}/members/${bot.id}`)]);
      const perms = roles.filter((r) => r.id === g || member.roles.includes(r.id)).reduce((p, r) => p | BigInt(r.permissions), 0n);
      const auditOk = (perms & 8n) !== 0n || (perms & 128n) !== 0n;
      const missing = st?.missing_privileged || [];
      return { saved: "moderation log", id: entry.id, channel: c.name, events: a.events, forum: entry.forum, note: runningNote(),
        filtering: entry.forum
          ? "Each member gets their own post with everything about them; tags mark the kinds. In Discord: filter by tag, search a member's name or id, or both."
          : "Every entry carries the member's id in its footer, so Discord's search finds them. For filters by member and kind, use search_mod_log here or /modlog in Discord (enable_staff_commands), or use a forum channel for the log.",
        warnings: [
          missing.includes("MessageContent") && a.events.includes("messages") ? "Message Content intent is off, so deleted and edited messages show without their text. Turn it on in the Developer Portal (Bot tab) and restart the app." : undefined,
          missing.includes("GuildMembers") && a.events.includes("members") ? "Server Members intent is off, so joins and leaves are not seen. Turn it on in the Developer Portal (Bot tab) and restart the app." : undefined,
          auditOk ? undefined : "The bot needs View Audit Log to report kicks, bans, timeouts and role changes. Give its role that permission.",
        ].filter(Boolean) };
    });

  tool("set_staff_alerts",
    "Alert the staff when something serious happens: bans, kicks, timeouts, AutoMod blocks, or a raid (many joins in a short time). Alerts go to a channel with a role ping and/or by DM to chosen members. Replaces this server's previous alerts for this bot.", {
      server,
      on: z.array(z.enum(["ban", "kick", "timeout", "automod", "raid"])).default(["ban", "automod", "raid"]),
      channel: z.string().optional().describe("Staff channel for the alerts"),
      ping_role: z.string().optional().describe("Role to mention in that channel, e.g. Moderator"),
      dm_members: z.array(z.string()).optional().describe("Members who also get each alert by DM"),
      raid_joins: z.number().int().min(2).max(500).default(10),
      raid_seconds: z.number().int().min(5).max(3600).default(60),
      language: Language, texts: textsOf(["log_banned", "log_kicked", "log_timeout", "log_automod", "log_raid", "log_member", "log_by", "log_reason", "log_until", "log_content"]),
      enabled: z.boolean().default(true),
    }, async (a) => {
      if (!a.channel && !a.dm_members?.length) throw new DiscordError("Give a channel, members to DM, or both.");
      const g = await guildId(a.server);
      const bot = await me();
      const c = a.channel ? await channel(g, a.channel) : undefined;
      const r = a.ping_role ? await role(g, a.ping_role) : undefined;
      const dms = a.dm_members ? await Promise.all(a.dm_members.map(async (m) => (await member(g, m)).user.id)) : undefined;
      const entry = defined({ id: newId(), guild: g, bot: bot.id, on: a.on, channel: c?.id, ping_role: r?.id, dm_users: dms,
        raid_joins: a.raid_joins, raid_seconds: a.raid_seconds, language: a.language, texts: a.texts, enabled: a.enabled });
      if (callContext.getStore()?.dryRun) return { would_set: entry };
      automations().alerts = [...automations().alerts.filter((x) => !(x.guild === g && x.bot === bot.id)), entry];
      saveAutomations();
      return { saved: "staff alerts", id: entry.id, on: a.on, channel: c?.name, ping: r?.name, dms: dms?.length,
        raid: a.on.includes("raid") ? `${a.raid_joins} joins in ${a.raid_seconds}s` : undefined, note: runningNote() };
    });

  tool("enable_staff_commands",
    `Add slash commands for the server's staff, which run inside Discord: ${Object.keys(STAFF_COMMANDS).map((n) => `/${n}`).join(", ")} (names in English, or translated per member, or in one language for everyone). Discord only shows each one to members with the matching permission (e.g. /ban needs Ban Members), and members cannot act on someone at or above their own role. Actions show in the moderation log with who used them. Calling it again updates them.`, {
      server,
      commands: z.array(z.enum(Object.keys(STAFF_COMMANDS))).default(Object.keys(STAFF_COMMANDS)),
      language: Language.describe("Language of the bot's answers"),
      command_names: z.enum(["member", "english", ...LANGUAGES.filter((l) => !["auto", "pt"].includes(l))]).default("member")
        .describe('"member" = English, shown translated to each member whose Discord is in a language we have (Portuguese, Spanish, French, German, Italian, Russian, Japanese, Chinese, Korean, Polish, Turkish); "english" = English for everyone; a language code = that language for everyone'),
      texts: textsOf(STAFF_TEXTS),
    }, async (a) => {
      const g = await guildId(a.server);
      const bot = await me();
      const ids = await registerStaffCommands(g, bot.id, a.commands, { names: a.command_names });
      if (!callContext.getStore()?.dryRun) {
        const old = automations().staff_commands.find((x) => x.guild === g && x.bot === bot.id);
        // Renamed commands are new commands for Discord: remove the old ones.
        for (const [n, cid] of Object.entries(old?.commands || {})) {
          if (ids[n] && ids[n] !== cid) await api("DELETE", `/applications/${bot.id}/guilds/${g}/commands/${cid}`).catch(() => {});
        }
        automations().staff_commands = [...automations().staff_commands.filter((x) => x !== old),
          defined({ id: old?.id || newId(), guild: g, bot: bot.id, commands: { ...(old?.commands || {}), ...ids }, language: a.language, texts: a.texts })];
        saveAutomations();
      }
      return { enabled: a.commands.map((n) => `/${n}`), note: `${runningNote()} They can take a minute to appear. Server Settings > Integrations > the bot lets the owner change who can use each one.` };
    });

  tool("search_mod_log",
    "Search the moderation log kept on this computer: by member (what they did or what happened to them), by who acted, by kind, by event (e.g. banned, message_deleted, timeout), by words and by date.", {
      server,
      member: z.string().optional(), by: z.string().optional().describe("Staff member or bot who acted"),
      kind: z.enum(LOG_EVENTS).optional(),
      event: z.string().optional().describe("e.g. banned, kicked, timeout, message_deleted, message_edited, joined, left, roles, nickname"),
      contains: z.string().optional(), days: z.number().int().min(1).max(3650).default(30), limit: z.number().int().min(1).max(200).default(50),
    }, async (a) => {
      const g = await guildId(a.server);
      const idOf = async (ref) => (/^\d{15,}$/.test(ref) ? ref : (await member(g, ref)).user.id);
      const rows = search(g, { user: a.member ? await idOf(a.member) : undefined, actor: a.by ? await idOf(a.by) : undefined, kind: a.kind,
        type: a.event, contains: a.contains, since: new Date(Date.now() - a.days * 86400000).toISOString(), limit: a.limit });
      return { count: rows.length, entries: rows, note: rows.length ? undefined : "Nothing found. Only events since the log was set up are kept." };
    }, READ);

  tool("ticket_history",
    "Closed tickets of a server: number, who opened, handled and closed them, when, how many messages, and the transcript file. Pass ticket (name or number) to read one transcript.", {
      server, member: z.string().optional(), ticket: z.string().optional(), limit: z.number().int().min(1).max(200).default(25),
    }, async (a) => {
      const g = await guildId(a.server);
      let list = automations().closed_tickets.filter((x) => x.guild === g);
      if (a.member) {
        const id = /^\d{15,}$/.test(a.member) ? a.member : (await member(g, a.member)).user.id;
        list = list.filter((x) => [x.user_id, x.claimed_by, x.closed_by].includes(id));
      }
      if (a.ticket) {
        const one = list.find((x) => x.name === a.ticket || String(x.number) === String(Number(a.ticket)) || x.name?.includes(a.ticket));
        if (!one) throw new DiscordError(`No closed ticket "${a.ticket}".`);
        let transcript;
        try {
          transcript = readFileSync(one.file, "utf8");
        } catch {
          transcript = "(the transcript file is not on this computer)";
        }
        return { ...one, transcript: transcript.length > 30000 ? `${transcript.slice(0, 30000)}\n…` : transcript };
      }
      return { count: list.length, tickets: list.slice(-a.limit).reverse() };
    }, READ);

  tool("edit_automation",
    "Change an automation without making it again: its language, any of the texts members or staff see (merged with the ones already changed; \"\" puts a text back to the default), or turn it off and on. The ids come from list_automations. To change a panel's or menu's own message, use edit_message on it.", {
      id: z.string(), language: z.enum(LANGUAGES).optional(),
      texts: z.record(z.string(), z.string()).optional().describe(`Any of: ${TEXT_KEYS.join(", ")}`),
      enabled: z.boolean().optional(),
    }, async ({ id, language, texts, enabled }) => {
      const d = automations();
      const item = [...d.role_menus, ...d.welcomes, ...d.ticket_panels, ...d.commands, ...d.mod_logs, ...d.alerts, ...d.staff_commands,
        ...d.support_forums, ...d.rules, ...d.verifications, ...d.schedules].find((x) => x.id === id);
      if (!item) throw new DiscordError(`No automation with id ${id}. See list_automations.`);
      const unknown = Object.keys(texts || {}).filter((k) => !TEXT_KEYS.includes(k));
      if (unknown.length) throw new DiscordError(`Unknown texts: ${unknown.join(", ")}.`);
      if (callContext.getStore()?.dryRun) return { would_change: { id, language, texts, enabled } };
      if (language) item.language = language;
      if (enabled !== undefined) item.enabled = enabled;
      if (texts) {
        item.texts = { ...(item.texts || {}), ...texts };
        for (const [k, v] of Object.entries(texts)) if (v === "") delete item.texts[k];
      }
      saveAutomations();
      return defined({ changed: id, language: item.language, texts: item.texts, enabled: item.enabled });
    });

  tool("list_automations", "List the role menus, welcome messages, ticket panels, slash commands, moderation logs and open tickets set up on this computer.", { server }, async ({ server: s }) => {
    const g = s ? await guildId(s) : undefined;
    const d = automations();
    const mine = (x) => !g || x.guild === g;
    return {
      role_menus: d.role_menus.filter(mine).map((m) => ({ id: m.id, title: m.title, style: m.style, roles: m.options.map((o) => o.label), link: messageLink(m.guild, m.channel, m.message_id) })),
      welcomes: d.welcomes.filter(mine).map((w) => defined({ id: w.id, channel: w.channel, message: w.message, dm: w.dm ? "yes" : undefined, auto_roles: w.auto_role_ids?.length, enabled: w.enabled })),
      ticket_panels: d.ticket_panels.filter(mine).map((p) => ({ id: p.id, link: messageLink(p.guild, p.panel_channel, p.message_id), staff_roles: p.staff_role_ids.length })),
      commands: d.commands.filter(mine).map((c) => ({ id: c.id, command: `/${c.name}`, ephemeral: c.ephemeral || undefined })),
      mod_logs: d.mod_logs.filter(mine).map((l) => defined({ id: l.id, channel: l.channel, events: l.events, forum: l.forum, enabled: l.enabled })),
      staff_alerts: d.alerts.filter(mine).map((x) => defined({ id: x.id, on: x.on, channel: x.channel, dms: x.dm_users?.length })),
      staff_commands: d.staff_commands.filter(mine).map((x) => ({ id: x.id, commands: Object.keys(x.commands || {}).map((n) => `/${n}`) })),
      support_forums: d.support_forums.filter(mine).map((x) => defined({ id: x.id, forum: x.forum, log_channel: x.log_channel, close_after_days: x.close_after_days, enabled: x.enabled })),
      rules: d.rules.filter(mine).map((x) => defined({ id: x.id, name: x.name, when: x.when.event, then: x.then.map((y) => y.action), enabled: x.enabled })),
      verifications: d.verifications.filter(mine).map((x) => ({ id: x.id, link: messageLink(x.guild, x.channel, x.message_id) })),
      schedules: d.schedules.filter(mine).map((x) => defined({ id: x.id, name: x.name, channel: x.channel, next: x.next ? new Date(x.next).toISOString() : undefined,
        every: x.every, sent: x.sent, enabled: x.enabled })),
      open_tickets: d.tickets.length, saved_in: AUTOMATIONS_FILE, note: runningNote(),
    };
  }, READ);

  tool("remove_automation", "Turn off a role menu, welcome, ticket panel, slash command or moderation log (by id from list_automations). Optionally delete its message too. Slash commands are removed from Discord.", {
    id: z.string(), delete_message: z.boolean().optional(),
  }, async ({ id, delete_message }) => {
    const d = automations();
    const found = [["role_menus", d.role_menus], ["welcomes", d.welcomes], ["ticket_panels", d.ticket_panels], ["commands", d.commands], ["mod_logs", d.mod_logs],
      ["alerts", d.alerts], ["staff_commands", d.staff_commands], ["support_forums", d.support_forums], ["rules", d.rules],
      ["verifications", d.verifications], ["schedules", d.schedules]]
      .find(([, list]) => list.some((x) => x.id === id));
    if (!found) throw new DiscordError(`No automation ${id}.`);
    const [kind, list] = found;
    const item = list.find((x) => x.id === id);
    if (delete_message && item.message_id) await api("DELETE", `/channels/${item.channel || item.panel_channel}/messages/${item.message_id}`).catch(() => {});
    if (kind === "commands") await api("DELETE", `/applications/${item.bot}/guilds/${item.guild}/commands/${item.command_id}`).catch(() => {});
    if (kind === "staff_commands") for (const cid of Object.values(item.commands || {})) await api("DELETE", `/applications/${item.bot}/guilds/${item.guild}/commands/${cid}`).catch(() => {});
    if (!callContext.getStore()?.dryRun) {
      d[kind] = list.filter((x) => x.id !== id);
      saveAutomations();
    }
    return { removed: id, kind };
  }, DESTRUCTIVE);
}
