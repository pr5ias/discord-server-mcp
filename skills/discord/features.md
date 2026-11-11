# Choosing features

The user decides what the bot does. Never set up a feature they did not pick, never pick a variant for them when there is a real choice, and keep the server as simple as they want: a small group of friends may want nothing at all. Use this file whenever the user wants automations, moderation help or staff tools, inside the build wizard or on their own.

## 1. What do you want?

Ask with AskUserQuestion, multiSelect, in plain words and in the user's language. Nothing is pre-selected; "Nothing for now" is always fine. Mark at most one option "(Recommended)", and only when the server's purpose and size clearly call for it (for example a moderation log for a public server).

First question, "What should the bot do for members?":
- **Welcome and verification**: a message and/or a role when someone joins, or an "I accept the rules" button before they see the server.
- **Let members pick roles**: buttons or a dropdown for pings, colours, games or languages.
- **Support**: private tickets, a support forum with Open/Solved tags, or both.
- **Automatic answers and messages**: commands like `/rules`, rules that react to words or events, scheduled announcements.

Second question, "What should it do for the staff?":
- **Moderation log**: a record of deleted/edited messages, joins, bans, timeouts…
- **Alerts**: tell the staff right away when something serious happens.
- **Staff commands in Discord**: `/ban`, `/lock`, `/purge`… without opening Claude.
- **Search past events**: needs the moderation log.

Then ask the language for everything the bot writes to members, unless already known. Built in: English, Português (Portugal), Português (Brasil), Español, Français, Deutsch, Italiano, Русский, 日本語, 中文 (简体), 한국어, Polski, Türkçe, or the server's Discord language. For any other language, write the texts with the user and pass them as `texts`.

## 2. Details, only for what was picked

Ask only the questions whose answer changes what gets built, at most four per AskUserQuestion, and skip any the user already answered. Offer the common choice first.

- **Welcome**: where (a channel, a DM, or both); the text (draft it and show it); a role on join (which).
- **Verification** (`create_verification`): which channel; which role it gives (and one it removes, if any); the rules: write them with the user (`rules`), point to their rules channel (`rules_channel`), or none (then the button just says "Enter the server"); whether the rest of the server stays hidden until they accept (say clearly this changes who sees each public channel).
- **Role menu**: which roles (existing or new); one at a time or several; buttons, a dropdown (tidier for many roles) or reactions; where.
- **Support: tickets, forum or both**: ask which. Tickets suit private matters (reports, payments); a forum suits public questions others can search later. Both together is common.
- **Tickets**:
  - who handles them (staff roles);
  - where open tickets go: a "Tickets" category only while tickets are open (`category_only_when_open: true`), always visible, or no category;
  - whether the staff get a ticket channel (`log_channel`, made private to them): a line when a ticket opens (with the Claim button, so only staff see it), when someone claims it, and when it closes with the transcript; or only keep transcripts on this computer;
  - whether staff are pinged when one opens;
  - whether staff can claim tickets (`claim_button`).
- **Moderation log**:
  - what to record (multiSelect): messages deleted/edited · members joining/leaving · bans, kicks, timeouts, role and nickname changes · channels and roles created/deleted;
  - how it is shown: one channel · one channel per kind (message-log, member-log, mod-log) · a forum with one post per member and tags per kind, best for filtering by member and kind;
  - channels to leave out.
- **Alerts**: for what (bans, kicks, timeouts, AutoMod blocks, raids); how (ping a role in a staff channel, DM chosen people, or both); for raids, how many joins in how long.
- **Staff commands**: the names (English, translated to each member's Discord language, or one language for everyone: `command_names`); which groups (multiSelect): members (`/ban`, `/kick`, `/timeout`, `/untimeout`, `/unban`) · channels (`/lock`, `/unlock`, `/slowmode`, `/purge`) · roles and announcements (`/role`, `/announce`) · tickets (`/ticket`) · log search (`/modlog`). Pass only those as `commands`.
- **Support forum** (`set_support_forum`): which forum (or create one); who handles posts; tag names (Open, In progress, Solved by default); whether staff get a channel with updates (with the Claim button); whether solved posts are locked; whether idle posts close after some days; the welcome line.
- **Fixed-answer commands**: names and texts (draft them). If members speak several languages, offer translations of the name, description and answer (`translations`), so each member sees them in their Discord language.
- **Rules** (`create_rule`): ask for each rule in plain words, "when … then …", and turn it into the trigger (a message with words or a pattern, a link, a file; a member joining; a reaction) and the actions (reply, send, DM, give or take a role, delete, react, timeout), with channels or roles it applies to or skips (usually skip the staff) and a cooldown. Read each rule back in plain words before creating it.
- **Scheduled messages** (`schedule_message`): the text, the channel, the first date and time, the time zone, whether it repeats (every N hours, days, weeks, months) and until when, any role ping.

Every text members or staff see can be changed: offer it when showing the plan ("want to change any of these texts?"), pass them as `texts`, and later use `edit_automation`.

## 3. Plan, then build

Show one short plan with every feature and its choices, the channels and roles it will create, and the texts members will see. Ask: **Build it** · **Change something** · **Cancel**. Build only after "Build it", with exactly those choices (turn on the `automations` pack first with `enable_tools`). Then say in one line that these run while the app is open, and offer `discord-server-mcp run` or Docker only if the user wants them around the clock.

Later changes follow the same rule: ask what to change, show the new plan, then act.
