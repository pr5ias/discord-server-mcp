// Command line: `discord-server-mcp init` (guided setup) and `discord-server-mcp check`.
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { config, addBot, BOTS_FILE } from "./config.js";
import { VERSION } from "./version.js";
import { setupCheck } from "./tools/setup.js";

const out = (s = "") => process.stdout.write(s + "\n");
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function ask(question, { hidden = false, fallback = "" } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else rl.output.write(s.replace(/[^\r\n]/g, "*"));
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) out();
      resolve(answer.trim() || fallback);
    });
  });
}

const yes = async (q, def = true) => /^(y|yes|s|sim)?$/i.test(await ask(`${q} ${def ? "[Y/n]" : "[y/N]"} `, { fallback: def ? "y" : "n" }));

async function discord(token, path) {
  const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** How MCP clients should start this server: npx when run from npx's cache, else node + this file. */
function launchCommand() {
  const self = fileURLToPath(import.meta.url);
  if (/[\\/]_npx[\\/]/.test(self)) return { command: "npx", args: ["-y", "discord-server-mcp"] };
  return { command: "node", args: [self] };
}

function clientConfigs() {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
  const desktop = platform() === "win32" ? join(appData, "Claude", "claude_desktop_config.json")
    : platform() === "darwin" ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    { name: "Claude Desktop", file: desktop, key: "mcpServers" },
    { name: "Cursor", file: join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { name: "Windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
  ].filter((c) => existsSync(dirname(c.file)));
}

async function addToJson(file, key, name, entry) {
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON; fix it or add the server by hand.`);
    }
  }
  data[key] = { ...(data[key] || {}), [name]: entry };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function init() {
  out(bold(`\ndiscord-server-mcp ${VERSION} setup\n`));
  out("1. Create a bot: https://discord.com/developers/applications");
  out("   New Application > Bot > Reset Token, and copy the token.");
  out("   (Optional) On the same page turn on Server Members Intent.\n");

  let token;
  let bot;
  for (;;) {
    token = await ask("2. Paste the bot token (hidden): ", { hidden: true });
    if (!token) {
      out("   No token given. Run init again when you have it.");
      return;
    }
    try {
      bot = await discord(token, "/users/@me");
      break;
    } catch (e) {
      out(`   That token does not work (${e.message.slice(0, 80)}). Try again or press Enter to stop.`);
    }
  }
  out(`   OK: the bot is ${bold(bot.username)}.`);

  addBot({ token, id: bot.id, name: bot.username });
  out(`   Saved to ${BOTS_FILE} (only you can read it; no app config contains the token).`);
  out("   You can add more bots later by running init again, or from the chat (\"add another Discord bot\").\n");

  const app = await discord(token, "/oauth2/applications/@me").catch(() => ({ id: bot.id }));
  out("3. Add the bot to your server with this link (Administrator):");
  out(`   https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot+applications.commands&permissions=8`);
  await ask("   Press Enter once it is in your server. ");
  const guilds = await discord(token, "/users/@me/guilds").catch(() => []);
  out(guilds.length ? `   The bot is in: ${guilds.map((g) => g.name).join(", ")}` : "   The bot is not in a server yet; you can invite it later.");
  out("   Tip: in Server Settings > Roles, drag the bot's role near the top so it can manage the other roles.\n");

  out("4. Safety:");
  const mode = (await ask("   Write mode: full (act after asking), preview (only show changes) or readonly [full]: ", { fallback: "full" })).toLowerCase();
  const presence = await ask("   Status text for the bot, e.g. your server's name (Enter for none): ");
  const env = {};
  if (["preview", "readonly"].includes(mode)) env.DISCORD_WRITE_MODE = mode;
  if (presence) env.DISCORD_PRESENCE_TEXT = presence;

  out("\n5. Connect your AI apps:");
  const launch = launchCommand();
  const entry = { ...launch, ...(Object.keys(env).length ? { env } : {}) };
  let any = false;
  for (const c of clientConfigs()) {
    if (await yes(`   Add it to ${c.name}?`)) {
      try {
        await addToJson(c.file, c.key, "discord", entry);
        out(`   Added to ${c.file}`);
        any = true;
      } catch (e) {
        out(`   ${e.message}`);
      }
    }
  }
  let hasClaudeCode = false;
  try {
    execFileSync(platform() === "win32" ? "where" : "which", ["claude"], { stdio: "ignore" });
    hasClaudeCode = true;
  } catch {
    // not installed
  }
  if (hasClaudeCode && await yes("   Add it to Claude Code (all projects)?")) {
    const args = ["mcp", "add", "--scope", "user", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "discord", "--", launch.command, ...launch.args];
    try {
      execFileSync("claude", args, { stdio: "inherit", shell: platform() === "win32" });
      any = true;
    } catch {
      out(`   Could not run it. Run this yourself: claude ${args.join(" ")}`);
    }
  }
  if (!any) {
    out("   Add this to your MCP client's config by hand:");
    out(JSON.stringify({ mcpServers: { discord: entry } }, null, 2).replace(/^/gm, "   "));
  }
  out(bold("\nDone. Restart your AI app and ask: \"show my Discord server\"."));
}

async function check() {
  const report = await setupCheck();
  out(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

export async function runCli(command) {
  if (command === "init" || command === "setup") return init();
  if (command === "check") return check();
  if (command === "--version" || command === "-v") return out(VERSION);
  out(`discord-server-mcp ${VERSION}

  discord-server-mcp            run the MCP server (what AI apps start)
  discord-server-mcp init       guided setup: token, invite link, connect Claude Desktop, Claude Code, Cursor, Windsurf
  discord-server-mcp check      check the token, servers and permissions
  discord-server-mcp run        keep the bots online and role menus, welcomes and tickets running (no AI app needed)
  discord-server-mcp serve --http [--port 3333] [--host 127.0.0.1]
                                MCP over HTTP for remote clients; needs DISCORD_MCP_HTTP_TOKEN

Bots are saved in ${BOTS_FILE} (or set DISCORD_BOT_TOKEN).`);
}
