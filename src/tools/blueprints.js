// Server layouts as data: export a server's structure (backup), and build or complete a server from a layout
// (a backup, a built-in template, or one written by the assistant). Applying only creates what is missing,
// so running it again after an interruption simply continues.
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { callContext, api, guildId, bits, permNames, color, defined, server, CHANNEL_TYPES, TYPE_NAMES, DiscordError, hasNews, me } from "../discord.js";
import { overwrite, tagList } from "./channels.js";
import { TEMPLATES } from "../templates.js";
import { READ } from "../tool.js";
import { defineJob, startJob } from "../jobs.js";

const simplify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hex = (n) => (n ? "#" + n.toString(16).padStart(6, "0") : undefined);

const OverrideSchema = z.object({ target: z.string(), allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() });
const ChannelSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "announcement", "forum", "media", "voice", "stage"]).default("text"),
  topic: z.string().optional(), slowmode: z.number().int().optional(), nsfw: z.boolean().optional(),
  user_limit: z.number().int().optional(),
  tags: z.array(z.object({ name: z.string(), emoji: z.string().optional() })).optional(),
  overrides: z.array(OverrideSchema).optional(),
});
const BlueprintSchema = z.object({
  description: z.string().optional(),
  roles: z.array(z.object({
    name: z.string(), color: z.union([z.string(), z.number()]).optional(), hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(), permissions: z.array(z.string()).optional(),
    for_bots: z.boolean().optional().describe("Give this role to the bots in the server, e.g. a \"Bots\" role shown separately"),
  })).default([]),
  categories: z.array(z.object({ name: z.string(), overrides: z.array(OverrideSchema).optional(), channels: z.array(ChannelSchema).default([]) })).default([]),
  channels: z.array(ChannelSchema).default([]).describe("Channels outside any category"),
});

/** Template code from a discord.new / discord.com/template link or the bare code. */
export function templateCode(ref) {
  const m = String(ref).trim().match(/(?:discord\.new\/|discord(?:app)?\.com\/template\/)([\w-]+)/i);
  return m ? m[1] : String(ref).trim();
}

/** A Discord server template (discord.new link) converted to a blueprint. */
export async function blueprintFromDiscordTemplate(ref) {
  const code = templateCode(ref);
  const res = await fetch(`https://discord.com/api/v10/guilds/templates/${encodeURIComponent(code)}`);
  if (!res.ok) throw new DiscordError(`Could not load the Discord template "${code}" (${res.status}). Check the link; templates can be deleted by their owner.`);
  const t = await res.json();
  const src = t.serialized_source_guild || {};
  const roles = src.roles || [];
  const name = Object.fromEntries(roles.map((r) => [r.id, r.id === 0 ? "@everyone" : r.name]));
  const overrides = (list) => {
    const out = (list || []).filter((o) => name[o.id] !== undefined).map((o) => defined({
      target: name[o.id],
      allow: permNames(o.allow).length ? permNames(o.allow) : undefined,
      deny: permNames(o.deny).length ? permNames(o.deny) : undefined,
    }));
    return out.length ? out : undefined;
  };
  const types = { 0: "text", 2: "voice", 5: "announcement", 13: "stage", 15: "forum", 16: "media" };
  const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0);
  const chans = src.channels || [];
  const channel = (c) => defined({
    name: c.name, type: types[c.type] || "text", topic: c.topic || undefined, slowmode: c.rate_limit_per_user || undefined,
    nsfw: c.nsfw || undefined, user_limit: c.user_limit || undefined,
    tags: c.available_tags?.length ? c.available_tags.map((x) => defined({ name: x.name, emoji: x.emoji_name || undefined })) : undefined,
    overrides: overrides(c.permission_overwrites),
  });
  return {
    info: { name: t.name, description: t.description, uses: t.usage_count, creator: t.creator?.username, code },
    blueprint: BlueprintSchema.parse({
      description: t.description || t.name,
      roles: [
        ...(roles.find((r) => r.id === 0) ? [{ name: "@everyone", permissions: permNames(roles.find((r) => r.id === 0).permissions) }] : []),
        ...roles.filter((r) => r.id !== 0).map((r) => defined({ name: r.name, color: r.color ? hex(r.color) : undefined,
          hoist: r.hoist || undefined, mentionable: r.mentionable || undefined, permissions: permNames(r.permissions) })),
      ],
      categories: chans.filter((c) => c.type === 4).sort(byPos).map((cat) => defined({
        name: cat.name, overrides: overrides(cat.permission_overwrites),
        channels: chans.filter((c) => c.parent_id === cat.id && c.type !== 4).sort(byPos).map(channel),
      })),
      channels: chans.filter((c) => c.type !== 4 && (c.parent_id === null || c.parent_id === undefined)).sort(byPos).map(channel),
    }),
  };
}

async function loadBlueprint({ blueprint, template, file, discord_template, copy_from_server }) {
  if (blueprint) return BlueprintSchema.parse(blueprint);
  if (discord_template) return (await blueprintFromDiscordTemplate(discord_template)).blueprint;
  if (copy_from_server) return BlueprintSchema.parse(await exportStructure(await guildId(copy_from_server)));
  if (template) {
    const t = TEMPLATES[template.toLowerCase()];
    if (!t) throw new DiscordError(`No template "${template}". Templates: ${Object.keys(TEMPLATES).join(", ")}`);
    return BlueprintSchema.parse(t);
  }
  if (file) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      throw new DiscordError(`Could not read ${file}: ${e.message}`);
    }
    return BlueprintSchema.parse(JSON.parse(text));
  }
  throw new DiscordError("Give a blueprint, a template name or a file.");
}

/** The server's structure as a blueprint. */
async function exportStructure(g) {
  const [chans, roles] = await Promise.all([api("GET", `/guilds/${g}/channels`), api("GET", `/guilds/${g}/roles`)]);
  const roleName = Object.fromEntries(roles.map((r) => [r.id, r.id === g ? "@everyone" : r.name]));
  const overrides = (c) => {
    const list = (c.permission_overwrites || []).map((o) => defined({
      target: o.type === 1 ? `user:${o.id}` : roleName[o.id] || o.id,
      allow: permNames(o.allow).length ? permNames(o.allow) : undefined,
      deny: permNames(o.deny).length ? permNames(o.deny) : undefined,
    }));
    return list.length ? list : undefined;
  };
  const byPos = (a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const channel = (c) => defined({
    name: c.name, type: TYPE_NAMES[c.type], topic: c.topic || undefined, slowmode: c.rate_limit_per_user || undefined,
    nsfw: c.nsfw || undefined, user_limit: c.user_limit || undefined,
    tags: c.available_tags?.length ? c.available_tags.map((t) => defined({ name: t.name, emoji: t.emoji_name || undefined })) : undefined,
    overrides: c.parent_id && c.permission_synced ? undefined : overrides(c),
  });
  const everyone = roles.find((r) => r.id === g);
  return {
    description: "Exported server structure",
    roles: [
      { name: "@everyone", permissions: permNames(everyone.permissions) },
      ...roles.filter((r) => r.id !== g && !r.managed).sort((a, b) => b.position - a.position).map((r) => defined({
        name: r.name, color: hex(r.color), hoist: r.hoist || undefined, mentionable: r.mentionable || undefined,
        permissions: permNames(r.permissions),
      })),
    ],
    categories: chans.filter((c) => c.type === 4).sort(byPos).map((cat) => defined({
      name: cat.name, overrides: overrides(cat),
      channels: chans.filter((c) => c.parent_id === cat.id).sort(byPos).map(channel),
    })),
    channels: chans.filter((c) => c.type !== 4 && !c.parent_id).sort(byPos).map(channel),
  };
}

/** Works out the steps to make the server match the blueprint. Each step has text and run(). */
async function planSteps(g, bp, { updateExisting }) {
  const [chans, roles, guild] = await Promise.all([api("GET", `/guilds/${g}/channels`), api("GET", `/guilds/${g}/roles`),
    api("GET", `/guilds/${g}`)]);
  const steps = [];
  const notes = [];
  const canNews = hasNews(guild);
  const downgraded = [];
  const status = {};
  const findRole = (name) => roles.find((r) => simplify(r.name) === simplify(name));
  const created = {};

  // Roles first, so overrides can point at them.
  for (const r of bp.roles) {
    if (r.name === "@everyone") {
      if (r.permissions && updateExisting) {
        steps.push({ text: `Set @everyone's server permissions to ${r.permissions.join(", ") || "none"}`,
          run: () => api("PATCH", `/guilds/${g}/roles/${g}`, { permissions: bits(r.permissions) }) });
      }
      continue;
    }
    const existing = findRole(r.name);
    const body = defined({ name: r.name, color: color(r.color), hoist: r.hoist, mentionable: r.mentionable,
      permissions: r.permissions ? bits(r.permissions) : undefined });
    status[`role:${r.name}`] = existing ? "exists" : "new";
    if (!existing) {
      steps.push({ text: `Create role "${r.name}"${r.permissions?.length ? ` (${r.permissions.join(", ")})` : ""}`,
        // Without permissions, Discord copies the default @everyone set (incl. Mention @everyone) into the
        // role; "0" keeps it a plain label, and members still get everything @everyone allows.
        run: async () => { created[`role:${r.name}`] = (await api("POST", `/guilds/${g}/roles`, { permissions: "0", ...body })).id; } });
    } else {
      const diffs = [];
      if (body.color !== undefined && body.color !== existing.color) diffs.push("colour");
      if (body.hoist !== undefined && body.hoist !== existing.hoist) diffs.push("shown separately");
      if (body.permissions !== undefined && body.permissions !== existing.permissions) diffs.push("permissions");
      if (diffs.length) {
        if (updateExisting && !existing.managed) {
          steps.push({ text: `Update role "${existing.name}": ${diffs.join(", ")}`,
            run: () => api("PATCH", `/guilds/${g}/roles/${existing.id}`, { ...body, name: undefined }) });
        } else notes.push(`Role "${existing.name}" differs (${diffs.join(", ")}); kept as it is.`);
      }
    }
  }

  for (const r of bp.roles.filter((x) => x.for_bots && x.name !== "@everyone")) {
    const existing = findRole(r.name);
    steps.push({ text: `Give "${r.name}" to the bots in the server`,
      run: async () => {
        const roleId = existing?.id || created[`role:${r.name}`];
        if (!roleId) return;
        // All bots when the member list can be read (Server Members intent), otherwise just this one.
        let bots = await api("GET", `/guilds/${g}/members?limit=1000`).then((ms) => ms.filter((m) => m.user.bot)).catch(() => null);
        if (!bots) bots = [await api("GET", `/guilds/${g}/members/${(await me()).id}`)];
        for (const m of bots) {
          if (!m.roles.includes(roleId)) await api("PUT", `/guilds/${g}/members/${m.user.id}/roles/${roleId}`).catch(() => {});
        }
      } });
  }

  const claimed = new Set();
  const findChannel = (name, types) => chans.find((c) => !claimed.has(c.id) && types.includes(c.type) && simplify(c.name) === simplify(name));
  const family = (t) => (t === "text" || t === "announcement" ? [0, 5] : [CHANNEL_TYPES[t]]);
  const ow = async (list) => (list ? Promise.all(list.map((o) => overwrite(g, { allow: [], deny: [], ...o }))) : undefined);
  const categoryOrder = [];
  const channelOrder = {};

  const handleChannel = (c, catName) => {
    const existing = findChannel(c.name, family(c.type));
    const key = catName ?? "";
    (channelOrder[key] ||= []).push(c.name);
    status[`ch:${c.name}`] = existing ? "exists" : "new";
    if (existing) {
      claimed.add(existing.id);
      created[`ch:${c.name}`] = existing.id;
      if (existing.name !== c.name) status[`name:${c.name}`] = existing.name;
      const parentName = existing.parent_id ? chans.find((x) => x.id === existing.parent_id)?.name : undefined;
      if (catName && simplify(parentName || "") !== simplify(catName)) {
        status[`ch:${c.name}`] = updateExisting ? "moved" : "elsewhere";
        if (updateExisting) {
          steps.push({ text: `Move #${existing.name} to "${catName}"`,
            run: () => api("PATCH", `/channels/${existing.id}`, { parent_id: created[`cat:${catName}`] }) });
        } else notes.push(`#${existing.name} is in "${parentName || "no category"}", not "${catName}"; kept there.`);
      }
      if (c.topic && !existing.topic && [0, 5, 15, 16].includes(existing.type)) {
        steps.push({ text: `Set the topic of #${existing.name}`, run: () => api("PATCH", `/channels/${existing.id}`, { topic: c.topic }) });
      }
      if (c.tags?.length && existing.available_tags) {
        const missing = c.tags.filter((t) => !existing.available_tags.some((x) => simplify(x.name) === simplify(t.name)));
        if (missing.length) {
          steps.push({ text: `Add tags ${missing.map((t) => t.name).join(", ")} to #${existing.name}`,
            run: () => api("PATCH", `/channels/${existing.id}`, {
              available_tags: tagList(existing.available_tags, [...existing.available_tags.map((t) => ({ name: t.name })), ...missing]) }) });
        }
      }
      return;
    }
    const type = c.type === "announcement" && !canNews ? "text" : c.type;
    if (type !== c.type) downgraded.push(c.name);
    steps.push({
      text: `Create ${type} channel #${c.name}${catName ? ` in "${catName}"` : ""}${c.overrides ? " with its own permissions" : ""}`,
      run: async () => {
        const out = await api("POST", `/guilds/${g}/channels`, defined({
          name: c.name, type: CHANNEL_TYPES[type], parent_id: catName ? created[`cat:${catName}`] : undefined, topic: c.topic,
          rate_limit_per_user: c.slowmode, nsfw: c.nsfw, user_limit: c.user_limit,
          available_tags: c.tags ? tagList([], c.tags) : undefined,
          permission_overwrites: c.overrides ? await ow(c.overrides) : undefined,
        }));
        created[`ch:${c.name}`] = out.id;
      },
    });
  };

  for (const cat of bp.categories) {
    categoryOrder.push(cat.name);
    const existing = findChannel(cat.name, [4]);
    status[`cat:${cat.name}`] = existing ? "exists" : "new";
    if (existing) {
      claimed.add(existing.id);
      created[`cat:${cat.name}`] = existing.id;
    } else {
      steps.push({ text: `Create category "${cat.name}"${cat.overrides ? " with its own permissions" : ""}`,
        run: async () => {
          const out = await api("POST", `/guilds/${g}/channels`, defined({ name: cat.name, type: 4, permission_overwrites: await ow(cat.overrides) }));
          created[`cat:${cat.name}`] = out.id;
        } });
    }
    for (const c of cat.channels) handleChannel(c, cat.name);
  }
  for (const c of bp.channels) handleChannel(c, null);

  if (updateExisting && steps.length) {
    steps.push({ text: "Put categories and channels in the blueprint's order",
      run: async () => {
        const body = [];
        categoryOrder.forEach((n, i) => created[`cat:${n}`] && body.push({ id: created[`cat:${n}`], position: i }));
        for (const list of Object.values(channelOrder)) list.forEach((n, i) => created[`ch:${n}`] && body.push({ id: created[`ch:${n}`], position: i }));
        if (body.length) await api("PATCH", `/guilds/${g}/channels`, body);
      } });
  }
  if (downgraded.length) notes.push(`Announcement channels need Community to be turned on, so ${downgraded.join(", ")} will be ${downgraded.length > 1 ? "normal text channels" : "a normal text channel"} (read-only for members as planned). After turning Community on, each can be switched to an announcement channel in its settings.`);
  const extra = chans.filter((c) => !claimed.has(c.id) && c.type !== 4 && ![10, 11, 12].includes(c.type));
  if (extra.length) notes.push(`${extra.length} existing channel(s) are not in the blueprint and are kept: ${extra.slice(0, 10).map((c) => c.name).join(", ")}${extra.length > 10 ? "…" : ""}`);
  const everyone = roles.find((r) => r.id === g);
  return { steps, notes, status, kept: extra.map((c) => c.name), everyonePerms: everyone?.permissions,
    serverRoles: roles.filter((r) => r.id !== g && !r.managed).map((r) => ({ name: r.name, permissions: r.permissions })) };
}

// ------------------------------------------------------------------ preview

// What @everyone can do in a new Discord server.
const DEFAULT_EVERYONE = ["ViewChannel", "SendMessages", "ReadMessageHistory", "AddReactions", "EmbedLinks", "AttachFiles",
  "UseExternalEmojis", "CreatePublicThreads", "SendMessagesInThreads", "Connect", "Speak", "UseVAD", "Stream",
  "ChangeNickname", "CreateInstantInvite", "UseApplicationCommands", "SendPolls", "SendVoiceMessages"];
const ICON = { text: "#", announcement: "📢", forum: "💬", media: "🖼️", voice: "🔊", stage: "🎙️" };
const KEY_PERMS = ["Administrator", "ManageGuild", "ManageRoles", "ManageChannels", "BanMembers", "KickMembers",
  "ModerateMembers", "ManageMessages", "ManageThreads", "MentionEveryone", "ViewAuditLog", "MoveMembers", "MuteMembers"];
const ALL = (1n << 53n) - 1n;

/** Markdown preview: the sidebar as members see it, the roles, and who can see/write where. */
function renderPreview(bp, { status = {}, kept = [], everyonePerms, serverRoles = [], title = "Preview" } = {}) {
  const mark = (key) => ({ new: " 🆕", moved: " ↪️ moved here", elsewhere: " (exists in another category; stays there)" })[status[key]] || (status[key] === "exists" ? " ✓" : "");
  const lines = [`### ${title}`, ""];
  if (Object.keys(status).length) lines.push("🆕 = will be created · ✓ = already exists (kept) · ↪️ = will be moved", "");

  // Sidebar
  lines.push("**Channels (as members see them)**", "```");
  const channelLine = (c) => {
    const tags = c.tags?.length ? `  [${c.tags.map((t) => `${t.emoji ? t.emoji + " " : ""}${t.name}`).join(", ")}]` : "";
    const extra = [c.user_limit ? `max ${c.user_limit}` : "", c.slowmode ? `slowmode ${c.slowmode}s` : ""].filter(Boolean).join(", ");
    return `  ${ICON[c.type] || "#"} ${c.name}${extra ? ` (${extra})` : ""}${tags}${mark(`ch:${c.name}`)}`;
  };
  for (const c of bp.channels) lines.push(channelLine(c));
  for (const cat of bp.categories) {
    const hidden = (cat.overrides || []).some((o) => o.target === "@everyone" && o.deny?.includes("ViewChannel"));
    lines.push(`⌄ ${cat.name.toUpperCase()}${hidden ? "  🔒 private" : ""}${mark(`cat:${cat.name}`)}`);
    for (const c of cat.channels) lines.push(channelLine(c));
  }
  if (kept.length) lines.push("", `(also kept as they are: ${kept.join(", ")})`);
  lines.push("```", "");

  // Topics
  const topics = [...bp.channels, ...bp.categories.flatMap((c) => c.channels)].filter((c) => c.topic);
  if (topics.length) {
    lines.push("**Channel topics**", "");
    for (const c of topics) lines.push(`- **${c.name}**: ${c.topic.replace(/\n/g, " ")}`);
    lines.push("");
  }

  // Roles
  const roles = bp.roles.filter((r) => r.name !== "@everyone");
  if (roles.length) {
    lines.push("**Roles** (top to bottom)", "", "| Role | Colour | Own group | Key permissions |", "|---|---|---|---|");
    for (const r of roles) {
      const key = (r.permissions || []).includes("Administrator") ? "Administrator (everything)"
        : (r.permissions || []).filter((p) => KEY_PERMS.includes(p)).join(", ") || "none beyond @everyone";
      lines.push(`| ${r.name}${mark(`role:${r.name}`)} | ${r.color ?? "–"} | ${r.hoist ? "yes" : "no"} | ${key} |`);
    }
    lines.push("");
  }

  // Access grid
  const everyoneRole = bp.roles.find((r) => r.name === "@everyone");
  const base = everyoneRole?.permissions ? BigInt(bits(everyoneRole.permissions)) : everyonePerms ? BigInt(everyonePerms) : BigInt(bits(DEFAULT_EVERYONE));
  const rolePerms = (name) => {
    const r = roles.find((x) => x.name === name) || serverRoles.find((x) => x.name === name);
    if (!r) return 0n;
    return Array.isArray(r.permissions) ? BigInt(bits(r.permissions)) : BigInt(r.permissions || 0);
  };
  const columns = ["@everyone", ...roles.map((r) => r.name)].slice(0, 7);
  const VIEW = 1n << 10n;
  const SEND = 1n << 11n;
  const CONNECT = 1n << 20n;
  const access = (role, c, cat) => {
    let p = base | (role === "@everyone" ? 0n : rolePerms(role));
    if (p & (1n << 3n)) p = ALL;
    else {
      const list = c.overrides || cat?.overrides || [];
      const apply = (o) => {
        p = (p & ~BigInt(bits(o.deny || []))) | BigInt(bits(o.allow || []));
      };
      list.filter((o) => o.target === "@everyone").forEach(apply);
      if (role !== "@everyone") list.filter((o) => o.target === role).forEach(apply);
    }
    if (!(p & VIEW)) return "🚫";
    const voice = c.type === "voice" || c.type === "stage";
    const write = voice ? p & CONNECT : p & SEND;
    return write ? "✅" : "👁️";
  };
  const all = [...bp.channels.map((c) => ({ c })), ...bp.categories.flatMap((cat) => cat.channels.map((c) => ({ c, cat })))];
  if (all.length) {
    lines.push("**Who can do what** (✅ see and write/join · 👁️ read only · 🚫 hidden)", "",
      `| Channel | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---").join("|")}|`);
    for (const { c, cat } of all) lines.push(`| ${ICON[c.type] || "#"} ${c.name} | ${columns.map((r) => access(r, c, cat)).join(" | ")} |`);
    if (roles.length + 1 > columns.length) lines.push("", `(${roles.length + 1 - columns.length} more role(s) not shown)`);
    lines.push("");
  }
  const count = all.length;
  lines.push(`**Total:** ${bp.categories.length} categories, ${count} channels, ${roles.length} roles.`);
  return lines.join("\n");
}

const SOURCES = {
  discord_template: z.string().optional().describe("A Discord server template link (discord.new/… or discord.com/template/…) or its code, e.g. from a template website"),
  copy_from_server: z.string().optional().describe("Copy the structure of another server a configured bot is in"),
};

defineJob("apply_blueprint", async (job, ctl) => {
  const { guild, blueprint, update_existing } = job.params;
  // Planning again on every (re)start skips what already exists, so resuming just continues.
  const { steps, notes } = await planSteps(guild, BlueprintSchema.parse(blueprint), { updateExisting: update_existing });
  for (const [i, step] of steps.entries()) {
    if (ctl.cancelled()) return { done: i, of: steps.length };
    ctl.progress(i, steps.length, step.text);
    await step.run();
    ctl.log(step.text);
  }
  ctl.progress(steps.length, steps.length, "finished");
  return { steps: steps.length, notes };
});

export default function register(t) {
  const tool = t("blueprints");

  tool("import_discord_template",
    "Load a Discord server template from a link (discord.new/CODE or discord.com/template/CODE, as shared on template websites) and return it as a blueprint you can show with preview_blueprint, edit, and build with apply_blueprint. Also gives the template's name, description and how many times it was used.", {
      link: z.string().describe("Template link or code"),
    }, async ({ link }) => blueprintFromDiscordTemplate(link), READ);

  tool("list_templates", "List the built-in server templates for apply_blueprint.", {}, async () =>
    Object.entries(TEMPLATES).map(([name, tp]) => ({
      name, description: tp.description, roles: tp.roles.map((r) => r.name),
      categories: tp.categories.map((c) => `${c.name}: ${c.channels.map((x) => x.name).join(", ")}`),
    })), READ);

  tool("preview_blueprint",
    "Show a visual preview of a server layout before building it: the channel sidebar as members will see it (categories, channel types, topics, forum tags, private areas), the roles with colours and key permissions, and a grid of who can see and write in each channel. With a server, also marks what is new, already there or moved. Use it to let the user approve or ask for changes; then apply_blueprint.", {
      server: z.string().optional().describe("Compare with this server (what is new / existing)"),
      template: z.string().optional(), file: z.string().optional(), blueprint: BlueprintSchema.optional(),
      ...SOURCES,
      update_existing: z.boolean().default(false),
    }, async ({ server: s, template, file, blueprint, discord_template, copy_from_server, update_existing }) => {
      const title = template ? `Preview: ${template} template` : discord_template ? `Preview: Discord template ${templateCode(discord_template)}`
        : copy_from_server ? `Preview: copy of ${copy_from_server}` : "Preview";
      const bp = await loadBlueprint({ blueprint, template, file, discord_template, copy_from_server });
      if (s) await guildId(s); // choose the target server's bot before reading it
      if (!s) return renderPreview(bp, { title });
      const g = await guildId(s);
      const plan = await planSteps(g, bp, { updateExisting: update_existing });
      return renderPreview(bp, { ...plan, title }) + `\n\n**${plan.steps.length} change(s) to make.**` +
        (plan.notes.length ? `\n\nNotes:\n${plan.notes.map((n) => `- ${n}`).join("\n")}` : "");
    }, READ);

  tool("export_server_structure",
    "Export a server's roles, categories, channels, topics, forum tags and permissions as a blueprint (a backup without messages). Optionally save it to a JSON file; apply_blueprint can rebuild from it here or on another server.", {
      server, save_to: z.string().optional().describe("File path to write the JSON to"),
    }, async ({ server: s, save_to }) => {
      const g = await guildId(s);
      const bp = await exportStructure(g);
      if (save_to) {
        await writeFile(save_to, JSON.stringify(bp, null, 2), "utf8");
        return { saved_to: save_to, roles: bp.roles.length, categories: bp.categories.length,
          channels: bp.categories.reduce((n, c) => n + c.channels.length, bp.channels.length) };
      }
      return bp;
    }, READ);

  tool("apply_blueprint",
    'Build or complete a server from a blueprint: a built-in template (list_templates), a saved export (file), or a layout you write (blueprint: {roles, categories:[{name, overrides, channels:[{name, type, topic, slowmode, tags, overrides}]}], channels}). mode "plan" lists the steps without changing anything; "apply" does them. Only what is missing is created, matching names loosely (emojis and dashes ignored), so it is safe to run again to continue. Nothing is deleted.', {
      server,
      template: z.string().optional(),
      file: z.string().optional().describe("Path of a blueprint JSON (e.g. from export_server_structure)"),
      blueprint: BlueprintSchema.optional(),
      ...SOURCES,
      mode: z.enum(["plan", "apply"]).default("plan"),
      update_existing: z.boolean().default(false).describe("Also move existing channels into the blueprint's categories, update roles that differ and reorder"),
      background: z.boolean().optional().describe("Apply as a background job (for big layouts); follow it with job_status"),
    }, async ({ server: s, template, file, blueprint, discord_template, copy_from_server, mode, update_existing, background }) => {
      const bp = await loadBlueprint({ blueprint, template, file, discord_template, copy_from_server });
      const g = await guildId(s);
      if (mode === "apply" && background && !callContext.getStore()?.dryRun) {
        const job = startJob("apply_blueprint", { guild: g, blueprint: bp, update_existing }, "Build the server layout");
        return { started: true, job_id: job.id, note: "Follow it with job_status; it can be resumed if interrupted." };
      }
      const { steps, notes } = await planSteps(g, bp, { updateExisting: update_existing });
      if (mode === "plan") {
        return { mode: "plan", changes: steps.length, steps: steps.map((x, i) => `${i + 1}. ${x.text}`), notes,
          next: steps.length ? 'Show these steps to the user; after they agree, call again with mode "apply".' : "The server already matches." };
      }
      const done = [];
      for (const [i, step] of steps.entries()) {
        try {
          await step.run();
          done.push(step.text);
        } catch (e) {
          return { mode: "apply", done, failed: { step: step.text, error: String(e.message || e) },
            remaining: steps.slice(i + 1).map((x) => x.text), notes,
            next: "Fix the problem and run apply_blueprint again: finished steps are skipped." };
        }
      }
      return { mode: "apply", done, notes };
    });
}
