import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Where the token file lives unless DISCORD_TOKEN_FILE says otherwise. */
export const DEFAULT_TOKEN_FILE = join(homedir(), ".discord-mcp", "token.txt");

/** Settings saved with the configure tool; environment variables win over them. */
export const SETTINGS_FILE = join(homedir(), ".discord-mcp", "settings.json");
let saved = {};
try {
  saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
} catch {
  saved = {};
}

/** Environment variable NAME, else settings.json key, as a trimmed string. */
function env(name) {
  const v = process.env[name];
  // Unexpanded placeholders such as "${DISCORD_BOT_TOKEN}" and empty values count as unset.
  if (v && !/\$\{[^}]*\}/.test(v) && v.trim()) return v.trim();
  const fromFile = saved[name];
  if (fromFile === undefined || fromFile === null || String(fromFile).trim() === "") return undefined;
  return String(fromFile).trim();
}

/** Which settings come from the environment (so changing them in settings.json would not help). */
export const fromEnvironment = (name) => Boolean(process.env[name]?.trim()) && !/\$\{[^}]*\}/.test(process.env[name]);

/** Every bot this server can use: bots.json, plus DISCORD_BOT_TOKEN and token.txt if set. */
export const BOTS_FILE = join(homedir(), ".discord-mcp", "bots.json");

function readBotsFile() {
  try {
    const list = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((b) => b && b.token) : [];
  } catch {
    return [];
  }
}

function loadBots() {
  const bots = readBotsFile().map((b) => ({ ...b, source: "bots.json" }));
  const add = (token, name, source) => {
    if (token && !bots.some((b) => b.token === token)) bots.unshift({ name, token, source });
  };
  const file = env("DISCORD_TOKEN_FILE") || DEFAULT_TOKEN_FILE;
  try {
    add(readFileSync(file, "utf8").split(/\r?\n/)[0].trim(), "token.txt", "token.txt");
  } catch {
    // no token file
  }
  add(env("DISCORD_BOT_TOKEN"), "DISCORD_BOT_TOKEN", "environment");
  return bots;
}

export const config = {
  bots: loadBots(),
  // Name or id of the bot used when a request does not say which server; else the first one.
  activeBot: env("DISCORD_ACTIVE_BOT"),
  // Which bot to use in a server several bots are in: {"<server id>": "<bot name or id>"}.
  serverBots: (() => {
    try {
      return JSON.parse(env("DISCORD_SERVER_BOTS") || "{}");
    } catch {
      return {};
    }
  })(),
  tokenFile: env("DISCORD_TOKEN_FILE") || DEFAULT_TOKEN_FILE,
  defaultGuild: env("DISCORD_GUILD_ID"),
  // Comma-separated server ids the tools may touch; unset = every server the bot is in.
  allowedGuilds: env("DISCORD_ALLOWED_GUILDS")?.split(/[\s,]+/).filter(Boolean),
  // full = act; preview = every write is a dry run; readonly = write tools are not offered.
  writeMode: (env("DISCORD_WRITE_MODE") || "full").toLowerCase(),
  // Comma-separated tool groups to offer; unset = all.
  toolsets: env("DISCORD_TOOLSETS")?.toLowerCase().split(/[\s,]+/).filter(Boolean),
  // Permanent actions (delete, kick, ban, purge…) need confirm: true; set "off" to skip that step.
  confirmDestructive: (env("DISCORD_CONFIRM_DESTRUCTIVE") || "on").toLowerCase() !== "off",
  // "off" = no live connection (no events, automations or online status).
  gateway: (env("DISCORD_GATEWAY") || "on").toLowerCase(),
  presence: {
    enabled: (env("DISCORD_PRESENCE") || "on").toLowerCase() !== "off",
    status: env("DISCORD_PRESENCE_STATUS") || "online", // online | idle | dnd | invisible
    type: (env("DISCORD_PRESENCE_TYPE") || "watching").toLowerCase(), // playing | listening | watching | competing | custom
    text: env("DISCORD_PRESENCE_TEXT") || "",
  },
};

/** The bot matching a name or id (case-insensitive), or undefined. */
export function findBot(ref) {
  if (!ref) return undefined;
  const r = String(ref).toLowerCase();
  return config.bots.find((b) => b.id === ref || b.name?.toLowerCase() === r);
}

/** The bot used when nothing else decides: DISCORD_ACTIVE_BOT, else the first. */
export function activeBot() {
  return findBot(config.activeBot) || config.bots[0];
}

// The active bot's token, so older code can keep reading config.token.
Object.defineProperty(config, "token", { get: () => activeBot()?.token, enumerable: true });

function writeBotsFile() {
  const list = config.bots.filter((b) => b.source === "bots.json").map(({ name, id, token }) => ({ name, id, token }));
  mkdirSync(dirname(BOTS_FILE), { recursive: true });
  writeFileSync(BOTS_FILE, JSON.stringify(list, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(BOTS_FILE, 0o600);
  } catch {
    // Windows: the file is in the user's profile folder already
  }
}

/** Adds a bot (or updates the one with the same id) and saves bots.json (owner-only). */
export function addBot({ token, name, id }) {
  const existing = config.bots.find((b) => (id && b.id === id) || b.token === token);
  if (existing) {
    Object.assign(existing, { token, name, id, source: "bots.json" });
  } else {
    config.bots.push({ token, name, id, source: "bots.json" });
  }
  writeBotsFile();
  return config.bots.find((b) => b.token === token);
}

/** Removes a saved bot. Bots from DISCORD_BOT_TOKEN or token.txt must be removed there. */
export function removeBot(bot) {
  if (bot.source !== "bots.json") return false;
  config.bots = config.bots.filter((b) => b !== bot);
  writeBotsFile();
  return true;
}

/** Writes settings.json (merged). Values are strings; "" removes a setting. */
export function saveSettings(changes) {
  const next = { ...saved };
  for (const [k, v] of Object.entries(changes)) {
    if (v === "" || v === null) delete next[k];
    else next[k] = v;
  }
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  saved = next;
  return next;
}
