// Insights: map a server's areas and projects, collect the feedback in its forums, tickets and channels,
// and summarise it (by project and area, tone, open bugs, repeated requests, recurring themes, a map).
// Works on any server the bot is in, and on files the user brings (exports, backups, CSV, plain text).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { z } from "zod";
import { api, guildId, channel, defined, server, messageLink, DiscordError } from "../discord.js";
import { automations, TICKETS_DIR } from "../automations.js";
import { READ } from "../tool.js";
import { mapServer, mermaidMap, FEEDBACK_AREAS, projectsIn, sentiment, pseudonymizer, report, reportMarkdown, itemsFromFile, enrichItems, AREAS } from "../insights.js";

export const INSIGHTS_DIR = join(homedir(), ".discord-mcp", "insights");
const AREA_NAMES = [...Object.keys(AREAS), "forum", "other"];
const STATUS = /approved|rejected|denied|accepted|solved|resolved|fixed|open|closed|pending|planned|progress|investigating|duplicate|wontfix|done|implemented|confirmed|aprovado|rejeitado|resolvido|aberto|fechado|pendente|corrigido|duplicado/i;

const textOf = (m) => [m.content, ...(m.embeds || []).map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join("\n"))]
  .filter(Boolean).join("\n").trim();
/** People, and webhooks (feedback forms and bridges post through them); not bots. */
const human = (m) => !m.author.bot || Boolean(m.webhook_id);
const reactionsOf = (m) => (m.reactions || []).reduce((s, r) => s + (r.count || 0), 0);
const safeName = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "server";

async function messages(channelId, max) {
  const out = [];
  let before;
  while (out.length < max) {
    const q = new URLSearchParams(defined({ limit: String(Math.min(100, max - out.length)), before }));
    const page = await api("GET", `/channels/${channelId}/messages?${q}`);
    if (!page.length) break;
    out.push(...page);
    before = page.at(-1).id;
    if (page.length < 100) break;
  }
  return out.reverse(); // oldest first
}

async function forumThreads(g, forumId, max, active) {
  const threads = active.filter((t) => t.parent_id === forumId);
  let before;
  while (threads.length < max) {
    const q = new URLSearchParams(defined({ limit: "100", before }));
    const page = await api("GET", `/channels/${forumId}/threads/archived/public?${q}`).catch(() => ({ threads: [], has_more: false }));
    threads.push(...page.threads);
    if (!page.has_more || !page.threads.length) break;
    before = page.threads.at(-1).thread_metadata?.archive_timestamp;
  }
  return threads.slice(0, max);
}

/** Collects feedback items from the chosen areas or channels of a live server. */
export async function collect(a) {
  const g = await guildId(a.server);
  const guild = await api("GET", `/guilds/${g}`);
  const all = await api("GET", `/guilds/${g}/channels`);
  const map = mapServer(all);
  const projects = map.projects;
  const since = a.since ? Date.parse(/^\d+$/.test(a.since) ? new Date(Date.now() - Number(a.since) * 864e5).toISOString() : a.since) : 0;
  if (a.since && Number.isNaN(since)) throw new DiscordError(`"${a.since}" is not a date or a number of days.`);
  const areas = a.areas?.length ? a.areas : [...FEEDBACK_AREAS, "forum"];
  let targets;
  if (a.channels?.length) targets = await Promise.all(a.channels.map((c) => channel(g, c)));
  else targets = all.filter((c) => c.type !== 4 && c.type !== 2 && c.type !== 13 && areas.includes(map.channels.find((r) => r.id === c.id)?.area));
  const row = (c) => map.channels.find((r) => r.id === c.id) || { area: "other", projects: [] };
  const cats = Object.fromEntries(all.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
  const who = pseudonymizer(a.anonymize !== false);
  const items = [];
  const skipped = [];
  const active = (await api("GET", `/guilds/${g}/threads/active`)).threads || [];
  const wanted = (it) => !a.project || it.projects.some((p) => p.toLowerCase() === a.project.toLowerCase());
  // Bots that relay feedback (review feeds, forms) usually name the real author in the embed.
  const relayed = (m) => (m.author.bot && !m.webhook_id ? m.embeds?.find((e) => e.author?.name)?.author.name : undefined);
  const person = (m) => (relayed(m) ? who(`relay:${relayed(m)}`, relayed(m)) : who(m.author.id, m.author.global_name || m.author.username));
  const counts = (m) => human(m) || (a.include_bots && m.author.bot);
  const fresh = (m) => !since || Date.parse(m.timestamp) >= since;

  for (const c of targets) {
    const info = row(c);
    try {
      if (c.type === 15 || c.type === 16) {
        const tagName = Object.fromEntries((c.available_tags || []).map((t) => [t.id, t.name]));
        for (const t of await forumThreads(g, c.id, a.max_posts, active)) {
          const msgs = (await messages(t.id, a.max_replies + 1)).filter((m) => counts(m) || m.id === t.id);
          const first = msgs.find((m) => m.id === t.id) || msgs[0];
          if (!first || !fresh(first)) continue;
          const tags = (t.applied_tags || []).map((id) => tagName[id]).filter(Boolean);
          const post = {
            kind: "post", area: info.area === "forum" ? "reviews" : info.area, channel: c.name, title: t.name, tags,
            status: tags.filter((x) => STATUS.test(x)), projects: projectsIn([c.name, cats[c.parent_id], ...tags, t.name], projects).concat(info.projects).filter((v, i, s) => s.indexOf(v) === i),
            text: textOf(first), author: person(first), reactions: reactionsOf(first), replies: Math.max(0, (t.message_count ?? msgs.length - 1)),
            created: first.timestamp, closed: t.thread_metadata?.archived || t.thread_metadata?.locked || undefined, link: messageLink(g, t.id, first.id),
          };
          if (!wanted(post)) continue;
          items.push(post);
          if (a.include_replies) {
            for (const m of msgs.filter((x) => x.id !== first.id && counts(x) && textOf(x))) {
              items.push({ kind: "reply", area: post.area, channel: c.name, title: post.title, projects: post.projects, text: textOf(m), author: person(m),
                reactions: reactionsOf(m), created: m.timestamp, link: messageLink(g, t.id, m.id) });
            }
          }
        }
      } else {
        const msgs = (await messages(c.id, a.max_messages)).filter((m) => counts(m) && textOf(m) && fresh(m));
        const ticket = info.area === "tickets";
        msgs.forEach((m, i) => {
          const it = {
            kind: ticket ? (i === 0 ? "post" : "reply") : "post", area: info.area, channel: c.name, title: ticket ? c.name : undefined,
            projects: projectsIn([c.name, cats[c.parent_id], m.content], projects).concat(info.projects).filter((v, j, s) => s.indexOf(v) === j),
            text: textOf(m), author: person(m), reactions: reactionsOf(m), replies: ticket && i === 0 ? msgs.length - 1 : undefined,
            created: m.timestamp, link: messageLink(g, c.id, m.id),
          };
          if (wanted(it)) items.push(it);
        });
      }
    } catch (e) {
      skipped.push(`${c.name}: ${e.message}`);
    }
  }
  if (a.include_closed_tickets && (!a.areas?.length || areas.includes("tickets"))) {
    for (const t of (automations().closed_tickets || []).filter((x) => x.guild === g && x.file && existsSync(x.file))) {
      if (since && Date.parse(t.closed) < since) continue;
      const text = readFileSync(t.file, "utf8").split("\n").slice(1).join("\n").trim();
      const it = { kind: "post", area: "tickets", channel: "closed tickets", title: t.name, status: ["closed"], projects: projectsIn([t.name, text.slice(0, 400)], projects),
        text: text.slice(0, 4000), author: who(t.user_id), replies: Math.max(0, (t.messages || 1) - 1), created: t.opened };
      if (wanted(it)) items.push(it);
    }
  }
  for (const it of items) it.sentiment = sentiment(`${it.title || ""} ${it.text || ""}`);
  return { guild, map, items: items.map((i) => defined(i)), skipped };
}

function save(folder, base, data, md) {
  mkdirSync(folder, { recursive: true });
  const json = join(folder, `${base}.json`);
  writeFileSync(json, JSON.stringify(data, null, 2));
  let mdFile;
  if (md) writeFileSync((mdFile = join(folder, `${base}.md`)), md);
  return { json, markdown: mdFile };
}

const preview = (items, n) => items.slice(0, n).map((i) => defined({ ...i, text: i.text?.length > 400 ? i.text.slice(0, 400) + "…" : i.text }));

export default function register(t) {
  const tool = t("insights");

  tool("map_server",
    "Map a server: what each channel is for (bugs, suggestions, reviews, support, tickets, announcements, showcase, chat, info, staff), the projects it is about (from forum tags, categories and channel names), and a Mermaid diagram. Works on any server the bot is in.", {
      server,
    }, async ({ server: s }) => {
      const g = await guildId(s);
      const guild = await api("GET", `/guilds/${g}`);
      const map = mapServer(await api("GET", `/guilds/${g}/channels`));
      return { server: guild.name, projects: map.projects, areas: map.areas,
        feedback_channels: map.channels.filter((c) => c.feedback).map((c) => defined({ name: c.name, area: c.area, type: c.type, projects: c.projects, status_tags: c.status_tags })),
        channels: map.channels.map((c) => defined({ name: c.name, area: c.area, type: c.type, category: c.category, projects: c.projects })),
        mermaid: mermaidMap(map, guild.name),
        note: "Areas and projects are worked out from names, topics and tags. Correct them with collect_feedback's channels and project options when they are wrong." };
    }, READ);

  const collectShape = {
    server,
    areas: z.array(z.enum(AREA_NAMES)).optional().describe(`Which areas to read (default: ${FEEDBACK_AREAS.join(", ")} and unclassified forums)`),
    channels: z.array(z.string()).optional().describe("Read exactly these channels or forums instead of choosing by area"),
    project: z.string().optional().describe("Only feedback about this project (from map_server)"),
    since: z.string().optional().describe("Only posts from this date (ISO) or from the last N days (a number)"),
    max_posts: z.number().int().min(1).max(1000).default(100).describe("Most forum posts per forum"),
    max_replies: z.number().int().min(0).max(500).default(50).describe("Most replies read per forum post"),
    max_messages: z.number().int().min(1).max(2000).default(200).describe("Most messages per text channel or ticket"),
    include_replies: z.boolean().default(true),
    include_closed_tickets: z.boolean().default(true).describe("Also read the transcripts of tickets closed by this tool's ticket system"),
    include_bots: z.boolean().default(false).describe("Also count messages from bots, e.g. a bot that relays reviews or form answers (the author named in its embed is used)"),
    anonymize: z.boolean().default(true).describe("Name people member-1, member-2… instead of by their username (default)"),
  };

  tool("collect_feedback",
    "Collect the feedback of a server into one list: forum posts with their tags, status and replies, ticket conversations and messages from feedback channels, each with its area, project, tone and link. Saves the full list to a file and returns a preview; feedback_report summarises it.", {
      ...collectShape,
      preview: z.number().int().min(0).max(200).default(40).describe("How many items to return here (all of them go to the file)"),
    }, async (a) => {
      const { guild, map, items, skipped } = await collect(a);
      const base = `${safeName(guild.name)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
      const files = save(INSIGHTS_DIR, base, { server: guild.name, collected: new Date().toISOString(), options: a, projects: map.projects, map, items });
      const posts = items.filter((i) => i.kind !== "reply");
      return defined({
        server: guild.name, posts: posts.length, replies: items.length - posts.length,
        by_area: posts.reduce((o, i) => ({ ...o, [i.area]: (o[i.area] || 0) + 1 }), {}),
        file: files.json, items: preview(items, a.preview), skipped: skipped.length ? skipped : undefined,
        next: "Run feedback_report with this file for the summary, or read the items to look closer.",
      });
    }, READ);

  tool("feedback_report",
    "Summarise feedback: per project and area, tone, open bugs, most discussed and most negative posts, requests made more than once, recurring themes and a map. Reads a live server (same options as collect_feedback) or a file: a collect_feedback result, a backup_messages export, a channel export in JSON, a CSV with title/text columns, or plain text with one post per paragraph. Saves a Markdown report.", {
      ...collectShape,
      file: z.string().optional().describe("Path of a file to analyse instead of reading the server"),
      title: z.string().optional(),
    }, async (a) => {
      let items, map, name;
      if (a.file) {
        if (!existsSync(a.file)) throw new DiscordError(`No file at ${a.file}.`);
        const raw = readFileSync(a.file, "utf8");
        const parsed = itemsFromFile(raw, basename(a.file));
        let saved = {};
        try { saved = JSON.parse(raw); } catch { /* not JSON */ }
        map = saved.map;
        name = saved.server || basename(a.file);
        items = enrichItems(parsed.items, { projects: saved.projects || [], anonymize: a.anonymize !== false });
        if (a.project) items = items.filter((i) => i.projects?.some((p) => p.toLowerCase() === a.project.toLowerCase()));
      } else {
        const c = await collect(a);
        ({ items, map } = c);
        name = c.guild.name;
      }
      if (!items.length) throw new DiscordError("No feedback found with these options.");
      const r = report(items, map);
      const md = reportMarkdown(r, a.title || `Feedback report · ${name}${a.project ? " · " + a.project : ""}`);
      const files = save(INSIGHTS_DIR, `report-${safeName(name)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`, { server: name, items, report: r }, md);
      return { ...r, files, note: "Tone is a word-list hint (English, Portuguese, some Spanish and German): read the most negative posts before drawing conclusions." };
    }, READ);
}
