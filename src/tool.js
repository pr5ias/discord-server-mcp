// Registers tools with shared behaviour: JSON results, errors as text, dry runs, write modes and tool groups.
import { z } from "zod";
import { config } from "./config.js";
import { callContext, botNameOf } from "./discord.js";
import { findBot } from "./config.js";

export const READ = { readOnlyHint: true };
export const DESTRUCTIVE = { destructiveHint: true };

/**
 * Tool packs. "core" (everything not listed here) is always on; the others start off so the model sees
 * fewer tools, and enable_tools turns them on when a task needs them (DISCORD_TOOLSETS=all: everything).
 */
export const PACKS = {
  automations: { about: "role menus, welcome messages with auto-roles, support tickets and their history, the server's own slash commands, staff slash commands (/ban, /lock, /purge…), moderation logs and searching them, staff alerts, support forums, rules (when X happens do Y), member verification, scheduled messages",
    tools: ["create_role_menu", "set_welcome", "create_ticket_panel", "create_command", "set_mod_log", "set_staff_alerts", "enable_staff_commands",
      "search_mod_log", "ticket_history", "set_support_forum", "create_rule", "create_verification", "schedule_message",
      "edit_automation", "list_automations", "remove_automation"] },
  live: { about: "what is happening now, waiting for a reply, mention or join",
    tools: ["events_status", "get_events", "wait_for_event"] },
  jobs: { about: "background jobs: message backups and restores, roles for many members at once",
    tools: ["list_jobs", "cancel_job", "resume_job", "bulk_role_update", "backup_messages", "restore_messages"] },
  moderation: { about: "AutoMod, locking channels, purging messages, bans list, pruning, audit log, role audit, member export",
    tools: ["lock_channel", "unlock_channel", "purge_messages", "list_automod_rules", "create_automod_rule", "delete_automod_rule",
      "prune_members", "audit_roles", "get_audit_log", "list_bans", "unban_user", "edit_member", "reorder_roles", "export_members"] },
  messaging: { about: "webhooks (post with another name), DMs, pins list, announcements publishing, polls and reactions results",
    tools: ["list_webhooks", "create_webhook", "delete_webhook", "send_webhook_message", "edit_webhook_message", "send_dm",
      "list_pins", "publish_message", "end_poll", "list_reactions", "poll_results"] },
  organizing: { about: "cloning channels, more forum tags, threads, following announcement channels, copying and syncing permissions",
    tools: ["clone_channel", "add_forum_tags", "list_threads", "edit_thread", "follow_announcement_channel", "sync_permissions", "copy_permissions"] },
  server_settings: { about: "onboarding, welcome screen, invites list, server stats and activity, bot profile, creating or leaving servers",
    tools: ["get_onboarding", "edit_onboarding", "edit_welcome_screen", "list_invites", "delete_invite", "server_stats", "channel_activity",
      "edit_bot_profile", "create_server", "leave_server"] },
  expressions: { about: "emojis, stickers, soundboard, scheduled events, stage, application commands",
    tools: ["list_emojis", "create_emoji", "delete_emoji", "create_sticker", "delete_sticker", "list_sounds", "create_sound", "delete_sound",
      "list_events", "create_event", "edit_event", "delete_event", "start_stage", "end_stage", "list_commands", "delete_command"] },
  api: { about: "direct Discord API calls for anything else", tools: ["discord_api"] },
};
const PACK_OF = Object.fromEntries(Object.entries(PACKS).flatMap(([p, v]) => v.tools.map((t) => [t, p])));
const ALIASES = { automation: "automations", events: "live" };

/** Packs switched on at start: DISCORD_TOOLSETS lists them, "all" turns on everything. */
export function startPacks() {
  const list = (config.toolsets || []).map((x) => ALIASES[x] || x);
  if (list.includes("all")) return new Set(Object.keys(PACKS));
  return new Set(list.filter((x) => PACKS[x]));
}

/** Names of the registered tools, by pack (for setup_check and docs). */
export const registered = {};

/** The pack handles of one MCP server, so enable_tools can switch them on. */
export const packHandles = new WeakMap();

/** The pack tool called name on this MCP server, or undefined. */
export function packTool(mcp, name) {
  return Object.values(packHandles.get(mcp) || {}).flat().find((h) => h.name === name);
}

/** Short description and parameters of pack tools, for clients that do not refresh their tool list. */
export function describePackTools(mcp, names) {
  const handles = packHandles.get(mcp) || {};
  return names.flatMap((n) => handles[n] || []).map((h) => {
    const schema = z.toJSONSchema(z.object(h.shape), { io: "input" });
    return { name: h.name, description: h.description.split(". ")[0], parameters: schema.properties, required: schema.required };
  });
}

/** Turns packs on for one MCP server; returns the tools that became available. */
export function enablePacks(mcp, names) {
  const handles = packHandles.get(mcp) || {};
  const added = [];
  for (const n of names) for (const h of handles[n] || []) {
    if (!h.handle.enabled) {
      h.handle.enable();
      added.push(h.name);
    }
  }
  return added;
}

export function registrar(mcp, group) {
  const on = startPacks();
  return function tool(name, description, shape, handler, annotations = {}) {
    const pack = PACK_OF[name] || "core";
    const write = !annotations.readOnlyHint;
    if (write && config.writeMode === "readonly" && group !== "setup") return;
    const guarded = annotations.destructiveHint && config.confirmDestructive;
    const inputSchema = write
      ? { ...shape, dry_run: z.boolean().optional().describe("Show the requests that would be made without changing anything") }
      : shape;
    if (group !== "setup") {
      inputSchema.bot = z.string().optional().describe("Use this bot (name or id) instead of choosing automatically");
    }
    if (guarded) inputSchema.confirm = z.boolean().optional().describe("Must be true to really do this permanent action; without it you get a preview");
    if (!(registered[pack] ||= []).includes(name)) registered[pack].push(name);
    const run = async (args = {}) => {
      const needsConfirm = guarded && args.confirm !== true;
      const dryRun = write && (config.writeMode === "preview" || args.dry_run === true || needsConfirm);
      const ctx = { dryRun, planned: [] };
      try {
        if (args.bot) {
          const b = findBot(args.bot);
          if (!b) throw new Error(`No bot "${args.bot}". Bots: ${config.bots.map((x) => x.name).join(", ")}`);
          ctx.token = b.token;
        }
        const result = await callContext.run(ctx, () => handler(args, { mcp }));
        const out = dryRun
          ? { dry_run: true,
              note: needsConfirm && config.writeMode !== "preview" && args.dry_run !== true
                ? "This action is permanent, so nothing was changed yet. Show this to the user and, once they agree, call again with confirm: true."
                : "Nothing was changed. These are the requests that would be sent.",
              would_send: ctx.planned, if_applied: result }
          : result;
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        const content = [{ type: "text", text: text ?? "done" }];
        // Say which bot did it, so the right one is always visible.
        if (ctx.serverName && config.bots.length > 1) {
          const who = botNameOf(ctx.token) || "the default bot";
          const others = ctx.otherBots?.length ? ` (${ctx.otherBots.join(", ")} ${ctx.otherBots.length > 1 ? "are" : "is"} also in this server; pass bot to use another)` : "";
          content.push({ type: "text", text: `Acting as ${who} in ${ctx.serverName}${others}.` });
        }
        return { content };
      } catch (e) {
        const extra = dryRun && ctx.planned.length ? `\n(dry run; planned so far: ${JSON.stringify(ctx.planned)})` : "";
        return { isError: true, content: [{ type: "text", text: String(e?.message || e) + extra }] };
      }
    };
    const handle = mcp.registerTool(
      name,
      { description: write && config.writeMode === "preview" ? `${description} (Preview mode: changes are only shown, never applied.)` : description,
        inputSchema, annotations: { ...annotations, readOnlyHint: !write, ...(write ? {} : { destructiveHint: false }) } },
      run,
    );
    if (pack !== "core") {
      const handles = packHandles.get(mcp) || {};
      (handles[pack] ||= []).push({ name, handle, run, shape: inputSchema, description });
      packHandles.set(mcp, handles);
      if (!on.has(pack)) handle.disable();
    }
  };
}
