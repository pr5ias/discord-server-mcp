// Optional gateway connection so the bot shows as online while the MCP server runs.
// It only sets a presence; it receives no events (intents 0).
import { config } from "./config.js";

const ACTIVITY = { playing: 0, listening: 2, watching: 3, competing: 5, custom: 4 };

const started = new Set();

/** Connects every configured bot that is not connected yet. */
export function startPresence() {
  for (const bot of config.bots) connectBot(bot.token);
}

function connectBot(token) {
  const p = config.presence;
  if (!token || started.has(token) || !p.enabled || typeof WebSocket === "undefined") return;
  started.add(token);

  let delay = 5000;
  const activity = () => {
    if (!p.text) return [];
    const type = ACTIVITY[p.type] ?? 3;
    return [type === 4 ? { name: "Custom Status", state: p.text, type } : { name: p.text, type }];
  };

  const connect = () => {
    let ws;
    let beat;
    let seq = null;
    try {
      ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    } catch {
      setTimeout(connect, delay);
      return;
    }
    const send = (op, d) => {
      try {
        ws.send(JSON.stringify({ op, d }));
      } catch {
        // socket closed; onclose reconnects
      }
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.s !== null && msg.s !== undefined) seq = msg.s;
      if (msg.op === 10) {
        clearInterval(beat);
        beat = setInterval(() => send(1, seq), msg.d.heartbeat_interval);
        send(2, {
          token,
          intents: 0,
          properties: { os: process.platform, browser: "discord-server-mcp", device: "discord-server-mcp" },
          presence: { status: p.status, since: null, afk: false, activities: activity() },
        });
      } else if (msg.op === 1) {
        send(1, seq);
      } else if (msg.op === 7 || msg.op === 9) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      } else if (msg.op === 0 && msg.t === "READY") {
        delay = 5000;
      }
    };
    ws.onclose = (event) => {
      clearInterval(beat);
      // 4004 bad token, 4013/4014 bad intents: retrying would not help.
      if ([4004, 4013, 4014].includes(event?.code)) {
        process.stderr.write(`discord-server-mcp: gateway closed (${event.code}); presence disabled.\n`);
        return;
      }
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 300000);
    };
    ws.onerror = () => {};
  };
  connect();
}
