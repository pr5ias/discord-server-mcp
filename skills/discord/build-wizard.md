# Build a server from scratch

Take the user from an empty (or nearly empty) server to one that is ready for members: structure, texts, and settings. Keep it a conversation: a few questions, a plan, the build, then the finishing touches.

Before starting, offer a backup with `export_server_structure` if the server already has channels.

## Step 1: Questions

Ask with AskUserQuestion, at most four questions per call, and stop asking once the answers are clear. Typical first round:

1. **What is the server for?** Community or friends · Gaming group · Content creator · Project (a product, app, game or open-source project) · Study or class. The user can describe something else.
2. **Which languages will people speak?** One language · Two languages with separate chats (e.g. general-en and general-pt) · International (English). Ask which ones when needed. This also sets the language of everything the bot writes to members (role menus, tickets, logs, welcome and rules texts): pass it as `language` to the automations. For Portuguese, ask "Portugal or Brazil?" (`pt` or `pt-BR`); Discord only knows Brazilian Portuguese, so without `language` a Portuguese server gets Brazilian texts.
3. **Which areas do you want?** (multiSelect) Announcements & rules · Support (questions and bug reports) · Suggestions · Media/showcase · Events · Voice channels · Staff area.
4. **How big will it be?** Just friends (under 20) · Small community (20–200) · Large/public (200+). A larger server needs moderation, verification and AutoMod.

A short second round only if it matters:
- the project or brand name and its colour;
- the style of channel names (emoji prefixes like `📢-announcements` or plain `announcements`);
- the roles they want: staff levels, members, ping roles such as "Updates Ping", roles per game or language.

If the server already has channels, ask whether to keep them and add around them (default), or reorganise them into the new layout (`update_existing: true`). Never delete anything unless the user asks, and then with confirmation.

## Step 2: Choose a starting layout

Ask with AskUserQuestion "Where do you want to start from?":
- **A ready-made layout**: then ask which one, from `list_templates` (community, gaming, creator, project, study). Label each with its name in the user's language and a one-line description, and mark the one that fits the answers as "(Recommended)".
- **A template from the internet**: Discord server templates are shared as `discord.new/…` or `discord.com/template/…` links, on sites such as discords.com/templates or discordtemplates.me.
  - If the user has a link, use it.
  - If not and you can search the web, find 2–3 popular templates that match the server's purpose, and offer them with name, description and link.
  - Then load the chosen one with `import_discord_template`, which shows its name, description and how often it was used.
- **Copy one of my servers**: the structure of another server a configured bot is in (`copy_from_server`).
- **Describe my own**: build the layout from the user's description.

For a **new** server that will use an internet template, there is a faster way. When the user opens the template link while logged in, Discord itself creates the server with that template. Then they invite the bot, and you only adapt it (roles, texts, settings) from **Step 3**, using the server as it is.

## Step 3: Preview, approve or change

1. Adapt the chosen layout (template, imported template, copied server or description) to the answers from Step 1, without asking again:
   - one general chat per language;
   - only the areas the user picked;
   - the user's naming style;
   - their roles;
   - a topic for every channel;
   - read-only info channels;
   - a private staff area.
2. Call `preview_blueprint` with the adapted layout as `blueprint` and the `server`, so it also marks what already exists. To show an internet template exactly as it is, pass `discord_template` instead. Show its result to the user **as it is**: the sidebar, the topics, the roles table and the permissions grid. Don't summarise it. In an app that can draw visuals inline, you may add a picture of the sidebar, but keep the preview text.
3. Ask with AskUserQuestion:
   - **Approve and build**
   - **Change something**: the user says what, for example "rename Support to Help", "add a 🎨-art channel", "let Members post in showcase", "no voice channels";
   - **Try another template**: back to Step 2.
4. On changes, edit the layout, call `preview_blueprint` again, show it, and ask again. Repeat until the user approves. Keep the user's earlier changes when they try another template only if they ask for that.

## Step 4: Build

1. Call `apply_blueprint` with exactly the approved layout and `mode: "apply"`.
2. If a step fails, explain why in plain words, fix the cause (often the bot's role position or a missing permission), then run it again. Finished steps are skipped.
3. Confirm with `get_server`.

## Step 5: Texts

Write these in the server's language(s) and style, and show them all to the user for approval before posting:

- **Rules:** 5–8 short rules suited to the server's purpose and size, as an embed.
- **Welcome / start here:** what the server is, where to go first, how to get roles.
- **FAQ:** if there is a FAQ channel or the server is a project, 4–6 likely questions with their answers. Ask the user for any facts you don't know, such as download links or versions.
- **Links:** if the server is a project, its website, download and source.
- **First announcement:** optional, e.g. "the server is open".
- **Forum posting guidelines:** set as the forum's topic.

Post each one with `send_message` (embeds, `pin: true` for rules and welcome). Use images only if the user provides them. Ping nobody unless asked.

## Step 6: Settings and features

Ask which of these the user wants, with AskUserQuestion multiSelect, nothing pre-selected, one line each on why it helps; do only the chosen ones. Turn on the packs they need first with `enable_tools` (`server_settings` for onboarding and the welcome screen, `moderation` for AutoMod).

- **Discord's own join messages** in a system channel (`edit_server` `system_channel`, `join_messages: true`): a basic welcome with no bot running.
- **Community** (`edit_server` `community: true`, with `rules_channel` and a staff-only `public_updates_channel`), which unlocks **onboarding** questions that give roles (`edit_onboarding`) and a **welcome screen** (`edit_welcome_screen`).
- **Verification level** (`edit_server`): low for small servers, medium or high for public ones.
- **AutoMod** (`create_automod_rule`): spam, mention spam (limit around 5), optionally the profanity preset; ask where alerts go.
- **An invite link** (`create_invite`) to share.
- **Bot status** (`configure` `status_text`).

For bot features (welcome messages, role menus, tickets, commands, moderation log, alerts, staff commands), read `features.md` in this folder and follow it, in the language chosen in Step 1.

## Step 7: Hand-over

Summarise what was built (counts and the main channels), the invite link, and what is left for the user:

- uploading the server icon if they haven't;
- moving their own role to the top;
- optionally, keeping role menus, welcomes and tickets running around the clock with `discord-server-mcp run` on a computer that stays on.

Offer a backup now with `export_server_structure` and `save_to`.
