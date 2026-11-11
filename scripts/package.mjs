// Builds the release files in release/:
//   discord-server-mcp-<version>.mcpb  one-click Claude Desktop extension (asks for the token in a form)
//   discord-server.plugin              Claude plugin (Claude Code / Claude Desktop), same as installing from the marketplace
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const build = join(root, "build");
const release = join(root, "release");
await rm(build, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

run("npm", ["run", "build"]);

// Tool list for the extension's manifest.
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(root, "dist", "index.mjs")],
  env: { ...process.env, DISCORD_PRESENCE: "off", DISCORD_BOT_TOKEN: "", DISCORD_TOOLSETS: "all" },
});
const client = new Client({ name: "package", version: "1" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description.split(". ")[0].slice(0, 200) }));
await client.close();

// ------------------------------------------------------------------ MCPB
const mcpb = join(build, "mcpb");
await mkdir(join(mcpb, "server"), { recursive: true });
await cp(join(root, "dist", "index.mjs"), join(mcpb, "server", "index.mjs"));
for (const f of ["README.md", "LICENSE"]) await cp(join(root, f), join(mcpb, f));
await cp(join(root, "assets", "icon.png"), join(mcpb, "icon.png"));
const manifest = {
  manifest_version: "0.2",
  name: "discord-server-mcp",
  display_name: "Discord Server Manager",
  version: pkg.version,
  description: "Create, organise and moderate Discord servers from Claude through your own bot.",
  long_description:
    "Manage Discord servers in plain words: channels, forums and tags, permissions, roles, members and moderation, " +
    "messages with images and embeds, webhooks, events, AutoMod, onboarding, server templates and structure backups. " +
    "Every change can be previewed first, permanent actions need confirmation, and nobody is pinged unless you ask.",
  author: { name: "pr5ias" },
  repository: { type: "git", url: "https://github.com/pr5ias/discord-server-mcp" },
  homepage: "https://github.com/pr5ias/discord-server-mcp",
  icon: "icon.png",
  license: "MIT",
  keywords: ["discord", "server", "moderation", "community", "bot"],
  server: {
    type: "node",
    entry_point: "server/index.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.mjs"],
      env: {
        DISCORD_BOT_TOKEN: "${user_config.bot_token}",
        DISCORD_WRITE_MODE: "${user_config.write_mode}",
        DISCORD_ALLOWED_GUILDS: "${user_config.allowed_servers}",
        DISCORD_PRESENCE_TEXT: "${user_config.presence_text}",
        DISCORD_TOOLSETS: "${user_config.tool_packs}",
      },
    },
  },
  tools,
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=22.0.0" } },
  user_config: {
    bot_token: {
      type: "string", title: "Discord bot token", sensitive: true, required: true,
      description: "discord.com/developers/applications > your app > Bot > Reset Token. Invite the bot to your server with Administrator.",
    },
    write_mode: {
      type: "string", title: "Write mode", default: "full",
      description: "full = make changes after you agree; preview = only show what would change; readonly = no changing tools.",
    },
    allowed_servers: {
      type: "string", title: "Allowed server ids (optional)", default: "",
      description: "Comma-separated server ids the tools may touch. Empty = every server the bot is in.",
    },
    tool_packs: {
      type: "string", title: "Extra tool packs (optional)", default: "",
      description: "The core tools are always on and more turn on when needed. To have packs on from the start: comma-separated, e.g. automations,moderation, or all.",
    },
    presence_text: {
      type: "string", title: "Bot status text (optional)", default: "",
      description: "Shown as \"Watching <text>\" while Claude is open, e.g. your server's name.",
    },
  },
};
await writeFile(join(mcpb, "manifest.json"), JSON.stringify(manifest, null, 2));
const mcpbFile = join(release, `discord-server-mcp-${pkg.version}.mcpb`);
run("npx", ["--no-install", "mcpb", "validate", join(mcpb, "manifest.json")]);
run("npx", ["--no-install", "mcpb", "pack", mcpb, mcpbFile]);

// ------------------------------------------------------------------ plugin
const plugin = join(build, "plugin");
await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
await cp(join(root, ".claude-plugin", "plugin.json"), join(plugin, ".claude-plugin", "plugin.json"));
await cp(join(root, ".mcp.json"), join(plugin, ".mcp.json"));
await cp(join(root, "dist"), join(plugin, "dist"), { recursive: true });
await cp(join(root, "skills"), join(plugin, "skills"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) await cp(join(root, f), join(plugin, f));
const pluginFile = join(release, "discord-server.plugin");
await rm(pluginFile, { force: true });
run("zip", ["-qr", pluginFile, "."], plugin);

console.log(`\nRelease files:\n  ${mcpbFile}\n  ${pluginFile}`);
