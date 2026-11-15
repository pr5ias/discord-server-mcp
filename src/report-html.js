// The feedback report as one self-contained HTML page: stat tiles, charts, a map of the server and tables.
// Everything is drawn in the browser from the embedded data, so the filters (project, area, period, search)
// change every chart, number and table at once. No external files or network: it opens offline.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

export function reportHtml({ title, server, generated, items, map, repeated, stop }) {
  const data = {
    title, server, generated,
    items: items.map((i) => ({
      k: i.kind, a: i.area, c: i.channel, t: i.title, x: (i.text || "").slice(0, 1500), p: i.projects || [], s: i.status || [], g: i.tags || [],
      au: i.author, r: i.reactions || 0, rp: i.replies ?? null, d: i.created, l: i.link, tone: i.sentiment ?? 0,
    })),
    map: map ? { projects: map.projects.map((p) => p.name), channels: map.channels.filter((c) => c.area !== "voice").map((c) => ({ n: c.name, a: c.area, p: c.projects, f: c.feedback })) } : null,
    repeated: repeated || [],
    stop: [...(stop || [])],
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="viz-root">
  <header class="top">
    <div>
      <h1>${esc(title)}</h1>
      <p class="sub">${esc(server)} · generated ${esc(generated.replace("T", " ").slice(0, 16))} · <span id="scope"></span></p>
    </div>
    <button id="theme" type="button" class="ghost" aria-label="Switch light or dark theme">◐ Theme</button>
  </header>

  <nav class="filters" aria-label="Filters">
    <label>Period <select id="f-range"><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label>
    <label>Project <select id="f-project"></select></label>
    <label>Area <select id="f-area"></select></label>
    <label class="grow">Search <input id="f-search" type="search" placeholder="Words in titles or posts"></label>
  </nav>

  <section class="tiles" id="tiles" aria-label="Key numbers"></section>

  <section class="grid">
    <figure class="card wide"><figcaption><h2>Feedback by project</h2><p>Posts per project, split by area</p></figcaption><div id="c-projects" class="chart"></div></figure>
    <figure class="card"><figcaption><h2>Tone by project</h2><p>Average tone of posts and replies, −1 negative … +1 positive</p></figcaption><div id="c-tone" class="chart"></div></figure>
    <figure class="card"><figcaption><h2>Tone mix by area</h2><p>Share of negative, neutral and positive posts</p></figcaption><div id="c-mix" class="chart"></div></figure>
    <figure class="card wide"><figcaption><h2>Activity over time</h2><p id="c-time-sub">Posts and replies</p></figcaption><div id="c-time" class="chart"></div></figure>
    <figure class="card"><figcaption><h2>Recurring themes</h2><p>Words and phrases in the most posts</p></figcaption><div id="c-themes" class="chart"></div></figure>
    <figure class="card"><figcaption><h2>Where feedback lives</h2><p>Posts per project and area</p></figcaption><div id="c-heat" class="chart"></div></figure>
    <figure class="card"><figcaption><h2>Status of posts</h2><p>From the forum tags</p></figcaption><div id="c-status" class="chart"></div></figure>
    <figure class="card"><figcaption><h2>Most active people</h2><p>Posts and replies per person</p></figcaption><div id="c-people" class="chart"></div></figure>
  </section>

  <section class="card"><h2>Open bugs</h2><div id="t-bugs"></div></section>
  <section class="card"><h2>Asked or reported more than once</h2><div id="t-repeat"></div></section>
  <section class="grid two">
    <section class="card"><h2>Most discussed</h2><div id="t-discussed"></div></section>
    <section class="card"><h2>Most negative</h2><div id="t-negative"></div></section>
  </section>
  <section class="card"><div class="row"><h2>Server map</h2><p class="muted">What each channel is for and the projects it is about</p></div><div id="map"></div></section>
  <section class="card"><div class="row"><h2>All posts</h2><button id="csv" type="button" class="ghost">Download CSV</button></div><div id="t-all"></div></section>

  <footer class="muted">Tone is a word-list hint (English, Portuguese, some Spanish and German): read the posts before drawing conclusions. People are shown as member-1, member-2… unless the report was made with their names.</footer>
</div>
<div id="tip" role="tooltip" hidden></div>
<script type="application/json" id="data">${json(data)}</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
.viz-root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--other:#a8a7a0;
--neg:#e34948;--mid:#d9d8d2;--pos:#2a78d6;--q1:#cde2fb;--q2:#86b6ef;--q3:#3987e5;--q4:#1c5cab;--q5:#0d366b;--critical:#d03b3b;--good:#0ca30c}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--other:#6e6d68;--neg:#e66767;--mid:#383835;--pos:#3987e5;--q1:#104281;--q2:#1c5cab;--q3:#2a78d6;--q4:#6da7ec;--q5:#b7d3f6}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--other:#6e6d68;--neg:#e66767;--mid:#383835;--pos:#3987e5;--q1:#104281;--q2:#1c5cab;--q3:#2a78d6;--q4:#6da7ec;--q5:#b7d3f6}
*{box-sizing:border-box}
html,body{margin:0}
body{background:#f9f9f7}
:root[data-theme="dark"] body{background:#0d0d0d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) body{background:#0d0d0d}}
.viz-root{background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;padding:24px 16px 48px;max-width:1240px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;margin:0}
.sub,.muted,figcaption p{color:var(--ink2);margin:2px 0 0;font-size:13px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px}
.ghost{background:transparent;border:1px solid var(--ring);color:var(--ink);border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}
.ghost:hover{background:var(--ring)}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:16px;position:sticky;top:0;z-index:5;background:var(--page);padding:8px 0}
.filters label{display:flex;flex-direction:column;font-size:12px;color:var(--ink2);gap:4px}
.filters .grow{flex:1;min-width:180px}
select,input{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:6px 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:12px 14px}
.tile .v{font-size:26px;font-weight:600;margin-top:2px}
.tile .k{color:var(--ink2);font-size:12px}
.tile .n{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px}
.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px;margin:0 0 12px;min-width:0}
.grid .card{margin:0}
.wide{grid-column:1/-1}
figure{margin:0}
.chart{margin-top:10px;width:100%;overflow:hidden}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--ink2);margin-top:8px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px}
.legend i.line{height:2px;width:14px;border-radius:1px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--grid);vertical-align:top}
th{color:var(--ink2);font-weight:600;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td a{color:var(--s1)}
.tbl{overflow-x:auto}
.chip{display:inline-block;border:1px solid var(--ring);border-radius:999px;padding:0 7px;font-size:11px;color:var(--ink2);margin:1px 3px 1px 0;white-space:nowrap}
.tone{font-variant-numeric:tabular-nums;white-space:nowrap}
.tone::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--mid);vertical-align:0}
.tone.neg::before{background:var(--neg)}.tone.pos::before{background:var(--pos)}
.empty{color:var(--muted);padding:12px 0}
.map{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:10px}
.area{border:1px solid var(--ring);border-radius:10px;padding:10px}
.area h3{font-size:13px;margin:0 0 6px}
.area h3 span{text-transform:capitalize}
.area h3 small{color:var(--muted);font-weight:400}
.area li{list-style:none;margin:3px 0;font-size:12.5px}
.area ul{margin:0;padding:0}
.area .fb{color:var(--s1);font-size:11px}
#tip{position:fixed;pointer-events:none;z-index:20;background:var(--surface,#fff);color:var(--ink,#0b0b0b);border:1px solid rgba(11,11,11,.12);border-radius:8px;padding:8px 10px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.12);max-width:280px}
#tip b{font-size:14px}
#tip .key{display:inline-block;width:12px;height:2px;margin-right:6px;vertical-align:3px}
.hit{cursor:default}
.hit:hover,.hit:focus{opacity:.82;outline:none}
footer{margin-top:16px;font-size:12px}
@media (max-width:760px){.grid,.grid.two{grid-template-columns:1fr}.tile .v{font-size:22px}}
`;

const JS = String.raw`
(() => {
const D = JSON.parse(document.getElementById("data").textContent);
const $ = (id) => document.getElementById(id);
const AREAS = ["bugs", "suggestions", "reviews", "support", "tickets"];
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"];
const css = (v) => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(v).trim();
const areaList = [...new Set([...AREAS.filter((a) => D.items.some((i) => i.a === a)), ...D.items.map((i) => i.a)])];
const areaColor = (a) => { const i = areaList.indexOf(a); return i >= 0 && i < SLOTS.length ? "var(" + SLOTS[i] + ")" : "var(--other)"; };
const projects = [...new Set(D.items.flatMap((i) => i.p.length ? i.p : ["(no project)"]))].sort((a, b) => a === "(no project)" ? 1 : b === "(no project)" ? -1 : a.localeCompare(b));
const projOf = (i) => (i.p.length ? i.p : ["(no project)"]);
const isPost = (i) => i.k !== "reply";
const closed = (i) => i.s.some((s) => /solved|resolved|fixed|closed|done|implemented|rejected|denied|duplicate|wontfix|resolvido|corrigido|fechado|rejeitado/i.test(s));
const fmtTone = (n) => (n > 0 ? "+" : "") + n.toFixed(2);
const toneClass = (n) => (n > 0.05 ? "pos" : n < -0.05 ? "neg" : "");
const label = (i) => i.t || (i.x || "").replace(/\s+/g, " ").slice(0, 90);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const STOP = new Set(D.stop);

// ---------------------------------------------------------------- filters
const opt = (sel, values, all) => { sel.innerHTML = ""; [["all", all], ...values.map((v) => [v, v])].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }); };
opt($("f-project"), projects, "All projects");
opt($("f-area"), areaList, "All areas");
const state = { range: "all", project: "all", area: "all", q: "" };
for (const [id, key] of [["f-range", "range"], ["f-project", "project"], ["f-area", "area"]]) $(id).addEventListener("change", (e) => { state[key] = e.target.value; render(); });
$("f-search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
const latest = Math.max(...D.items.map((i) => Date.parse(i.d) || 0));
function filtered() {
  return D.items.filter((i) => {
    if (state.range !== "all" && (Date.parse(i.d) || 0) < latest - Number(state.range) * 864e5) return false;
    if (state.project !== "all" && !projOf(i).includes(state.project)) return false;
    if (state.area !== "all" && i.a !== state.area) return false;
    if (state.q && !((i.t || "") + " " + i.x).toLowerCase().includes(state.q)) return false;
    return true;
  });
}

// ---------------------------------------------------------------- tooltip
const tip = $("tip");
function showTip(e, rows) {
  tip.replaceChildren();
  rows.forEach((r, n) => {
    const line = document.createElement("div");
    if (r.color) { const k = document.createElement("span"); k.className = "key"; k.style.background = r.color; line.appendChild(k); }
    if (r.value !== undefined) { const b = document.createElement("b"); b.textContent = r.value; line.appendChild(b); line.appendChild(document.createTextNode(" ")); }
    const t = document.createElement("span"); t.textContent = r.text; if (n === 0 && r.value === undefined) t.style.fontWeight = "600"; line.appendChild(t);
    tip.appendChild(line);
  });
  tip.hidden = false;
  const box = (e.target.getBoundingClientRect && e.clientX === undefined) ? e.target.getBoundingClientRect() : null;
  const x = box ? box.right : e.clientX, y = box ? box.top : e.clientY;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(innerWidth - w - 8, x + 12) + "px";
  tip.style.top = Math.max(8, Math.min(innerHeight - h - 8, y + 12)) + "px";
}
const hideTip = () => { tip.hidden = true; };
function bindTips(root) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    const rows = JSON.parse(el.dataset.tip);
    el.addEventListener("pointermove", (e) => showTip(e, rows));
    el.addEventListener("focus", (e) => showTip(e, rows));
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("blur", hideTip);
  });
}
const tipAttr = (rows) => " tabindex=\"0\" class=\"hit\" data-tip='" + JSON.stringify(rows).replace(/&/g, "&amp;").replace(/'/g, "&#39;") + "'";
const escx = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- chart helpers
let W = 640;
const fit = (id) => { W = Math.max(300, Math.round($(id).clientWidth) || 640); return W; };
function legend(entries, line) {
  return "<div class=\"legend\">" + entries.map(([name, color]) => "<span><i class=\"" + (line ? "line" : "") + "\" style=\"background:" + color + "\"></i>" + escx(name) + "</span>").join("") + "</div>";
}
// Counts: whole-number steps (1, 2, 5, 10, 20, 25, 50…) and a top that is a multiple of the step.
const stepOf = (m) => { const raw = Math.max(1, m) / 4, p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= raw && (x >= 1 ? Number.isInteger(x) : true)) || 1; };
const niceMax = (m) => { const st = Math.max(1, stepOf(m)); return Math.ceil(Math.max(1, m) / st) * st; };
const ticks = (max) => { const st = max === 100 ? 25 : Math.max(1, stepOf(max)); const out = []; for (let v = 0; v <= max + 1e-9; v += st) out.push(Math.round(v * 100) / 100); return out; };
function empty() { return "<p class=\"empty\">Nothing to show for these filters.</p>"; }

// Horizontal bars, one row per category; each row is one or more stacked segments.
function hbars(id, rows, { stacked = true, max, labelW = 150, valueLabel = true, fmt = (v) => v } = {}) {
  if (!rows.length) return empty(id);
  fit(id);
  const rowH = 26, gap = 10, top = 4, plotW = W - labelW - 40;
  const total = (r) => r.segs.reduce((s, x) => s + x.v, 0);
  const M = max ?? niceMax(Math.max(...rows.map(total)));
  const h = top + rows.length * (rowH + gap) + 22;
  let s = "<svg viewBox=\"0 0 " + W + " " + h + "\" role=\"img\" aria-label=\"" + escx($(id).closest("figure")?.querySelector("h2")?.textContent || "chart") + "\">";
  for (const t of ticks(M)) { const x = labelW + t / M * plotW; s += "<line x1=\"" + x + "\" x2=\"" + x + "\" y1=\"0\" y2=\"" + (h - 20) + "\" stroke=\"var(--grid)\"/><text x=\"" + x + "\" y=\"" + (h - 6) + "\" fill=\"var(--muted)\" font-size=\"11\" text-anchor=\"middle\">" + fmt(t) + "</text>"; }
  rows.forEach((r, i) => {
    const y = top + i * (rowH + gap);
    s += "<text x=\"" + (labelW - 8) + "\" y=\"" + (y + rowH / 2 + 4) + "\" fill=\"var(--ink2)\" font-size=\"12\" text-anchor=\"end\">" + escx(r.name.length > 22 ? r.name.slice(0, 21) + "…" : r.name) + "</text>";
    let x = labelW;
    const segs = r.segs.filter((g) => g.v > 0);
    segs.forEach((g, j) => {
      const w = Math.max(1, g.v / M * plotW - (j < segs.length - 1 ? 2 : 0));
      const last = j === segs.length - 1;
      const path = last && w > 4 ? "M" + x + "," + y + "h" + (w - 4) + "a4,4 0 0 1 4,4v" + (rowH - 8) + "a4,4 0 0 1 -4,4h" + (-(w - 4)) + "z" : "M" + x + "," + y + "h" + w + "v" + rowH + "h" + (-w) + "z";
      s += "<path d=\"" + path + "\" fill=\"" + g.c + "\"" + tipAttr([{ text: r.name }, { value: fmt(g.v), text: g.n, color: g.c }]) + "/>";
      x += w + 2;
    });
    if (valueLabel) s += "<text x=\"" + (x + 4) + "\" y=\"" + (y + rowH / 2 + 4) + "\" fill=\"var(--ink)\" font-size=\"12\" font-variant-numeric=\"tabular-nums\">" + fmt(total(r)) + "</text>";
  });
  return s + "</svg>";
}

// Diverging bars around zero (tone).
function divbars(id, rows, labelW = 150) {
  if (!rows.length) return empty(id);
  fit(id);
  const rowH = 24, gap = 10, plotW = W - labelW - 50, mid = labelW + plotW / 2;
  const h = rows.length * (rowH + gap) + 24;
  let s = "<svg viewBox=\"0 0 " + W + " " + h + "\" role=\"img\" aria-label=\"Tone by project\">";
  for (const t of [-1, -0.5, 0, 0.5, 1]) { const x = mid + t * plotW / 2; s += "<line x1=\"" + x + "\" x2=\"" + x + "\" y1=\"0\" y2=\"" + (h - 20) + "\" stroke=\"" + (t === 0 ? "var(--axis)" : "var(--grid)") + "\"/><text x=\"" + x + "\" y=\"" + (h - 6) + "\" fill=\"var(--muted)\" font-size=\"11\" text-anchor=\"middle\">" + (t > 0 ? "+" : "") + t + "</text>"; }
  rows.forEach((r, i) => {
    const y = i * (rowH + gap), w = Math.abs(r.v) * plotW / 2, x = r.v >= 0 ? mid : mid - w;
    const c = r.v >= 0 ? "var(--pos)" : "var(--neg)";
    s += "<text x=\"" + (labelW - 8) + "\" y=\"" + (y + rowH / 2 + 4) + "\" fill=\"var(--ink2)\" font-size=\"12\" text-anchor=\"end\">" + escx(r.name) + "</text>";
    s += "<rect x=\"" + x + "\" y=\"" + y + "\" width=\"" + Math.max(1.5, w) + "\" height=\"" + rowH + "\" rx=\"4\" fill=\"" + c + "\"" + tipAttr([{ text: r.name }, { value: fmtTone(r.v), text: "average tone", color: c }, { text: r.neg + " negative · " + r.neu + " neutral · " + r.pos + " positive" }]) + "/>";
    s += "<text x=\"" + (r.v >= 0 ? x + w + 6 : x - 6) + "\" y=\"" + (y + rowH / 2 + 4) + "\" fill=\"var(--ink)\" font-size=\"12\" text-anchor=\"" + (r.v >= 0 ? "start" : "end") + "\">" + fmtTone(r.v) + "</text>";
  });
  return s + "</svg>";
}

// Stacked columns over time; each column is one hover target listing every series.
function columns(id, buckets, series) {
  if (!buckets.length) { $(id).innerHTML = empty(); return; }
  const Wc = fit(id), L = 36, R = 8, T = 8, B = 26, H = 220, plotW = Wc - L - R, plotH = H - T - B;
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + x.vals[i], 0));
  const M = niceMax(Math.max(1, ...totals));
  const Y = (v) => T + plotH - v / M * plotH;
  const slot = plotW / buckets.length, bw = Math.max(2, Math.min(28, slot - 2));
  let s = "<svg viewBox=\"0 0 " + Wc + " " + H + "\" role=\"img\" aria-label=\"Activity over time\">";
  for (const t of ticks(M)) s += "<line x1=\"" + L + "\" x2=\"" + (Wc - R) + "\" y1=\"" + Y(t) + "\" y2=\"" + Y(t) + "\" stroke=\"var(--grid)\"/><text x=\"" + (L - 6) + "\" y=\"" + (Y(t) + 4) + "\" fill=\"var(--muted)\" font-size=\"11\" text-anchor=\"end\">" + t + "</text>";
  const every = Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 70)));
  buckets.forEach((b, i) => {
    const cx = L + slot * i + slot / 2;
    if (i % every === 0) s += "<text x=\"" + cx + "\" y=\"" + (H - 6) + "\" fill=\"var(--muted)\" font-size=\"11\" text-anchor=\"middle\">" + escx(b.label) + "</text>";
    let y = T + plotH;
    const segs = series.map((x) => ({ x, v: x.vals[i] })).filter((g) => g.v > 0);
    segs.forEach((g, j) => {
      const h = g.v / M * plotH - (j < segs.length - 1 ? 2 : 0);
      const top = j === segs.length - 1;
      const x0 = cx - bw / 2;
      const d = top && h > 4 ? "M" + x0 + "," + y + "v" + (-(h - 4)) + "a4,4 0 0 1 4,-4h" + (bw - 8) + "a4,4 0 0 1 4,4v" + (h - 4) + "z" : "M" + x0 + "," + y + "v" + (-h) + "h" + bw + "v" + h + "z";
      s += "<path d=\"" + d + "\" fill=\"" + g.x.c + "\" pointer-events=\"none\"/>";
      y -= h + 2;
    });
    s += "<rect x=\"" + (L + slot * i) + "\" y=\"" + T + "\" width=\"" + slot + "\" height=\"" + plotH + "\" fill=\"transparent\"" + tipAttr([{ text: b.full }, ...series.map((x) => ({ value: x.vals[i], text: x.name, color: x.c })), { text: totals[i] + " in total" }]) + "/>";
  });
  s += "</svg>" + legend(series.map((x) => [x.name, x.c]));
  $(id).innerHTML = s;
}

// Heatmap: rows × columns of counts on the sequential ramp.
function heat(id, rows, cols, val) {
  if (!rows.length || !cols.length) return empty(id);
  fit(id);
  const labelW = 140, top = 26, cw = Math.min(90, (W - labelW) / cols.length), ch = 30;
  const M = Math.max(1, ...rows.flatMap((r) => cols.map((c) => val(r, c))));
  const step = (v) => (v === 0 ? "var(--grid)" : "var(--q" + Math.min(5, 1 + Math.floor(v / M * 4.999)) + ")");
  const h = top + rows.length * ch + 4;
  let s = "<svg viewBox=\"0 0 " + (labelW + cols.length * cw) + " " + h + "\" role=\"img\" aria-label=\"Posts per project and area\">";
  cols.forEach((c, j) => { s += "<text x=\"" + (labelW + j * cw + cw / 2) + "\" y=\"16\" fill=\"var(--ink2)\" font-size=\"11\" text-anchor=\"middle\">" + escx(c) + "</text>"; });
  rows.forEach((r, i) => {
    const y = top + i * ch;
    s += "<text x=\"" + (labelW - 8) + "\" y=\"" + (y + ch / 2 + 4) + "\" fill=\"var(--ink2)\" font-size=\"12\" text-anchor=\"end\">" + escx(r.length > 20 ? r.slice(0, 19) + "…" : r) + "</text>";
    cols.forEach((c, j) => {
      const v = val(r, c), dark = v / M > 0.55;
      s += "<rect x=\"" + (labelW + j * cw + 1) + "\" y=\"" + (y + 1) + "\" width=\"" + (cw - 2) + "\" height=\"" + (ch - 2) + "\" rx=\"4\" fill=\"" + step(v) + "\"" + tipAttr([{ text: r + " · " + c }, { value: v, text: v === 1 ? "post" : "posts" }]) + "/>";
      if (v) s += "<text x=\"" + (labelW + j * cw + cw / 2) + "\" y=\"" + (y + ch / 2 + 4) + "\" fill=\"" + (dark ? "#ffffff" : "var(--ink)") + "\" font-size=\"12\" text-anchor=\"middle\" pointer-events=\"none\">" + v + "</text>";
    });
  });
  return s + "</svg>";
}

// ---------------------------------------------------------------- tables
function table(id, cols, rows, { sortable = false, limit = 0 } = {}) {
  if (!rows.length) { $(id).innerHTML = empty(); return; }
  const el = $(id);
  let sortCol = -1, dir = 1;
  const draw = () => {
    let rs = rows.slice();
    if (sortCol >= 0) rs.sort((a, b) => { const x = cols[sortCol].sort(a), y = cols[sortCol].sort(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    if (limit) rs = rs.slice(0, limit);
    const t = document.createElement("table");
    const hr = t.createTHead().insertRow();
    cols.forEach((c, n) => { const th = document.createElement("th"); th.textContent = c.h + (sortCol === n ? (dir > 0 ? " ↑" : " ↓") : ""); if (c.num) th.className = "num"; if (sortable && c.sort) th.addEventListener("click", () => { dir = sortCol === n ? -dir : (c.num ? -1 : 1); sortCol = n; draw(); }); hr.appendChild(th); });
    const tb = t.createTBody();
    for (const r of rs) { const tr = tb.insertRow(); cols.forEach((c) => { const td = tr.insertCell(); if (c.num) td.className = "num"; c.cell(td, r); }); }
    const wrap = document.createElement("div"); wrap.className = "tbl"; wrap.appendChild(t);
    el.replaceChildren(wrap);
  };
  draw();
}
const textCell = (f) => (td, r) => { const v = f(r); td.textContent = v === null || v === undefined ? "–" : v; };
const linkCell = (td, r) => { if (r.l) { const a = document.createElement("a"); a.href = r.l; a.target = "_blank"; a.rel = "noopener"; a.textContent = label(r); td.appendChild(a); } else td.textContent = label(r); };
const chipsCell = (f) => (td, r) => { for (const v of f(r)) { const s = document.createElement("span"); s.className = "chip"; s.textContent = v; td.appendChild(s); } };
const toneCell = (td, r) => { const s = document.createElement("span"); s.className = "tone " + toneClass(r.tone); s.textContent = fmtTone(r.tone); td.appendChild(s); };

// ---------------------------------------------------------------- render
function words(s) { return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).map((w) => w.replace(/^[-']+|[-']+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) && !["game", "pack", "modpack", "mod"].includes(w)); }
function render() {
  const items = filtered(), posts = items.filter(isPost);
  const scope = [state.project !== "all" && state.project, state.area !== "all" && state.area, state.range !== "all" && "last " + state.range + " days", state.q && "“" + state.q + "”"].filter(Boolean);
  $("scope").textContent = scope.length ? "showing " + scope.join(" · ") : "showing everything";

  // Tiles
  const people = new Set(items.map((i) => i.au)).size;
  const bugs = posts.filter((i) => i.a === "bugs"), openBugs = bugs.filter((i) => !closed(i));
  const threads = posts.filter((i) => i.rp !== null);
  const answered = threads.filter((i) => i.rp > 0).length;
  const tone = avg(items.map((i) => i.tone));
  const tiles = [
    ["Posts", posts.length, items.length - posts.length + " replies"],
    ["People", people, "who wrote"],
    ["Open bugs", openBugs.length, bugs.length ? Math.round((bugs.length - openBugs.length) / bugs.length * 100) + "% of bugs closed" : "no bugs"],
    ["Average tone", fmtTone(tone), tone > 0.05 ? "leaning positive" : tone < -0.05 ? "leaning negative" : "about neutral"],
    ["Answered", threads.length ? Math.round(answered / threads.length * 100) + "%" : "–", answered + " of " + threads.length + " posts have replies"],
    ["Negative posts", posts.filter((i) => i.tone < 0).length, posts.length ? Math.round(posts.filter((i) => i.tone < 0).length / posts.length * 100) + "% of posts" : ""],
  ];
  $("tiles").innerHTML = tiles.map(([k, v, n]) => "<div class=\"tile\"><div class=\"k\">" + escx(k) + "</div><div class=\"v\">" + escx(v) + "</div><div class=\"n\">" + escx(n) + "</div></div>").join("");

  const shownProjects = projects.filter((p) => posts.some((i) => projOf(i).includes(p)));
  const shownAreas = areaList.filter((a) => posts.some((i) => i.a === a));

  // Projects × areas
  const projRows = shownProjects.map((p) => ({ name: p, segs: shownAreas.map((a) => ({ n: a, v: posts.filter((i) => i.a === a && projOf(i).includes(p)).length, c: areaColor(a) })) }));
  $("c-projects").innerHTML = (hbars("c-projects", projRows) || "") + (projRows.length ? legend(shownAreas.map((a) => [a, areaColor(a)])) : "");

  // Tone by project
  const toneRows = shownProjects.map((p) => { const mine = items.filter((i) => projOf(i).includes(p)); return { name: p, v: avg(mine.map((i) => i.tone)), neg: mine.filter((i) => i.tone < 0).length, neu: mine.filter((i) => i.tone === 0).length, pos: mine.filter((i) => i.tone > 0).length }; });
  $("c-tone").innerHTML = divbars("c-tone", toneRows) || "";

  // Tone mix by area (100%)
  const mixRows = shownAreas.map((a) => { const mine = posts.filter((i) => i.a === a), n = mine.length || 1; return { name: a, segs: [
    { n: "negative", v: Math.round(mine.filter((i) => i.tone < 0).length / n * 100), c: "var(--neg)" },
    { n: "neutral", v: Math.round(mine.filter((i) => i.tone === 0).length / n * 100), c: "var(--mid)" },
    { n: "positive", v: Math.round(mine.filter((i) => i.tone > 0).length / n * 100), c: "var(--pos)" }] }; });
  $("c-mix").innerHTML = (hbars("c-mix", mixRows, { max: 100, valueLabel: false, fmt: (v) => v + "%", labelW: 110 }) || "") + (mixRows.length ? legend([["negative", "var(--neg)"], ["neutral", "var(--mid)"], ["positive", "var(--pos)"]]) : "");

  // Over time
  const dated = items.filter((i) => Date.parse(i.d));
  if (dated.length) {
    const t0 = Math.min(...dated.map((i) => Date.parse(i.d))), t1 = Math.max(...dated.map((i) => Date.parse(i.d)));
    const span = t1 - t0;
    const unit = span <= 2 * 864e5 ? 36e5 : span <= 120 * 864e5 ? 864e5 : 7 * 864e5;
    const start = Math.floor(t0 / unit) * unit, n = Math.floor((t1 - start) / unit) + 1;
    const fmtB = (t) => { const d = new Date(t); return unit === 36e5 ? d.toISOString().slice(11, 13) + "h" : d.toISOString().slice(5, 10); };
    const buckets = Array.from({ length: n }, (_, i) => ({ label: fmtB(start + i * unit), full: unit === 36e5 ? new Date(start + i * unit).toISOString().slice(0, 13).replace("T", " ") + ":00" : (unit === 7 * 864e5 ? "Week of " : "") + new Date(start + i * unit).toISOString().slice(0, 10) }));
    const top = shownProjects.filter((p) => p !== "(no project)").slice(0, 3);
    const series = top.map((p, j) => ({ name: p, c: "var(" + SLOTS[j] + ")", vals: buckets.map((_, b) => dated.filter((i) => projOf(i).includes(p) && Math.floor((Date.parse(i.d) - start) / unit) === b).length) }));
    const rest = dated.filter((i) => !projOf(i).some((p) => top.includes(p)));
    if (rest.length) series.push({ name: shownProjects.length > top.length + 1 ? "Other" : "(no project)", c: "var(--other)", vals: buckets.map((_, b) => rest.filter((i) => Math.floor((Date.parse(i.d) - start) / unit) === b).length) });
    $("c-time-sub").textContent = "Posts and replies per " + (unit === 36e5 ? "hour" : unit === 864e5 ? "day" : "week");
    columns("c-time", buckets, series);
  } else $("c-time").innerHTML = empty();

  // Themes (counted once per post or reply)
  const counts = new Map(), pairs = new Map();
  const pw = new Set(projects.flatMap((p) => words(p)));
  for (const i of items) {
    const ws = words((i.k === "reply" ? "" : (i.t || "")) + " " + i.x).filter((w) => !pw.has(w));
    for (const w of new Set(ws)) counts.set(w, (counts.get(w) || 0) + 1);
    for (const p of new Set(ws.slice(1).map((w, j) => ws[j] + " " + w))) pairs.set(p, (pairs.get(p) || 0) + 1);
  }
  const themeList = [...[...pairs].filter(([, n]) => n >= 2), ...[...counts].filter(([, n]) => n >= 2)].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const seen = new Set(), themes = [];
  for (const [t, n] of themeList) { if (t.split(" ").every((w) => seen.has(w)) && !t.includes(" ")) continue; themes.push([t, n]); t.split(" ").forEach((w) => seen.add(w)); if (themes.length >= 10) break; }
  $("c-themes").innerHTML = hbars("c-themes", themes.map(([t, n]) => ({ name: t, segs: [{ n: "posts mentioning it", v: n, c: "var(--s1)" }] })), { labelW: 130 }) || "";

  // Heatmap
  $("c-heat").innerHTML = heat("c-heat", shownProjects, shownAreas, (p, a) => posts.filter((i) => i.a === a && projOf(i).includes(p)).length) || "";

  // Status
  const st = new Map();
  for (const i of posts) for (const s of i.s.length ? i.s : ["no status"]) st.set(s, (st.get(s) || 0) + 1);
  $("c-status").innerHTML = hbars("c-status", [...st].sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ name: s, segs: [{ n: "posts", v: n, c: s === "no status" ? "var(--other)" : "var(--s1)" }] })), { labelW: 110 }) || "";

  // People
  const pc = new Map();
  for (const i of items) { const c = pc.get(i.au) || { p: 0, r: 0 }; i.k === "reply" ? c.r++ : c.p++; pc.set(i.au, c); }
  $("c-people").innerHTML = (hbars("c-people", [...pc].sort((a, b) => (b[1].p + b[1].r) - (a[1].p + a[1].r)).slice(0, 8).map(([n, c]) => ({ name: n, segs: [{ n: "posts", v: c.p, c: "var(--s1)" }, { n: "replies", v: c.r, c: "var(--s2)" }] })), { labelW: 110 }) || "") + (pc.size ? legend([["posts", "var(--s1)"], ["replies", "var(--s2)"]]) : "");

  // Tables
  table("t-bugs", [{ h: "Bug", cell: linkCell }, { h: "Project", cell: chipsCell((r) => projOf(r)) }, { h: "Status", cell: chipsCell((r) => r.s) }, { h: "Replies", num: true, cell: textCell((r) => r.rp) }, { h: "Reactions", num: true, cell: textCell((r) => r.r) }, { h: "Tone", cell: toneCell }],
    openBugs.sort((a, b) => (b.r + b.rp * 2) - (a.r + a.rp * 2)));
  const visible = new Set(posts.map(label));
  const rep = D.repeated.filter((g) => g.posts.filter((p) => visible.has(p)).length > 1);
  table("t-repeat", [{ h: "About", cell: textCell((g) => g.about) }, { h: "Area", cell: textCell((g) => g.area || "") }, { h: "Posts", num: true, cell: textCell((g) => g.posts.length) }, { h: "Titles", cell: (td, g) => { td.textContent = g.posts.join(" · "); } }], rep);
  table("t-discussed", [{ h: "Post", cell: linkCell }, { h: "Area", cell: textCell((r) => r.a) }, { h: "Replies", num: true, cell: textCell((r) => r.rp) }, { h: "Reactions", num: true, cell: textCell((r) => r.r) }],
    posts.slice().sort((a, b) => (b.r + b.rp * 2) - (a.r + a.rp * 2)).filter((i) => i.r + i.rp > 0).slice(0, 8));
  table("t-negative", [{ h: "Post", cell: linkCell }, { h: "Area", cell: textCell((r) => r.a) }, { h: "Tone", cell: toneCell }],
    posts.filter((i) => i.tone < 0).sort((a, b) => a.tone - b.tone || (b.r + b.rp) - (a.r + a.rp)).slice(0, 8));
  table("t-all", [
    { h: "Post", cell: (td, r) => { linkCell(td, r); if (r.t && r.x) { const p = document.createElement("div"); p.className = "muted"; p.textContent = r.x.slice(0, 160) + (r.x.length > 160 ? "…" : ""); td.appendChild(p); } }, sort: (r) => label(r).toLowerCase() },
    { h: "Area", cell: textCell((r) => r.a), sort: (r) => r.a },
    { h: "Project", cell: chipsCell((r) => projOf(r)), sort: (r) => projOf(r)[0] },
    { h: "Status", cell: chipsCell((r) => r.s), sort: (r) => r.s.join() },
    { h: "By", cell: textCell((r) => r.au), sort: (r) => r.au || "" },
    { h: "Replies", num: true, cell: textCell((r) => r.rp), sort: (r) => r.rp },
    { h: "Reactions", num: true, cell: textCell((r) => r.r), sort: (r) => r.r },
    { h: "Tone", cell: toneCell, sort: (r) => r.tone },
    { h: "Date", cell: textCell((r) => (r.d || "").slice(0, 10)), sort: (r) => r.d || "" },
  ], posts, { sortable: true });

  bindTips(document.querySelector(".viz-root"));
}

// ---------------------------------------------------------------- map (not filtered: the structure of the server)
if (D.map) {
  const by = {};
  for (const c of D.map.channels) (by[c.a] ||= []).push(c);
  const order = ["bugs", "suggestions", "reviews", "support", "tickets", "forum", "announcements", "showcase", "chat", "info", "staff", "other"];
  const box = document.createElement("div"); box.className = "map";
  for (const a of order.filter((x) => by[x]).concat(Object.keys(by).filter((x) => !order.includes(x)))) {
    const card = document.createElement("div"); card.className = "area";
    const h = document.createElement("h3"); const hn = document.createElement("span"); hn.textContent = a + " "; h.appendChild(hn); const sm = document.createElement("small"); sm.textContent = by[a].length + (by[a].length === 1 ? " channel" : " channels") + (by[a].some((c) => c.f) ? " · read for feedback" : ""); h.appendChild(sm); card.appendChild(h);
    const ul = document.createElement("ul");
    for (const c of by[a]) { const li = document.createElement("li"); li.textContent = "#" + c.n + " "; for (const p of c.p) { const s = document.createElement("span"); s.className = "chip"; s.textContent = p; li.appendChild(s); } ul.appendChild(li); }
    card.appendChild(ul); box.appendChild(card);
  }
  const head = document.createElement("p"); head.className = "muted";
  head.textContent = D.map.projects.length ? "Projects found: " + D.map.projects.join(", ") : "No projects found.";
  $("map").replaceChildren(head, box);
} else $("map").innerHTML = "<p class=\"empty\">This report was made from a file, so there is no server map.</p>";

// ---------------------------------------------------------------- CSV and theme
$("csv").addEventListener("click", () => {
  const rows = [["kind", "area", "channel", "title", "text", "projects", "status", "author", "replies", "reactions", "tone", "date", "link"]].concat(
    filtered().map((i) => [i.k, i.a, i.c, i.t, i.x, i.p.join("; "), i.s.join("; "), i.au, i.rp, i.r, i.tone, i.d, i.l]));
  const csv = rows.map((r) => r.map((v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s; }).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = "feedback.csv"; a.click();
});
$("theme").addEventListener("click", () => {
  const root = document.documentElement, dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark"; render();
});
render();
let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });
})();
`;
