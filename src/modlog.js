// A searchable copy of every moderation-log entry, one JSON line per event in
// ~/.discord-mcp/modlog/<server id>.jsonl, so staff can filter by member, kind and date
// (search_mod_log, /modlog) instead of scrolling a channel.
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODLOG_DIR = join(homedir(), ".discord-mcp", "modlog");
export const LOG_KINDS = ["messages", "members", "moderation", "server"];

/** Short names of the events, for filters ("ban", "message_deleted"…), from the text keys. */
export const typeOf = (titleKey) => String(titleKey || "").replace(/^log_/, "");

export function archive(guild, record) {
  try {
    mkdirSync(MODLOG_DIR, { recursive: true });
    appendFileSync(join(MODLOG_DIR, `${guild}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
  } catch {
    // the archive is a convenience; the channel log still works
  }
}

/** Entries of a server, newest first, matching every given filter. */
export function search(guild, { user, actor, kind, type, since, contains, limit = 25 } = {}) {
  const file = join(MODLOG_DIR, `${guild}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = [];
  const after = since ? Date.parse(since) : 0;
  const words = contains?.toLowerCase();
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let r;
    try {
      r = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (after && Date.parse(r.at) < after) break;
    if (user && r.subject !== user && r.actor !== user) continue;
    if (actor && r.actor !== actor) continue;
    if (kind && r.kind !== kind) continue;
    if (type && r.type !== type) continue;
    if (words && !JSON.stringify(r).toLowerCase().includes(words)) continue;
    out.push(r);
  }
  return out;
}
