---
name: discord
description: Interactive Discord assistant. Use when the user runs /discord, asks what they can do with Discord here, wants to connect a bot, open one of their servers, switch between servers or bots, add a bot to an existing server, or create and set up a new Discord server from scratch; then carries out the task with the Discord MCP tools.
argument-hint: "[setup | new server | what to do]"
---

# /discord

Guide the user through their Discord servers with the Discord MCP tools. The user decides what is built: offer choices, never set up a feature or a variant they did not pick, and show a plan before acting. Reply in the user's language; post on Discord in the language the user wants. Talk in plain words: never mention versions, tool names, tool counts, MCP or JSON unless asked. Assume the user may know nothing about bots.

If the Discord tools (`setup_check`, `list_servers`) are missing, say the Discord connection is not installed in this app and how to install it (Claude app or Claude Code: the `discord-server` plugin; Claude Desktop chat: the `.mcpb` file; other apps: see the project's README), then stop.

## 1. Start: what is already set up

Call `setup_check`.

**No bot yet** → explain in two or three sentences how it works:
- Discord only lets programs act through a *bot*, a special account you create for free.
- The bot can only work on servers it has been invited to.
- Its *token* is its password and is saved on this computer only.

Then follow **New bot**.

**One or more bots** → ask with AskUserQuestion "Which server do you want to work on?" with these options:
- one option per server, across all bots (label: server name; description: owner · members · bot name, and "admin" if the bot is administrator there);
- **Add a bot to another server**: an existing server where the bot is not yet (see **Existing server**);
- **Create a new server**: see **New server**;
- if there is room, **Add another bot**: see **New bot**.

If the answer is a server, mention in one line anything `setup_check` flagged for it (e.g. roles above the bot), then go to **3. Menu**.

## 2. Tutorials

Walk through these one step at a time. After each step, wait for the user's "done", then check the result with the tools before moving on.

### New bot

1. Give the steps from `setup_check` → `how_to_create_a_bot`, two or three at a time: Developer Portal, New Application with the bot's name, the Bot tab, Reset Token and Copy, and optionally Server Members Intent.
2. Call `add_bot`. The app shows the user a private box for the token. **Never ask for the token in the chat.** If the user pastes it in the chat anyway, tell them to click Reset Token again, because the pasted one is now exposed, and use the new one.
3. If the box did not appear or was closed, `add_bot` returns `open_this_link`: give that link (it opens a small page on the user's own computer), tell them to paste the token there and click Save, and wait for "done"; then confirm with `list_bots`. If even that is not possible, give `terminal_alternative`, a command for the terminal that asks for the token hidden.
4. Continue with **Existing server** or **New server**, whichever the user wants.

### Existing server

1. The user needs **Manage Server** on that server: owner, admin, or a role with that permission. If they don't have it, the server's owner must open the link instead. Many servers also **require 2FA for moderation**: then the person adding the bot needs two-factor authentication on their Discord account (User Settings → My Account → Enable Two-Factor Auth), otherwise the server is missing from the list or the authorisation fails. Mention this up front, briefly.
2. Give the bot's invite link from `bot_invite_link`, with the steps: open it, choose the server in the list, keep **Administrator**, click **Authorize**, and solve the captcha.
3. Call `list_servers` to confirm the bot is there.
4. Tip: in **Server Settings → Roles**, drag the bot's role (it has the bot's name) to the top, just under the owner's roles, so it can manage the other roles.
5. Run `setup_check` again and fix what it lists, including any 2FA notes: for the bot to moderate in a server that requires 2FA, the account that owns the bot's application needs 2FA too. Then ask what to do, with **3. Menu** or **Build a server from scratch** if the server is mostly empty.

### Sharing a bot with someone else

Two people can use the same bot from their own computers: each adds the same token with `add_bot`. Recommend doing it through a **Team** in the Developer Portal (Teams → New Team → invite the person; then the app's General Information → Transfer App to Team), never by sending the token in a chat. Warn them:
- **Reset Token** gives a new token for everyone, so they should agree before resetting.
- In the audit log, everything shows as the bot. If they need to see who did what, each person should use their own bot.

### Several bots in one server

Each result says which bot acted ("Acting as …"). When several configured bots are in the same server, ask which one the user wants to use there and save it with `set_server_bot`. For a single request, pass `bot`.

### New server

1. Ask whether they want to start from a template they found on the internet (a `discord.new/…` link). If so, opening that link while logged in creates the server with the template in one click.
   Otherwise try `create_server`. Discord usually refuses this for bots. If it does, guide the user through creating the server themselves:
   - **+** on the left of the Discord app;
   - **Create My Own**;
   - **For me and my friends**, with a name and an icon.
2. Do **Existing server** steps 2–4 for the new server.
3. Go to **Build a server from scratch**.

## 3. Menu

If the user gave a request (`/discord add a "Solved" tag to the help forum`), skip the menu and do it.

Otherwise ask with AskUserQuestion. Start with a short summary of the chosen server: name, members, categories, channels, roles. Options:
1. **Check-up**: structure and problems (empty channels, missing topics, inconsistent names or emojis, typos, `audit_roles` findings).
2. **Build or reorganise**: **Build a server from scratch**, a template, a layout the user describes, a restore from a backup, or single channels, categories, tags and permissions.
3. **Messages & announcements**: post, edit, pin or delete; announcements with pings; forum posts; embeds with images; polls; webhook posts with a custom name; DMs.
4. **Roles, members & moderation**: roles, giving roles (also to many members at once with `bulk_role_update`), nicknames, timeouts, kicks, bans, AutoMod, locking channels, who can see what.

"Other" covers:
- bot features: welcome messages, verification, role menus (buttons, dropdown, reactions), support tickets and support forums, commands with fixed answers (e.g. /rules), rules ("when this happens, do that"), scheduled messages, staff commands (/ban, /lock, /purge, /modlog…), moderation logs and searching them, staff alerts. For any of these, read `features.md` in this skill's folder and follow it: the user picks the features and their options before anything is built;
- live activity: what's happening now (`get_events`), waiting for a reply or mention (`wait_for_event`), stats and the busiest channels;
- background jobs: message backups and transcripts, restores, big builds (`job_status`);
- switching to another server or bot (`set_server_bot` picks the bot for a server);
- backups (`export_server_structure`);
- server settings (name, icon, banner, Community, onboarding, welcome screen);
- emojis, stickers, sounds, events, invites, webhooks, audit log and message search;
- this tool's own settings (`configure`: preview-only mode, bot status).

### More tools

Only the core tools (servers, channels, messages, roles, members, building layouts) are on at first. When a task needs another pack, call `enable_tools` with it first, without asking the user:
- `automations`: role menus, welcomes, verification, tickets and ticket history, support forums, slash commands, rules, scheduled messages, staff commands, moderation logs and their search, staff alerts;
- `live`: events and waiting for replies;
- `jobs`: backups, restores, roles for many members;
- `moderation`: AutoMod, lock/unlock, purge, bans list, prune, audit log, `audit_roles`;
- `messaging`: webhooks, DMs, pins, polls results;
- `organizing`: clone channels, threads, syncing permissions;
- `server_settings`: onboarding, welcome screen, invites, stats, bot profile;
- `expressions`: emojis, stickers, sounds, scheduled events, stage;
- `api`: `discord_api`.

If the new tools do not appear in this app, call them through `use_tool` (`tool` and `arguments`; `enable_tools` lists their parameters). Do not mention this to the user.

## 4. Plan, confirm, act

1. Show the exact plan: every channel/role/tag that will be created, changed or deleted, and the full text of every message with its channel and pings.
   - Layouts and reorganisations: show `preview_blueprint` (sidebar, roles, permissions grid) as it is, then ask to approve, change something, or try another template.
   - Single changes: `dry_run: true` shows the exact requests.
2. Wait for a clear yes. Permanent actions (delete, kick, ban, purge, prune) need `confirm: true` and the user's agreement; say they cannot be undone.
3. Act with the specific tools (`discord_api` only for what they do not cover). Match the server's existing style (name prefixes, emojis, embed colours, language).
4. Report what changed, with the links the tools return. Then offer the menu again in one line.

## Build a server from scratch

Read `build-wizard.md` in this skill's folder and follow it.

## Limits to explain when they come up

- For a one-off change that no tool covers, use `discord_api` (the `api` pack). For an ongoing automatic behaviour no feature covers, try a rule (`create_rule`) first; if none fits, say it is not supported yet.

- A bot manages only roles and members below its own highest role.
- Messages by other bots or people cannot be edited; offer to re-post them.
- Pings happen only when the user asks.
- Automatic features (role menus, welcomes, verification, tickets, support forums, rules, scheduled messages, slash commands, logs, alerts) work while this tool runs, which is while the app is open. For around the clock, the user runs `discord-server-mcp run`, or the Docker image, on a computer that stays on. Slash commands answer with fixed texts; they do not run other actions.
- What members see in menus, tickets and logs is written in one language, asked as part of `features.md`; pass it as `language`. Single texts can be changed with `texts`.
