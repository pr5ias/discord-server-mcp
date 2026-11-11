// Background jobs: bulk role changes, message backups and transcripts, restoring messages,
// plus listing, following, cancelling and resuming jobs.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { api, guildId, channel, role, defined, server, DiscordError, callContext } from "../discord.js";
import { defineJob, startJob, listJobs, getJob, cancelJob, resumeJob, jobView } from "../jobs.js";
import { READ, DESTRUCTIVE } from "../tool.js";

const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function simplifyMessage(m) {
  return defined({
    id: m.id, time: m.timestamp, edited: m.edited_timestamp || undefined,
    author: { id: m.author.id, name: m.author.global_name || m.author.username, bot: m.author.bot || undefined,
      avatar: m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png` : undefined },
    content: m.content || undefined, embeds: m.embeds?.length ? m.embeds : undefined,
    attachments: m.attachments?.length ? m.attachments.map((a) => ({ name: a.filename, url: a.url })) : undefined,
    reactions: m.reactions?.length ? m.reactions.map((r) => ({ emoji: r.emoji.name, count: r.count })) : undefined,
    reply_to: m.message_reference?.message_id, pinned: m.pinned || undefined, type: m.type || undefined,
  });
}

function markdownTranscript(name, msgs) {
  const lines = [`# #${name}`, "", `${msgs.length} messages`, ""];
  for (const m of msgs) {
    lines.push(`**${m.author.name}** · ${m.time.replace("T", " ").slice(0, 16)}`);
    if (m.content) lines.push(m.content);
    for (const e of m.embeds || []) lines.push(`> **${e.title || ""}** ${e.description || ""}`.trim());
    for (const a of m.attachments || []) lines.push(`[${a.name}](${a.url})`);
    lines.push("");
  }
  return lines.join("\n");
}

function htmlTranscript(name, msgs) {
  const rows = msgs.map((m) => `<div class="m"><img class="a" src="${esc(m.author.avatar || "")}" alt=""><div><div class="h"><b>${esc(m.author.name)}</b> <span>${esc(m.time.replace("T", " ").slice(0, 16))}</span></div>`
    + (m.content ? `<div class="c">${esc(m.content).replace(/\n/g, "<br>")}</div>` : "")
    + (m.embeds || []).map((e) => `<div class="e">${e.title ? `<b>${esc(e.title)}</b><br>` : ""}${esc(e.description || "").replace(/\n/g, "<br>")}</div>`).join("")
    + (m.attachments || []).map((a) => `<div><a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join("") + "</div></div>").join("\n");
  return `<!doctype html><meta charset="utf-8"><title>#${esc(name)}</title><style>body{background:#313338;color:#dbdee1;font-family:system-ui,sans-serif;margin:0;padding:24px}
h1{font-size:20px}.m{display:flex;gap:12px;padding:6px 0}.a{width:40px;height:40px;border-radius:50%;background:#1e1f22}.h span{color:#949ba4;font-size:12px}
.c{white-space:normal;line-height:1.4}.e{border-left:4px solid #5865f2;background:#2b2d31;padding:8px 12px;margin-top:4px;border-radius:4px}a{color:#00a8fc}</style>
<h1>#${esc(name)}</h1><p>${msgs.length} messages</p>${rows}`;
}

// ------------------------------------------------------------------ job kinds

defineJob("backup_messages", async (job, ctl) => {
  const { guild, channels, perChannel, folder, formats } = job.params;
  mkdirSync(folder, { recursive: true });
  const st = job.state;
  st.done ||= [];
  for (const [i, c] of channels.entries()) {
    if (ctl.cancelled()) return { folder, channels_done: st.done.length };
    if (st.done.includes(c.id)) continue;
    const msgs = [];
    let before;
    while (msgs.length < perChannel) {
      const page = await api("GET", `/channels/${c.id}/messages?limit=${Math.min(100, perChannel - msgs.length)}${before ? `&before=${before}` : ""}`).catch(() => []);
      if (!page.length) break;
      msgs.push(...page.map(simplifyMessage));
      before = page.at(-1).id;
      ctl.progress(i, channels.length, `#${c.name}: ${msgs.length} messages`);
      if (ctl.cancelled() || page.length < 100) break;
    }
    msgs.reverse();
    const base = join(folder, c.name.replace(/[^\p{L}\p{N}_-]+/gu, "").replace(/^[-_]+|[-_]+$/g, "") || c.id);
    writeFileSync(`${base}.json`, JSON.stringify({ guild, channel: { id: c.id, name: c.name }, messages: msgs }, null, 2));
    if (formats.includes("markdown")) writeFileSync(`${base}.md`, markdownTranscript(c.name, msgs));
    if (formats.includes("html")) writeFileSync(`${base}.html`, htmlTranscript(c.name, msgs));
    st.done.push(c.id);
    ctl.log(`#${c.name}: ${msgs.length} messages`);
    ctl.save();
  }
  ctl.progress(channels.length, channels.length, "finished");
  return { folder, channels: channels.length };
});

defineJob("restore_messages", async (job, ctl) => {
  const { file, channelId } = job.params;
  const data = JSON.parse(readFileSync(file, "utf8"));
  const msgs = data.messages || [];
  const st = job.state;
  st.index ||= 0;
  const me = await api("GET", "/users/@me");
  const hooks = await api("GET", `/channels/${channelId}/webhooks`);
  let hook = hooks.find((w) => w.user?.id === me.id && w.token) || await api("POST", `/channels/${channelId}/webhooks`, { name: "Restore" });
  for (; st.index < msgs.length; st.index++) {
    if (ctl.cancelled()) return { restored: st.index, of: msgs.length };
    const m = msgs[st.index];
    const extra = (m.attachments || []).map((a) => a.url).join("\n");
    const content = [m.content, extra].filter(Boolean).join("\n").slice(0, 2000);
    if (!content && !m.embeds?.length) continue;
    await api("POST", `/webhooks/${hook.id}/${hook.token}?wait=true`, defined({
      content: content || undefined, username: (m.author?.name || "unknown").slice(0, 80), avatar_url: m.author?.avatar,
      embeds: m.embeds?.slice(0, 10).map(({ type, ...e }) => e), allowed_mentions: { parse: [] },
    }));
    ctl.progress(st.index + 1, msgs.length);
  }
  return { restored: msgs.length, channel: channelId };
});

defineJob("bulk_role", async (job, ctl) => {
  const { guild, roleId, roleName, action, filter, reason } = job.params;
  const st = job.state;
  if (!st.members) {
    const all = [];
    let after = "0";
    for (;;) {
      const page = await api("GET", `/guilds/${guild}/members?limit=1000&after=${after}`);
      all.push(...page);
      if (page.length < 1000) break;
      after = page.at(-1).user.id;
    }
    st.members = all.filter((m) => {
      if (filter.humans_only && m.user.bot) return false;
      if (filter.bots_only && !m.user.bot) return false;
      if (filter.with_role && !m.roles.includes(filter.with_role)) return false;
      if (filter.without_role && m.roles.includes(filter.without_role)) return false;
      if (filter.joined_before && Date.parse(m.joined_at) >= Date.parse(filter.joined_before)) return false;
      if (filter.joined_after && Date.parse(m.joined_at) <= Date.parse(filter.joined_after)) return false;
      return action === "add" ? !m.roles.includes(roleId) : m.roles.includes(roleId);
    }).map((m) => m.user.id);
    st.index = 0;
    ctl.save();
  }
  for (; st.index < st.members.length; st.index++) {
    if (ctl.cancelled()) return { changed: st.index, of: st.members.length };
    await api(action === "add" ? "PUT" : "DELETE", `/guilds/${guild}/members/${st.members[st.index]}/roles/${roleId}`, undefined, { reason });
    ctl.progress(st.index + 1, st.members.length, `${action} ${roleName}`);
  }
  return { changed: st.members.length, role: roleName, action };
});

// ------------------------------------------------------------------ tools

export default function register(t) {
  const tool = t("jobs");

  tool("list_jobs", "List background jobs (building, bulk role changes, backups, restores) with their status and progress.", {}, async () =>
    ({ jobs: listJobs().map((j) => jobView(j)) }), READ);

  tool("job_status", "Progress and result of a background job.", { job_id: z.string() }, async ({ job_id }) => {
    const j = getJob(job_id);
    if (!j) throw new DiscordError(`No job ${job_id}.`);
    return jobView(j, true);
  }, READ);

  tool("cancel_job", "Stop a running background job after its current step. It can be resumed later.", { job_id: z.string() }, async ({ job_id }) => {
    if (callContext.getStore()?.dryRun) return { would_cancel: job_id };
    return cancelJob(job_id) ? { cancelling: job_id } : { note: "That job is not running." };
  });

  tool("resume_job", "Continue an interrupted, failed or cancelled background job from where it stopped.", { job_id: z.string() }, async ({ job_id }) => {
    if (callContext.getStore()?.dryRun) return { would_resume: job_id };
    const j = resumeJob(job_id);
    if (!j) throw new DiscordError("Only interrupted, failed or cancelled jobs can be resumed.");
    return { resumed: job_id };
  });

  tool("bulk_role_update",
    "Give a role to, or take it from, many members at once (all members, or only those matching a filter), as a background job. Needs Server Members intent. Without confirm it only shows how many members would change.", {
      server, role: z.string(), action: z.enum(["add", "remove"]),
      with_role: z.string().optional(), without_role: z.string().optional(),
      humans_only: z.boolean().optional(), bots_only: z.boolean().optional(),
      joined_before: z.string().optional().describe("ISO date"), joined_after: z.string().optional().describe("ISO date"),
      reason: z.string().optional(),
    }, async (a) => {
      const g = await guildId(a.server);
      const r = await role(g, a.role);
      const filter = defined({ humans_only: a.humans_only, bots_only: a.bots_only, joined_before: a.joined_before, joined_after: a.joined_after,
        with_role: a.with_role ? (await role(g, a.with_role)).id : undefined, without_role: a.without_role ? (await role(g, a.without_role)).id : undefined });
      if (callContext.getStore()?.dryRun) {
        let count = 0;
        try {
          const members = await api("GET", `/guilds/${g}/members?limit=1000`);
          count = members.filter((m) => (a.action === "add" ? !m.roles.includes(r.id) : m.roles.includes(r.id))
            && (!filter.with_role || m.roles.includes(filter.with_role)) && (!filter.without_role || !m.roles.includes(filter.without_role))
            && (!filter.humans_only || !m.user.bot) && (!filter.bots_only || m.user.bot)).length;
        } catch (e) {
          throw new DiscordError(`${e.message}\nTurn on Server Members intent for the bot (Developer Portal > Bot).`);
        }
        return { would_change: count, role: r.name, action: a.action, note: "Approximate for servers over 1000 members." };
      }
      const job = startJob("bulk_role", { guild: g, roleId: r.id, roleName: r.name, action: a.action, filter, reason: a.reason },
        `${a.action === "add" ? "Give" : "Remove"} ${r.name}`);
      return { started: true, job_id: job.id, note: "Follow it with job_status." };
    }, DESTRUCTIVE);

  tool("backup_messages",
    "Back up the messages of some or all channels to files on this computer, as a background job: JSON (can be restored with restore_messages) plus readable Markdown and HTML transcripts.", {
      server, channels: z.array(z.string()).optional().describe("Default: every text and announcement channel"),
      per_channel: z.number().int().min(1).max(100000).default(1000).describe("Newest messages to keep per channel"),
      folder: z.string().optional().describe("Default: ~/.discord-mcp/backups/<server>-<date>"),
      formats: z.array(z.enum(["markdown", "html"])).default(["markdown", "html"]),
    }, async (a) => {
      const g = await guildId(a.server);
      const info = await api("GET", `/guilds/${g}`);
      let list;
      if (a.channels?.length) list = await Promise.all(a.channels.map((c) => channel(g, c)));
      else list = (await api("GET", `/guilds/${g}/channels`)).filter((c) => [0, 5].includes(c.type));
      const folder = a.folder || join(homedir(), ".discord-mcp", "backups", `${info.name.replace(/[^\p{L}\p{N}_-]+/gu, "_")}-${new Date().toISOString().slice(0, 10)}`);
      if (callContext.getStore()?.dryRun) return { would_back_up: list.map((c) => c.name), folder };
      const job = startJob("backup_messages", { guild: { id: g, name: info.name }, channels: list.map((c) => ({ id: c.id, name: c.name })),
        perChannel: a.per_channel, folder, formats: a.formats }, `Back up ${list.length} channel(s) of ${info.name}`);
      return { started: true, job_id: job.id, folder, channels: list.length };
    });

  tool("restore_messages",
    "Re-post messages from a backup JSON file (from backup_messages) into a channel, with each original author's name and avatar (through a webhook), as a background job.", {
      server, file: z.string(), channel: z.string(),
    }, async ({ server: s, file, channel: ch }) => {
      if (!existsSync(file)) throw new DiscordError(`No file ${file}.`);
      const g = await guildId(s);
      const c = await channel(g, ch);
      const count = JSON.parse(readFileSync(file, "utf8")).messages?.length || 0;
      if (callContext.getStore()?.dryRun) return { would_restore: count, into: c.name };
      const job = startJob("restore_messages", { file, channelId: c.id }, `Restore ${count} messages into #${c.name}`);
      return { started: true, job_id: job.id, messages: count };
    });
}
