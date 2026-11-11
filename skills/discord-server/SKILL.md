---
name: discord-server
description: Use when the user wants to set up, reorganise, back up or moderate a Discord server (channels, categories, forums, tags, permissions, roles, members, emojis, events, AutoMod, onboarding, server settings, templates) or post, edit, pin or delete messages, announcements, DMs and forum posts there.
---

# Working on a Discord server

1. Call `get_server` first and use the names and ids it returns. Several bots may be configured; tools use the bot that is in the server you name (`list_servers` shows them all). If a tool fails for setup reasons, call `setup_check` and follow its todo list; new bots are added with `add_bot` (private token box).
2. Before any change or message, show the user exactly what will happen (names, categories, permissions, full message text, pings) and wait for a clear yes. Use `dry_run: true` or `apply_blueprint` `mode: "plan"` to preview. Permanent actions need `confirm: true` and the user's agreement.
3. For a new or empty server, follow `../discord/build-wizard.md`. To build or reorganise many things at once, show `preview_blueprint` first (as it is), let the user approve or change it, then use `apply_blueprint` (templates, a layout you write, or a backup) over many single calls; it only creates what is missing and can be re-run to continue.
4. Before big changes, offer a backup with `export_server_structure` (`save_to` a file).
5. Match the server's existing style: channel name prefixes and emojis, embed colours, language.
6. Only ping when the user asks (`ping_roles`, `ping_users`, `ping_everyone`).
7. Images: pass local paths or URLs in `files`, and show one in an embed with `image: "attachment://name.png"`.
8. On "Missing Permissions", explain the role order (Server Settings → Roles) or the missing channel permission; `check_permissions` shows what someone can really do.
9. Never ask for the bot token in chat. After acting, report what changed with the returned links.
10. Only the core tools are on at first. Before using a tool from another pack (automations, live, jobs, moderation, messaging, organizing, server_settings, expressions, api), call `enable_tools` with that pack; if its tools do not appear, call them through `use_tool`.
11. Live: `get_events` / `wait_for_event` show new messages, mentions, joins and clicks. Long work (big builds, many members, backups) runs as a job: start it, then report progress with `job_status`.
12. Set up only the bot features the user asked for, and ask about their options (where logs go, which commands, who gets alerts, ticket categories and transcripts) before building; show the plan first.
13. Role menus, welcomes and tickets: `create_role_menu`, `set_welcome`, `create_ticket_panel`; they run while this tool runs (or 24/7 with `discord-server-mcp run`).
