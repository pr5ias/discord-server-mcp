// Background jobs: long tasks (building a server, changing roles of many members, backing up messages)
// run on their own, report progress, survive restarts as "interrupted", and can be resumed or cancelled.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { callContext } from "./discord.js";
import { config, findBot } from "./config.js";

export const JOBS_FILE = join(homedir(), ".discord-mcp", "jobs.json");
const runners = new Map();
const active = new Map(); // id -> { cancel: boolean }
let jobs = [];

try {
  jobs = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
  for (const j of jobs) if (j.status === "running") j.status = "interrupted";
} catch {
  jobs = [];
}

function save() {
  try {
    mkdirSync(dirname(JOBS_FILE), { recursive: true });
    // Keep the 50 most recent jobs.
    jobs = jobs.slice(-50);
    writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
  } catch {
    // not fatal
  }
}

/** Registers how a kind of job runs: runner(job, ctl). ctl: progress(done, total, note), log(text), cancelled(), save(). */
export function defineJob(kind, runner) {
  runners.set(kind, runner);
}

export const listJobs = () => jobs.slice().reverse();
export const getJob = (id) => jobs.find((j) => j.id === id);

function run(job) {
  const runner = runners.get(job.kind);
  const bot = findBot(job.bot);
  if (!runner || !bot) {
    job.status = "failed";
    job.error = !runner ? `Unknown job kind ${job.kind}` : `Bot ${job.bot} is no longer configured`;
    save();
    return;
  }
  const flag = { cancel: false };
  active.set(job.id, flag);
  job.status = "running";
  job.updated = new Date().toISOString();
  save();
  let lastSave = 0;
  const ctl = {
    progress(done, total, note) {
      job.progress = { done, total, note };
      job.updated = new Date().toISOString();
      if (Date.now() - lastSave > 2000) {
        lastSave = Date.now();
        save();
      }
    },
    log(text) {
      (job.log ||= []).push(text);
      if (job.log.length > 200) job.log.shift();
    },
    cancelled: () => flag.cancel,
    save,
  };
  callContext.run({ dryRun: false, planned: [], token: bot.token }, async () => {
    try {
      job.result = await runner(job, ctl);
      job.status = flag.cancel ? "cancelled" : "done";
    } catch (e) {
      job.status = flag.cancel ? "cancelled" : "failed";
      job.error = String(e?.message || e);
    } finally {
      job.updated = new Date().toISOString();
      active.delete(job.id);
      save();
    }
  });
}

/** Starts a job with the bot of the current call. Returns the job. */
export function startJob(kind, params, title) {
  const token = callContext.getStore()?.token || config.token;
  const bot = config.bots.find((b) => b.token === token);
  const job = { id: randomBytes(4).toString("hex"), kind, title, params, bot: bot?.id || bot?.name, bot_name: bot?.name,
    status: "queued", state: {}, progress: { done: 0, total: null }, created: new Date().toISOString() };
  jobs.push(job);
  save();
  setImmediate(() => run(job));
  return job;
}

export function cancelJob(id) {
  const flag = active.get(id);
  if (!flag) return false;
  flag.cancel = true;
  return true;
}

export function resumeJob(id) {
  const job = getJob(id);
  if (!job || !["interrupted", "failed", "cancelled"].includes(job.status)) return null;
  job.error = undefined;
  setImmediate(() => run(job));
  return job;
}

/** Public view of a job. */
export function jobView(j, full = false) {
  return {
    id: j.id, title: j.title, kind: j.kind, status: j.status, bot: j.bot_name,
    progress: j.progress?.total ? `${j.progress.done}/${j.progress.total}${j.progress.note ? ` (${j.progress.note})` : ""}` : j.progress?.note,
    started: j.created, updated: j.updated, error: j.error,
    ...(full ? { result: j.result, log: j.log?.slice(-20) } : {}),
  };
}
