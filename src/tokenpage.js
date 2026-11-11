// A one-time page on this computer (http://127.0.0.1) where the user pastes a bot token in their browser.
// Works in every app, because it does not depend on the app showing an input box.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add a Discord bot</title><style>
body{font-family:system-ui,sans-serif;background:#1e1f22;color:#f2f3f5;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#2b2d31;padding:32px;border-radius:12px;max-width:440px;width:calc(100% - 32px);box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px}p{color:#b5bac1;line-height:1.5;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #4e5058;background:#1e1f22;color:#f2f3f5;font-size:14px;margin:8px 0 16px}
button{background:#1fa37a;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:15px;cursor:pointer;width:100%}
.ok{color:#57f287}.err{color:#ed4245}code{background:#1e1f22;padding:2px 6px;border-radius:4px}
</style></head><body><main>${body}</main></body></html>`;

/**
 * Starts the page and returns { url, done }. `onToken(token)` checks and saves the token and returns
 * { ok, message }. The page stops after a success or after 15 minutes.
 */
export function startTokenPage(onToken, { label = "" } = {}) {
  const secret = randomBytes(16).toString("hex");
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== `/${secret}`) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET") {
      res.end(page(`<h1>Add your Discord bot</h1>
<p>Paste the bot's token (Developer Portal → your app → <b>Bot</b> → <b>Reset Token</b> → <b>Copy</b>).
It is saved on this computer only and never goes into the chat.</p>
<form method="post"><input name="token" type="password" autocomplete="off" placeholder="Bot token" required autofocus>
<input name="label" type="text" placeholder="Name for this bot (optional)" value="${label.replace(/"/g, "&quot;")}">
<button>Save the bot</button></form>`));
      return;
    }
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        res.writeHead(403).end();
        return;
      }
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 10000) req.destroy();
      });
      req.on("end", async () => {
        const form = new URLSearchParams(raw);
        const result = await onToken(String(form.get("token") || "").trim(), String(form.get("label") || "").trim());
        if (result.ok) {
          res.end(page(`<h1 class="ok">✓ ${result.message}</h1><p>You can close this tab and go back to Claude.</p>`));
          setTimeout(() => server.close(), 500);
          resolveDone(result);
        } else {
          res.end(page(`<h1 class="err">That did not work</h1><p>${result.message}</p><p><a href="/${secret}" style="color:#00a8fc">Try again</a></p>`));
        }
      });
      return;
    }
    res.writeHead(405).end();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const timer = setTimeout(() => {
        server.close();
        resolveDone({ ok: false, message: "timed out" });
      }, 15 * 60 * 1000);
      timer.unref();
      server.unref();
      resolve({ url: `http://127.0.0.1:${port}/${secret}`, done });
    });
  });
}
