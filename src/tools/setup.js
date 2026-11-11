// Setup: which bots are configured and where they are, what to fix, adding/switching/removing bots,
// the invite link, and this server's own settings.
import { z } from "zod";
import { api, me, permNames, bits, botsWithServers, DiscordError, callContext, roleAbove, topRole } from "../discord.js";
import {
  config, addBot, removeBot, findBot, activeBot, saveSettings, fromEnvironment, SETTINGS_FILE, BOTS_FILE,
} from "../config.js";
import { startGateway as startPresence } from "../gateway.js";
import { startTokenPage } from "../tokenpage.js";
import { READ, DESTRUCTIVE, registered, PACKS, enablePacks, packHandles, packTool, describePackTools } from "../tool.js";
import { VERSION } from "../version.js";

const RECOMMENDED = ["ViewChannel", "ManageChannels", "ManageRoles", "ManageGuild", "ManageMessages", "ManageThreads",
  "ManageWebhooks", "ManageGuildExpressions", "ManageEvents", "SendMessages", "SendMessagesInThreads", "CreatePublicThreads",
  "EmbedLinks", "AttachFiles", "ReadMessageHistory", "AddReactions", "MentionEveryone", "UseExternalEmojis",
  "KickMembers", "BanMembers", "ModerateMembers", "ViewAuditLog", "CreateInstantInvite", "MoveMembers", "MuteMembers", "SendPolls"];

export const inviteLink = (id, perms = bits(["Administrator"])) =>
  `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=${perms}`;

const NEW_BOT_STEPS = [
  "Open https://discord.com/developers/applications and sign in with your Discord account.",
  "Click New Application, give it a name (that becomes the bot's name) and accept the terms.",
  "Optional: in General Information, upload an icon (the bot's avatar).",
  "Open the Bot tab and click Reset Token, then Copy. This token is the bot's password: never share it or paste it in a chat.",
  "Optional, same tab: turn on Server Members Intent so member lists work.",
  "Back in Claude: add_bot opens a private box or a one-time page on this computer to paste the token.",
];

/** One bot's report: servers, permissions, role position, intents. Runs with that bot's token. */
async function checkBot(x) {
  if (x.error) return { bot: x.bot.name, ok: false, todo: [`This bot's token does not work (${x.error}). Reset it in the Developer Portal and add it again with add_bot.`] };
  const token = x.bot.token;
  const app = await api("GET", "/oauth2/applications/@me", undefined, { token }).catch(() => null);
  const appId = app?.id || x.user.id;
  const flags = app?.flags || 0;
  const membersIntent = Boolean(flags & (1 << 14) || flags & (1 << 15));
  const todo = [];
  const servers = [];
  if (!x.servers.length) todo.push(`${x.bot.name} is in no server yet. Add it with ${inviteLink(appId)}`);
  for (const g of x.servers) {
    const [roles, m, info] = await Promise.all([
      api("GET", `/guilds/${g.id}/roles`, undefined, { token }), api("GET", `/guilds/${g.id}/members/${x.user.id}`, undefined, { token }),
      api("GET", `/guilds/${g.id}`, undefined, { token }).catch(() => ({}))]);
    if (info.mfa_level === 1) {
      todo.push(`${g.name} requires 2FA for moderation. People adding a bot or doing admin actions there need 2FA on their own Discord account, and for ${x.bot.name} to ban, kick, delete messages or manage channels, the account that owns its application must have 2FA (User Settings > My Account > Enable Two-Factor Auth).`);
    }
    let perms = BigInt(roles.find((r) => r.id === g.id).permissions);
    for (const r of roles) if (m.roles.includes(r.id)) perms |= BigInt(r.permissions);
    const names = permNames(perms.toString());
    const admin = names.includes("Administrator");
    const top = topRole(roles, m.roles);
    const above = roles.filter((r) => !r.managed && r.id !== g.id && (!top || !roleAbove(top, r))).map((r) => r.name);
    const missing = admin ? [] : RECOMMENDED.filter((p) => !names.includes(p));
    if (missing.length) todo.push(`${g.name}: ${x.bot.name} lacks ${missing.join(", ")}. Give its role Administrator or these permissions.`);
    if (above.length) todo.push(`${g.name}: ${x.bot.name} cannot manage the roles ${above.join(", ")} (above its own role). Drag its role higher in Server Settings > Roles if it should manage them.`);
    servers.push({ name: g.name, id: g.id, members: g.approximate_member_count, bot_is_admin: admin, requires_2fa: info.mfa_level === 1 || undefined,
      missing_permissions: missing.length ? missing : undefined, roles_above_bot: above.length ? above : undefined });
  }
  if (!membersIntent) todo.push(`Optional: turn on Server Members Intent for ${x.bot.name} (Developer Portal > Bot) so member lists and counts work.`);
  return {
    bot: x.bot.name, bot_id: x.user.id, active: x.bot === activeBot(), saved_in: x.bot.source,
    ok: !todo.some((t) => !t.startsWith("Optional")), servers,
    invite_link: inviteLink(appId), invite_link_limited: inviteLink(appId, bits(RECOMMENDED)), todo,
  };
}

/** The setup report, used by setup_check and by `discord-server-mcp check`. */
export async function setupCheck(_args, { mcp } = {}) {
  const handles = mcp ? packHandles.get(mcp) || {} : {};
  const settings = {
    version: VERSION, write_mode: config.writeMode, confirm_permanent_actions: config.confirmDestructive,
    allowed_servers: config.allowedGuilds || "all",
    bot_status: config.presence.enabled ? `${config.presence.status}${config.presence.text ? `, ${config.presence.type} "${config.presence.text}"` : ""}` : "offline",
    tools: Object.fromEntries(Object.entries(registered).map(([g, list]) => [g,
      g === "core" ? `${list.length}, always on` : `${list.length}, ${handles[g]?.some((h) => h.handle.enabled) ? "on" : "off (enable_tools)"}`])),
    files: { bots: BOTS_FILE, settings: SETTINGS_FILE },
  };
  if (!config.bots.length) {
    return { ok: false, bots: [], settings, next: "No bot is set up yet.", how_to_create_a_bot: NEW_BOT_STEPS };
  }
  const bots = [];
  for (const x of await botsWithServers()) bots.push(await checkBot(x));
  return { ok: bots.every((b) => b.ok), bots, settings };
}

/** Checks a token with Discord and saves the bot. */
async function saveNewBot(rawToken, label) {
  const token = rawToken.trim().replace(/^Bot\s+/i, "");
  if (token.length < 50) return { ok: false, message: "That does not look like a bot token (it is about 70 characters). Copy it again from the Bot tab." };
  let user;
  try {
    user = await api("GET", "/users/@me", undefined, { token });
  } catch {
    return { ok: false, message: "Discord did not accept that token. Click Reset Token again, copy the new one and retry." };
  }
  const bot = addBot({ token, id: user.id, name: label || user.username });
  if (config.bots.length === 1) saveSettings({ DISCORD_ACTIVE_BOT: bot.id });
  startPresence();
  const servers = await api("GET", "/users/@me/guilds", undefined, { token }).catch(() => []);
  return { ok: true, report: {
    added: true, bot: bot.name, servers: servers.map((s) => s.name),
    next: servers.length ? "Run setup_check to see if anything needs fixing."
      : `The bot is in no server yet. To add it to a server you manage, open: ${inviteLink(user.id)} (choose the server, keep Administrator, Authorize). For a new server, create it in Discord first (+ > Create My Own), then open the link.`,
  } };
}

export default function register(t) {
  const tool = t("setup");

  tool("setup_check",
    "Start here. Shows every configured bot with the servers it is in, what to fix (permissions, role position, intents), invite links, and this tool's settings. With no bot yet it gives the steps to create one.",
    {}, setupCheck, READ);

  tool("list_bots", "List the configured bots, which one is used by default, and how many servers each is in.", {}, async () => {
    const list = await botsWithServers();
    return {
      bots: list.map((x) => ({ name: x.bot.name, id: x.user?.id, default: x.bot === activeBot(), servers: x.servers?.map((s) => s.name),
        error: x.error, saved_in: x.bot.source })),
      note: "Tools pick the bot that is in the server you name; the default bot is used when no server is named.",
      how_to_create_a_bot: list.length ? undefined : NEW_BOT_STEPS,
    };
  }, READ);

  tool("add_bot",
    "Add a Discord bot (several are supported) without the token ever going through the chat. method \"box\" (default) asks the app to show a private input box; if the app cannot, or the box is closed, it opens a one-time page on this computer (a http://127.0.0.1 link) where the user pastes the token in their browser. The token is checked and saved, and the bot can be used at once. Call it after the user created the bot (setup_check has the steps).", {
      label: z.string().optional().describe("Name to remember the bot by; default: the bot's username"),
      method: z.enum(["box", "browser"]).default("box").describe("browser = skip the box and give the page link straight away"),
    }, async ({ label, method }, { mcp }) => {
      if (method === "box" && mcp.server.getClientCapabilities()?.elicitation) {
        let answer;
        try {
          answer = await mcp.server.elicitInput({
            message: "Paste the bot token (Developer Portal > your app > Bot > Reset Token > Copy). It is saved on this computer only and never shown in the chat.",
            requestedSchema: { type: "object", properties: { token: { type: "string", title: "Bot token" } }, required: ["token"] },
          });
        } catch {
          answer = null;
        }
        if (answer?.action === "accept" && answer.content?.token) {
          const result = await saveNewBot(String(answer.content.token), label);
          if (result.ok) return result.report;
          return { added: false, note: result.message };
        }
      }
      // Fallback that works everywhere: a one-time page on this computer.
      const pageResult = await startTokenPage(async (token, pageLabel) => {
        const r = await saveNewBot(token, pageLabel || label);
        return { ok: r.ok, message: r.ok ? `${r.report.bot} is connected` : r.message };
      }, { label: label || "" });
      return {
        added: false,
        open_this_link: pageResult.url,
        tell_the_user: "Open this link in your browser on this same computer, paste the token there and click Save. Then come back and say done. (The page works for 15 minutes; never paste the token in the chat.)",
        then: "When the user says done, call list_bots to confirm.",
        terminal_alternative: `node "${process.argv[1]}" init`,
      };
    });

  tool("use_bot", "Choose the default bot (used when a request does not name a server). Tools still pick the right bot automatically when a server is named.", {
    bot: z.string().describe("Bot name or id from list_bots"),
  }, async ({ bot }) => {
    const b = findBot(bot);
    if (!b) throw new DiscordError(`No bot "${bot}". Bots: ${config.bots.map((x) => x.name).join(", ") || "none"}`);
    config.activeBot = b.id || b.name;
    saveSettings({ DISCORD_ACTIVE_BOT: config.activeBot });
    return { default_bot: b.name };
  });

  tool("remove_bot", "Forget a saved bot on this computer (the bot itself stays on Discord and in its servers).", {
    bot: z.string(),
  }, async ({ bot }) => {
    const b = findBot(bot);
    if (!b) throw new DiscordError(`No bot "${bot}".`);
    if (callContext.getStore()?.dryRun) return { would_remove: b.name };
    if (!removeBot(b)) throw new DiscordError(`${b.name} comes from ${b.source}; remove it there.`);
    return { removed: b.name, note: "Restart the app to disconnect it." };
  }, DESTRUCTIVE);

  tool("set_server_bot",
    "Choose which bot to use in a server that several configured bots are in (saved on this computer). \"auto\" goes back to the default bot.", {
      server: z.string().describe("Server name or id"), bot: z.string().describe('Bot name or id, or "auto"'),
    }, async ({ server: s, bot }) => {
      const all = await botsWithServers();
      const hits = all.filter((x) => x.servers?.some((g) => g.id === s || g.name.toLowerCase() === s.toLowerCase()));
      if (!hits.length) throw new DiscordError(`No configured bot is in "${s}".`);
      const g = hits[0].servers.find((x) => x.id === s || x.name.toLowerCase() === s.toLowerCase());
      const map = { ...config.serverBots };
      if (bot === "auto") delete map[g.id];
      else {
        const b = findBot(bot);
        if (!b) throw new DiscordError(`No bot "${bot}".`);
        if (!hits.some((x) => x.bot === b)) throw new DiscordError(`${b.name} is not in ${g.name}. Bots there: ${hits.map((x) => x.bot.name).join(", ")}`);
        map[g.id] = b.id || b.name;
      }
      config.serverBots = map;
      saveSettings({ DISCORD_SERVER_BOTS: Object.keys(map).length ? JSON.stringify(map) : "" });
      return { server: g.name, bot: bot === "auto" ? "automatic (default bot)" : findBot(bot).name, bots_in_server: hits.map((x) => x.bot.name) };
    });

  tool("bot_invite_link", "The link that adds a bot to a server the user manages (Administrator by default, or chosen permissions).", {
    bot: z.string().optional().describe("Bot name or id; default bot if empty"),
    permissions: z.array(z.string()).optional(),
  }, async ({ bot, permissions }) => {
    const b = bot ? findBot(bot) : activeBot();
    if (!b) throw new DiscordError("No bot yet. Use add_bot first.");
    const id = b.id || (await me(b.token)).id;
    return { bot: b.name, link: inviteLink(id, bits(permissions?.length ? permissions : ["Administrator"])),
      steps: "Open the link, pick the server (you need Manage Server there), keep the permissions, click Authorize." };
  }, READ);

  tool("enable_tools",
    `Turn on more Discord tools for this conversation. Only the core tools are on at first; call this as soon as a task needs one of these packs: ${Object.entries(PACKS).map(([k, v]) => `${k} (${v.about})`).join("; ")}.`, {
      packs: z.array(z.enum(["all", ...Object.keys(PACKS)])).min(1),
    }, async ({ packs }, { mcp }) => {
      const names = packs.includes("all") ? Object.keys(PACKS) : packs;
      const added = enablePacks(mcp, names);
      return {
        enabled: names,
        note: "These tools are on now. If this app does not show them yet, call them through use_tool with the parameters below (same result). To have them from the start, use configure tool_groups and restart the app.",
        // Full parameters only for a few packs, to keep the answer short; enable fewer packs to see them.
        tools: names.length <= 3 ? describePackTools(mcp, names) : describePackTools(mcp, names).map((t) => t.name),
        newly_enabled: added.length,
      };
    }, READ);

  tool("use_tool",
    "Call a Discord tool from a pack by name, with its arguments. Use it when enable_tools turned a pack on but this app does not show the new tools yet.", {
      tool: z.string().describe("Tool name, e.g. create_role_menu"),
      arguments: z.record(z.string(), z.any()).default({}),
    }, async ({ tool: name, arguments: args }, { mcp }) => {
      const h = packTool(mcp, name);
      if (!h) throw new DiscordError(`No tool "${name}" in the packs. Core tools are called directly.`);
      const parsed = z.object(h.shape).safeParse(args);
      if (!parsed.success) throw new DiscordError(`Wrong arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      if (!h.handle.enabled) h.handle.enable();
      const res = await h.run(parsed.data);
      if (res.isError) throw new DiscordError(res.content.map((c) => c.text).join("\n"));
      return res.content.map((c) => c.text).join("\n");
    });

  tool("configure",
    "Only when the user asks: change this Discord tool's own settings and save them on this computer: write mode, allowed servers, tool packs on at start, confirmation for permanent actions, default server and the bots' status. Most apply at once; tool groups, read-only mode and the status apply after restarting the app.", {
      write_mode: z.enum(["full", "preview", "readonly"]).optional(),
      allowed_servers: z.array(z.string()).optional().describe("Server ids; [] = all"),
      tool_groups: z.array(z.enum(["all", ...Object.keys(PACKS)])).optional().describe('Extra tool packs to have on from the start (the core tools are always on); ["all"] = every tool, [] = core only'),
      confirm_permanent_actions: z.boolean().optional(),
      default_server: z.string().optional().describe('Server id; "" = none'),
      status_text: z.string().optional().describe('Bot activity text, e.g. the server name; "" = none'),
      status_type: z.enum(["playing", "listening", "watching", "competing", "custom"]).optional(),
      status: z.enum(["online", "idle", "dnd", "invisible"]).optional(),
      online: z.boolean().optional().describe("false = the bots stay offline"),
    }, async (a) => {
      const map = {
        DISCORD_WRITE_MODE: a.write_mode, DISCORD_ALLOWED_GUILDS: a.allowed_servers?.join(","),
        DISCORD_TOOLSETS: a.tool_groups?.join(","), DISCORD_CONFIRM_DESTRUCTIVE: a.confirm_permanent_actions === undefined ? undefined : a.confirm_permanent_actions ? "on" : "off",
        DISCORD_GUILD_ID: a.default_server, DISCORD_PRESENCE_TEXT: a.status_text, DISCORD_PRESENCE_TYPE: a.status_type,
        DISCORD_PRESENCE_STATUS: a.status, DISCORD_PRESENCE: a.online === undefined ? undefined : a.online ? "on" : "off",
      };
      const changes = Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined));
      if (!Object.keys(changes).length) throw new DiscordError("Nothing to change.");
      const overridden = Object.keys(changes).filter(fromEnvironment);
      saveSettings(changes);
      if (a.write_mode && a.write_mode !== "readonly" && config.writeMode !== "readonly") config.writeMode = a.write_mode;
      if (a.allowed_servers) config.allowedGuilds = a.allowed_servers.length ? a.allowed_servers : undefined;
      if (a.confirm_permanent_actions !== undefined) config.confirmDestructive = a.confirm_permanent_actions;
      if (a.default_server !== undefined) config.defaultGuild = a.default_server || undefined;
      return {
        saved_to: SETTINGS_FILE, changed: Object.keys(changes),
        restart_needed: Boolean(a.tool_groups || a.write_mode === "readonly" || (config.writeMode === "readonly" && a.write_mode)
          || a.status_text !== undefined || a.status_type || a.status || a.online !== undefined),
        ignored_because_set_in_environment: overridden.length ? overridden : undefined,
      };
    });
}
