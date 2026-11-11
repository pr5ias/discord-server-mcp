// discord-server-mcp: an MCP server that lets an AI assistant create and manage Discord servers through bots.
//   discord-server-mcp                 MCP over stdio (what Claude and other apps start)
//   discord-server-mcp serve --http    MCP over HTTP for remote use (needs DISCORD_MCP_HTTP_TOKEN)
//   discord-server-mcp run             keep the bots online and the automations running, without an AI app
//   discord-server-mcp init | check    setup wizard / health check
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registrar } from "./tool.js";
import { startGateway, status } from "./gateway.js";
import { startAutomations, automations } from "./automations.js";
import serverTools from "./tools/server.js";
import channelTools from "./tools/channels.js";
import messageTools from "./tools/messages.js";
import memberTools from "./tools/members.js";
import extraTools from "./tools/extras.js";
import moreTools from "./tools/more.js";
import blueprintTools from "./tools/blueprints.js";
import setupTools from "./tools/setup.js";
import eventTools from "./tools/events.js";
import jobTools from "./tools/jobs.js";
import automationTools from "./tools/automations.js";
import utilityTools from "./tools/utility.js";
import { VERSION } from "./version.js";
import { config } from "./config.js";
import { runCli } from "./cli.js";

const INSTRUCTIONS =
  "Tools to manage Discord servers through one or more bots. Start with setup_check (bots, their servers, what to fix); new bots are added with add_bot, which asks for the token in a private box (never ask for it in chat). Tools use the bot that is in the server you name. Call get_server before changing a server. " +
  "Channels, roles and members can be named instead of using ids. Before changing the server or sending messages, show the user what will happen and get their confirmation; deleting is permanent. Nobody is pinged unless ping_roles/ping_users/ping_everyone are set. " +
  "Every write tool accepts dry_run to preview; permanent actions need confirm: true. To build or complete a server show preview_blueprint, then apply_blueprint. " +
  "Only the core tools are on at first: when a task needs more (role menus, welcomes, tickets, live events, background jobs and backups, AutoMod and moderation, webhooks and DMs, emojis, scheduled events, onboarding, raw API calls), call enable_tools with the pack first; if the new tools do not appear, call them through use_tool. " +
  "Role menus, welcomes and tickets keep working while this server runs. " +
  "Set up only the features the user chose, with the options they chose; when a feature has variants (where a log goes, which commands, who gets alerts), ask before building, and show the plan first.";

/** A fully registered MCP server (one per HTTP session, or one for stdio). */
export function buildServer() {
  const mcp = new McpServer({ name: "discord-server-mcp", version: VERSION },
    { instructions: INSTRUCTIONS + (config.writeMode !== "full" ? ` Write mode is "${config.writeMode}".` : "") });
  const groupTool = (group) => registrar(mcp, group);
  for (const register of [setupTools, serverTools, channelTools, messageTools, memberTools, extraTools, moreTools,
    blueprintTools, eventTools, jobTools, automationTools, utilityTools]) {
    register(groupTool);
  }
  return mcp;
}

function startLive() {
  startGateway();
  startAutomations();
}

async function serveHttp(args) {
  const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.PORT) || 3333;
  const host = args.includes("--host") ? args[args.indexOf("--host") + 1] : "127.0.0.1";
  const secret = process.env.DISCORD_MCP_HTTP_TOKEN;
  if (!secret || secret.length < 16) {
    process.stderr.write("Set DISCORD_MCP_HTTP_TOKEN to a long random secret (16+ characters); clients send it as \"Authorization: Bearer <secret>\".\n");
    process.exit(1);
  }
  const sessions = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION,
        bots: config.bots.map((b) => ({ name: b.name, connected: Boolean(status.get(b.token)?.connected) })) }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        res.writeHead(400).end("Bad JSON");
        return;
      }
    }
    const sid = req.headers["mcp-session-id"];
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }));
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  server.listen(port, host, () => {
    process.stderr.write(`discord-server-mcp ${VERSION}: MCP over HTTP at http://${host}:${port}/mcp (Bearer token required)` +
      `${host === "127.0.0.1" ? "; only this computer can reach it (use --host 0.0.0.0 behind HTTPS to open it up)" : ""}\n`);
  });
  startLive();
}

async function runForever() {
  if (!config.bots.length) {
    process.stderr.write("No bot configured. Set DISCORD_BOT_TOKEN or run `discord-server-mcp init` first.\n");
    process.exit(1);
  }
  startLive();
  const a = automations();
  process.stdout.write(`discord-server-mcp ${VERSION} is running: ${config.bots.length} bot(s), ${a.role_menus.length} role menu(s), ` +
    `${a.welcomes.length} welcome(s), ${a.ticket_panels.length} ticket panel(s). Press Ctrl+C to stop.\n`);
  setInterval(() => {}, 1 << 30);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "serve" && rest.includes("--http")) {
  await serveHttp(rest);
} else if (command === "run") {
  await runForever();
} else if (command) {
  await runCli(command);
  process.exit(process.exitCode ?? 0);
} else {
  // Exit with the client: stdin closing means the client is gone.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  await buildServer().connect(new StdioServerTransport());
  startLive();
}
