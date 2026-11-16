// Server insights: find the areas and projects of a server, turn posts into feedback items and summarise them.
// Pure functions (no Discord calls), so they work the same on live data and on files the user brings.

/** Areas a channel can belong to, with the words that give them away (English, Portuguese, Spanish, French, German). */
export const AREAS = {
  bugs: ["bug", "bugs", "issue", "issues", "crash", "crashes", "report", "reports", "erro", "erros", "problema", "problemas", "fehler", "probleme", "glitch"],
  suggestions: ["suggestion", "suggestions", "suggest", "idea", "ideas", "request", "requests", "feature", "features", "wishlist", "sugestao", "sugestoes", "ideia", "ideias", "sugerencias", "vorschlage", "idees"],
  reviews: ["review", "reviews", "feedback", "opinion", "opinions", "rating", "ratings", "critique", "critica", "criticas", "avaliacao", "avaliacoes", "opiniao", "opinioes", "resena", "resenas", "avis", "bewertung", "testimonials"],
  support: ["help", "support", "question", "questions", "ask", "faq", "troubleshooting", "ajuda", "suporte", "duvida", "duvidas", "pergunta", "perguntas", "ayuda", "soporte", "hilfe", "aide"],
  tickets: ["ticket", "tickets"],
  announcements: ["announcement", "announcements", "news", "changelog", "changelogs", "update", "updates", "patch", "patches", "release", "releases", "devlog", "dev-blog", "blog", "anuncios", "anuncio", "novidades", "noticias"],
  showcase: ["showcase", "screenshot", "screenshots", "media", "art", "fanart", "creations", "builds", "clips", "gallery", "showoff"],
  chat: ["general", "chat", "off-topic", "offtopic", "lounge", "talk", "geral", "conversa", "memes"],
  info: ["rules", "welcome", "info", "information", "links", "roles", "regras", "boas-vindas", "start-here", "readme", "guide", "guides"],
  staff: ["staff", "admin", "mod", "mods", "moderator", "moderators", "logs", "log", "team"],
};
/** Areas whose posts are feedback (what collect_feedback reads by default). */
export const FEEDBACK_AREAS = ["bugs", "suggestions", "reviews", "support", "tickets"];
/** Forum tags that say the state of a post, not what it is about. */
const STATUS_WORDS = ["approved", "rejected", "denied", "accepted", "solved", "resolved", "fixed", "open", "closed", "pending", "planned",
  "in progress", "in-progress", "investigating", "duplicate", "wontfix", "won't fix", "done", "implemented", "confirmed", "not a bug",
  "aprovado", "rejeitado", "resolvido", "aberto", "fechado", "pendente", "em progresso", "corrigido", "duplicado"];
/** Forum tags that say the kind of post (an area), not a project. */
const KIND_WORDS = new Set(Object.values(AREAS).flat().concat(["mods", "modpacks", "modpack", "other", "misc", "general"]));

const strip = (s) => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\p{Extended_Pictographic}|️|[^\p{L}\p{N}\s'-]/gu, " ")
  .toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => strip(s).split(/[\s_-]+/).filter(Boolean);
/** Words of a post: like words(), but "co-op" and "don't" stay whole. */
const textWords = (s) => strip(s).split(/[\s_]+/).map((w) => w.replace(/^[-']+|[-']+$/g, "")).filter(Boolean);

/** The area of a channel from its name, topic, type and category. */
export function areaOf(ch, categoryName = "") {
  if (ch.type === 2 || ch.type === 13) return "voice";
  if (/^ticket[-_ ]?\d+/i.test(strip(ch.name).replace(/ /g, "-")) || /^ticket-/.test(strip(ch.name))) return "tickets";
  const name = words(ch.name);
  const joined = strip(ch.name).replace(/ /g, "-");
  const score = (text, weight) => {
    const ws = new Set(words(text));
    const s = {};
    for (const [area, keys] of Object.entries(AREAS)) {
      for (const k of keys) if (ws.has(k) || (k.includes("-") && strip(text).replace(/ /g, "-").includes(k))) s[area] = (s[area] || 0) + weight;
    }
    return s;
  };
  const total = {};
  for (const [text, w] of [[ch.name, 3], [ch.topic || "", 1], [categoryName, 1]]) {
    for (const [a, v] of Object.entries(score(text, w))) total[a] = (total[a] || 0) + v;
  }
  if (ch.type === 5) total.announcements = (total.announcements || 0) + 3;
  if (ch.type === 15 && !Object.keys(total).length) return "forum";
  // "dev-blog", "changelog" in the name beat the project words around them.
  if (/dev-?blog|changelog|devlog|patch-notes/.test(joined)) return "announcements";
  const best = Object.entries(total).sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  return name.length ? "other" : "other";
}

const isStatus = (tag) => STATUS_WORDS.some((w) => strip(tag) === w || strip(tag).startsWith(w + " "));

/**
 * Finds the projects of a server: forum tags used in two or more forums (and not a status or a kind of post),
 * categories that are not generic, and the words that stay in channel names once the area words are removed.
 */
export function findProjects(channels) {
  const cats = Object.fromEntries(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
  const found = new Map(); // key -> { name, sources:Set }
  const add = (name, source) => {
    const key = strip(name);
    if (!key || key.length < 3) return;
    if (!found.has(key)) found.set(key, { name: name.replace(/^[\p{Extended_Pictographic}️\s]+/u, "").trim(), sources: new Set() });
    found.get(key).sources.add(source);
  };
  const tagUse = new Map();
  for (const f of channels.filter((c) => c.type === 15 || c.type === 16)) {
    for (const t of f.available_tags || []) {
      if (isStatus(t.name) || words(t.name).every((w) => KIND_WORDS.has(w))) continue;
      const k = strip(t.name);
      if (!tagUse.has(k)) tagUse.set(k, { name: t.name, forums: new Set() });
      tagUse.get(k).forums.add(f.id);
    }
  }
  for (const { name, forums } of tagUse.values()) if (forums.size >= 2) add(name, "forum tags");
  const generic = new Set(["info", "news", "text channels", "voice channels", "voice", "text", "general", "staff", "community", "statistics",
    "development", "projects", "problems suggestions", "support", "tickets", "archive", "welcome", "logs", "info news", "important"]);
  for (const c of channels.filter((x) => x.type === 4)) {
    const k = strip(c.name);
    if (generic.has(k) || words(c.name).every((w) => KIND_WORDS.has(w) || generic.has(w) || ["and", "e", "problems", "text", "voice", "channels", "statistics", "development", "projects"].includes(w))) continue;
    add(c.name, "category");
  }
  // Channel-name stems: "vinland-dev-blog" and "vinland-modpack-showcase" share "vinland".
  const stems = new Map();
  const filler = new Set(["dev", "modpack", "mod", "the", "of", "and", "official", "beta", "alpha"]);
  for (const c of channels.filter((x) => x.type !== 4 && x.type !== 2)) {
    const rest = words(c.name).filter((w) => !KIND_WORDS.has(w) && !filler.has(w) && !/^\d+$/.test(w) && w !== "ticket");
    if (!rest.length) continue;
    const stem = rest.slice(0, 3).join(" ");
    const first = rest[0];
    for (const k of new Set([stem, first])) {
      if (!stems.has(k)) stems.set(k, new Set());
      stems.get(k).add(c.id);
    }
  }
  for (const [k, ids] of stems) {
    if (ids.size < 2 || k.length < 3) continue;
    // Prefer the longest stem that covers the same channels ("farming done better" over "farming").
    const longer = [...stems].find(([k2, ids2]) => k2 !== k && k2.startsWith(k + " ") && ids2.size === ids.size);
    if (longer) continue;
    const already = [...found.keys()].some((f) => f.includes(k) || k.includes(f));
    if (already) { for (const [f, v] of found) if (f.includes(k) || k.includes(f)) v.sources.add("channel names"); continue; }
    add(k.replace(/\b\w/g, (x) => x.toUpperCase()), "channel names");
  }
  // Merge names that are one inside the other ("Vinland" and "Vinland Survival").
  const list = [...found.entries()].sort((a, b) => b[0].length - a[0].length);
  const out = [];
  for (const [k, v] of list) {
    const bigger = out.find((o) => o.key.includes(k));
    if (bigger) { v.sources.forEach((s) => bigger.sources.add(s)); bigger.aliases.add(k); continue; }
    out.push({ key: k, name: v.name, sources: v.sources, aliases: new Set([k, ...words(k).filter((w) => w.length >= 4 && !KIND_WORDS.has(w)).slice(0, 1)]) });
  }
  return out.map((p) => ({ name: p.name, found_in: [...p.sources], match: [...p.aliases] })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Projects a text (channel name, tags, title, category) belongs to. */
export function projectsIn(texts, projects) {
  const t = " " + strip(texts.filter(Boolean).join(" ")).replace(/-/g, " ") + " ";
  return projects.filter((p) => p.match.some((m) => t.includes(" " + m + " ") || (m.length >= 6 && t.includes(m)))).map((p) => p.name);
}

/** The map of a server: every channel with its area and projects, grouped by area. */
export function mapServer(channels) {
  const cats = Object.fromEntries(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
  const projects = findProjects(channels);
  const rows = channels.filter((c) => c.type !== 4).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((c) => {
    const category = cats[c.parent_id] || "";
    const area = areaOf(c, category);
    const tags = (c.available_tags || []).map((t) => t.name);
    return {
      id: c.id, name: c.name, type: TYPE[c.type] || String(c.type), category: category || undefined, area,
      projects: projectsIn([c.name, category, c.topic], projects),
      project_tags: tags.length ? tags.filter((t) => projects.some((p) => strip(t).includes(p.match[0]))) : undefined,
      status_tags: tags.length ? tags.filter(isStatus) : undefined,
      feedback: FEEDBACK_AREAS.includes(area) || (area === "forum"),
    };
  });
  const areas = {};
  for (const r of rows) (areas[r.area] ||= []).push(r.name);
  return { projects, areas, channels: rows };
}
const TYPE = { 0: "text", 2: "voice", 5: "announcement", 13: "stage", 15: "forum", 16: "media" };

/** A Mermaid diagram of the map: projects linked to the areas and channels that talk about them. */
export function mermaidMap(map, title = "Server") {
  const ids = new Map();
  const id = (s) => (ids.has(s) ? ids.get(s) : (ids.set(s, `n${ids.size + 1}`), ids.get(s)));
  const esc = (s) => s.replace(/"/g, "'");
  const lines = ["flowchart LR", `  S["${esc(title)}"]`];
  for (const [area, list] of Object.entries(map.areas)) {
    if (area === "voice") continue;
    lines.push(`  ${id("a" + area)}(["${area}"])`, `  S --> ${id("a" + area)}`);
    for (const name of list.slice(0, 12)) {
      lines.push(`  ${id("c" + name)}["#${esc(name)}"]`, `  ${id("a" + area)} --> ${id("c" + name)}`);
    }
  }
  for (const p of map.projects) {
    lines.push(`  ${id("p" + p.name)}{{"${esc(p.name)}"}}`);
    for (const c of map.channels.filter((r) => r.projects.includes(p.name) || r.project_tags?.length)) {
      if (c.projects.includes(p.name) || c.project_tags?.some((t) => strip(t).includes(p.match[0]))) lines.push(`  ${id("p" + p.name)} -.- ${id("c" + c.name)}`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------- feedback items

/** Pseudonyms for authors, stable within one collection, so people can be counted without being named. */
export function pseudonymizer(enabled) {
  const seen = new Map();
  return (id, name) => {
    if (!enabled) return name || id;
    if (!seen.has(id)) seen.set(id, `member-${seen.size + 1}`);
    return seen.get(id);
  };
}

const POSITIVE = ["love", "loved", "great", "awesome", "amazing", "good", "nice", "best", "fun", "smooth", "beautiful", "perfect", "excellent",
  "thanks", "thank", "recommend", "enjoy", "enjoyed", "cool", "fantastic", "polished", "stable", "fast", "worth", "incredible", "fixed",
  "adoro", "adorei", "gosto", "gostei", "otimo", "excelente", "bom", "boa", "incrivel", "fixe", "perfeito", "obrigado", "recomendo", "divertido", "rapido", "lindo", "estavel", "espetacular",
  "genial", "bueno", "encanta", "gracias", "super", "toll", "gut", "genial"];
const NEGATIVE = ["bug", "bugs", "crash", "crashes", "crashing", "broken", "break", "breaks", "bad", "worse", "worst", "hate", "lag", "laggy",
  "slow", "boring", "annoying", "useless", "error", "errors", "fail", "fails", "failed", "missing", "terrible", "awful", "unplayable", "freeze",
  "freezes", "frozen", "stuck", "confusing", "disappointed", "disappointing", "expensive", "grindy", "unbalanced", "overpowered", "problem",
  "exploit", "exploits", "corrupted", "corrupt", "lost", "unstable", "does not start", "doesn't start", "won't start", "nao abre", "nao arranca",
  "problems", "issue", "issues", "doesn't", "doesnt", "can't", "cant", "won't", "wont", "not working", "stutter", "fps drop", "glitch",
  "mau", "ma", "pessimo", "horrivel", "lento", "chato", "erro", "erros", "problema", "problemas", "partido", "travou", "trava", "nao funciona",
  "falha", "falhou", "detesto", "odeio", "irritante", "confuso", "desiludido", "malo", "roto", "schlecht", "kaputt"];
const NEGATORS = ["not", "no", "never", "nao", "nunca", "nem", "isn't", "isnt", "wasn't", "wasnt", "don't", "dont"];

/** -1 … 1 from a small word list (English and Portuguese, some Spanish and German). A hint, not a verdict. */
export function sentiment(text) {
  const ws = textWords(text);
  const joined = " " + ws.join(" ") + " ";
  let pos = 0, neg = 0;
  ws.forEach((w, i) => {
    const flip = NEGATORS.includes(ws[i - 1]) || NEGATORS.includes(ws[i - 2]);
    if (POSITIVE.includes(w)) flip ? neg++ : pos++;
    else if (NEGATIVE.includes(w)) flip ? pos += 0.5 : neg++;
  });
  for (const p of NEGATIVE.filter((x) => x.includes(" "))) if (joined.includes(" " + p + " ")) neg++;
  if (!pos && !neg) return 0;
  return Math.round(((pos - neg) / (pos + neg)) * 100) / 100;
}

export const STOP = new Set(("a an the and or but if then so to of in on at for from by with without about as is are was were be been being it its this that these those " +
  "i me my we our you your he she they them their his her there here what which who when where why how all any some more most very can could would should will just " +
  "also too not no yes do does did done have has had get got make made like one two out up down over again still even only really much many lot lots thing things " +
  "o a os as um uma uns umas de do da dos das em no na nos nas por para com sem que e ou mas se entao muito muita muitos muitas mais menos ja ainda tambem so " +
  "eu tu ele ela nos vos eles elas meu minha teu tua seu sua isto isso aquilo este esta esse essa ao aos pelo pela como quando onde porque porque qual quais ter tem tenho " +
  "foi era sao ser estar esta estou fazer faz fiz vai vou pode posso nao sim el la los las un una y o pero con sin por para es son der die das und ist nicht " +
  "after before since every time times day days please pls hi hello hey thanks thank ok okay im i'm it's dont don't doesn't can't cant")
  .split(" "));

/** Repeated words and two-word phrases, most frequent first, counted once per item. */
export function themes(items, limit = 15) {
  const one = new Map(), two = new Map();
  // Project names are in every post about the project, so they are not a theme.
  const projectWords = new Set(items.flatMap((i) => i.projects || []).flatMap((p) => textWords(p)));
  for (const it of items) {
    // A reply carries its post's title; count the title once, with the post.
    const ws = textWords(`${it.kind === "reply" ? "" : it.title || ""} ${it.text || ""}`)
      .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) && !projectWords.has(w) && !["pack", "modpack", "mod", "game"].includes(w));
    const seen1 = new Set(ws);
    const seen2 = new Set(ws.slice(1).map((w, i) => `${ws[i]} ${w}`));
    for (const w of seen1) one.set(w, (one.get(w) || 0) + 1);
    for (const p of seen2) two.set(p, (two.get(p) || 0) + 1);
  }
  const top = (m) => [...m].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, n]) => ({ term, posts: n }));
  return { phrases: top(two), words: top(one) };
}

const stem = (w) => w.replace(/(?:ings|ing|ed|es|s)$/, (end, offset) => (offset >= 3 ? "" : end));

/**
 * Groups posts of the same area that look like the same request or problem: they share two significant words
 * (title and start of the text, project names left out), or one longer word that is in both titles ("co-op").
 */
/** Words that say what kind of post it is, not what it is about: alone they do not make two posts the same. */
const GENERIC = new Set(["support", "add", "request", "feature", "featur", "issue", "problem", "bug", "help", "question", "idea", "suggestion",
  "suggestion", "please", "fix", "update", "new", "more", "better", "option", "setting", "pedido", "ajuda", "problema", "ideia", "sugestao"]);

export function similarGroups(items) {
  const projectWords = new Set(items.flatMap((i) => i.projects || []).flatMap((p) => textWords(p)).map(stem));
  const clean = (s) => textWords(s || "").filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem).filter((w) => !projectWords.has(w));
  const sig = (it) => new Set(clean(`${it.title || ""} ${(it.text || "").slice(0, 120)}`));
  const titleSig = (it) => new Set(clean(it.title || (it.text || "").slice(0, 80)));
  const posts = items.filter((i) => i.kind !== "reply");
  const groups = [];
  const used = new Set();
  posts.forEach((a, i) => {
    if (used.has(i)) return;
    const sa = sig(a), ta = titleSig(a);
    const g = [a];
    posts.forEach((b, j) => {
      if (j <= i || used.has(j) || b.area !== a.area) return;
      const shared = [...sig(b)].filter((w) => sa.has(w));
      const inTitles = [...titleSig(b)].filter((w) => ta.has(w) && w.length >= 4 && !GENERIC.has(w));
      if (shared.length >= 2 || inTitles.length >= 1) { g.push(b); used.add(j); }
    });
    if (g.length > 1) {
      used.add(i);
      const common = [...sa].filter((w) => g.every((x) => sig(x).has(w)));
      groups.push({ about: common.join(" ") || (a.title || "").slice(0, 60), area: a.area, posts: g.map((x) => x.title || x.text.slice(0, 80)) });
    }
  });
  return groups;
}

const label = (i) => i.title || (i.text || "").replace(/\s+/g, " ").slice(0, 80);

/** The numbers and lists of a feedback report. */
export function report(items, map) {
  const posts = items.filter((i) => i.kind !== "reply");
  const by = (key) => {
    const out = {};
    for (const it of posts) for (const v of [].concat(it[key] ?? "none")) out[v] = (out[v] || 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  };
  const score = (it) => (it.reactions || 0) + (it.replies || 0) * 2;
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100 : null);
  const projects = {};
  for (const p of [...new Set(posts.flatMap((i) => i.projects?.length ? i.projects : ["(no project)"]))]) {
    const mine = items.filter((i) => (i.projects?.length ? i.projects : ["(no project)"]).includes(p));
    const minePosts = mine.filter((i) => i.kind !== "reply");
    projects[p] = defined({
      posts: minePosts.length, replies: mine.length - minePosts.length,
      by_area: Object.fromEntries(Object.entries(minePosts.reduce((o, i) => ({ ...o, [i.area]: (o[i.area] || 0) + 1 }), {}))),
      sentiment: avg(mine.map((i) => i.sentiment)),
      negative_posts: minePosts.filter((i) => i.sentiment < 0).length, positive_posts: minePosts.filter((i) => i.sentiment > 0).length,
      open_bugs: minePosts.filter((i) => i.area === "bugs" && !closedStatus(i.status)).length,
      top_themes: (({ phrases, words: w }) => [...new Set(phrases.concat(w).map((t) => t.term))])(themes(mine, 6)).slice(0, 8),
    });
  }
  return {
    totals: { posts: posts.length, replies: items.length - posts.length, people: new Set(items.map((i) => i.author)).size,
      sentiment: avg(items.map((i) => i.sentiment)) },
    by_area: by("area"), by_status: by("status"), by_tag: by("tags"),
    projects,
    most_discussed: [...posts].sort((a, b) => score(b) - score(a)).slice(0, 8).map((i) => defined({ title: label(i), area: i.area, projects: i.projects, reactions: i.reactions, replies: i.replies, link: i.link })),
    most_negative: posts.filter((i) => i.sentiment < 0).sort((a, b) => a.sentiment - b.sentiment || score(b) - score(a)).slice(0, 8)
      .map((i) => defined({ title: label(i), area: i.area, projects: i.projects, sentiment: i.sentiment, link: i.link })),
    open_bugs: posts.filter((i) => i.area === "bugs" && !closedStatus(i.status)).map((i) => defined({ title: label(i), projects: i.projects, status: i.status, link: i.link })),
    repeated: similarGroups(posts),
    themes: themes(items),
    map: map ? mermaidMap(map) : undefined,
  };
}
const closedStatus = (s) => [].concat(s || []).some((x) => /solved|resolved|fixed|closed|done|implemented|rejected|denied|duplicate|wontfix|resolvido|corrigido|fechado|rejeitado/.test(strip(x)));

/** The report as Markdown, for the user to read or keep. */
export function reportMarkdown(r, title = "Feedback report") {
  const L = [`# ${title}`, "", `**${r.totals.posts}** posts and **${r.totals.replies}** replies from **${r.totals.people}** people. Average tone: **${fmt(r.totals.sentiment)}** (−1 negative … +1 positive; a word-list hint, read the posts before concluding).`, ""];
  const table = (obj, h) => { L.push(`| ${h} | Posts |`, "|---|---|", ...Object.entries(obj).map(([k, v]) => `| ${k} | ${v} |`), ""); };
  L.push("## Projects", "", "| Project | Posts | Replies | Tone | Negative | Positive | Open bugs | Themes |", "|---|---|---|---|---|---|---|---|");
  for (const [p, v] of Object.entries(r.projects)) L.push(`| ${p} | ${v.posts} | ${v.replies} | ${fmt(v.sentiment)} | ${v.negative_posts} | ${v.positive_posts} | ${v.open_bugs} | ${(v.top_themes || []).join(", ")} |`);
  L.push("", "## By area", "");
  table(r.by_area, "Area");
  L.push("## By status", "");
  table(r.by_status, "Status");
  const list = (head, arr, f) => { if (!arr.length) return; L.push(`## ${head}`, "", ...arr.map(f), ""); };
  const link = (i) => (i.link ? ` ([open](${i.link}))` : "");
  list("Most discussed", r.most_discussed, (i) => `- **${i.title}** · ${i.area}${i.projects?.length ? " · " + i.projects.join(", ") : ""} · ${i.reactions || 0} reactions, ${i.replies || 0} replies${link(i)}`);
  list("Most negative", r.most_negative, (i) => `- **${i.title}** · ${i.area} · tone ${fmt(i.sentiment)}${link(i)}`);
  list("Open bugs", r.open_bugs, (i) => `- **${i.title}**${i.projects?.length ? " · " + i.projects.join(", ") : ""}${i.status?.length ? " · " + [].concat(i.status).join(", ") : ""}${link(i)}`);
  list("Asked or reported more than once", r.repeated, (g) => `- **${g.about}** (${g.posts.length} posts): ${g.posts.map((p) => `"${p}"`).join(", ")}`);
  if (r.themes.phrases.length || r.themes.words.length) {
    L.push("## Recurring themes", "", r.themes.phrases.map((t) => `${t.term} (${t.posts})`).join(" · "), "", r.themes.words.map((t) => `${t.term} (${t.posts})`).join(" · "), "");
  }
  if (r.map) L.push("## Map", "", "```mermaid", r.map, "```", "");
  return L.join("\n");
}
const fmt = (n) => (n === null || n === undefined ? "–" : (n > 0 ? "+" : "") + n.toFixed(2));

function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
}

// ------------------------------------------------------------------------------------------- files the user brings

/**
 * Items from a file: a JSON export of a Discord channel (DiscordChatExporter-style: { guild, channel, messages }),
 * an array of messages, an earlier collect_feedback result, CSV (title/text/author/... columns) or plain text (one post per paragraph).
 */
export function itemsFromFile(text, fileName = "file") {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t);
    if (Array.isArray(j?.items)) return { items: j.items, source: "collection" };
    const exports = Array.isArray(j) && j[0]?.messages ? j : j.messages ? [j] : null;
    if (exports) {
      return { source: "channel export", items: exports.flatMap((e) => {
        const ch = e.channel || {};
        return e.messages.filter((m) => (m.content || m.embeds?.length) && m.type !== "ThreadCreated").map((m, i) => ({
          kind: i === 0 && ch.type?.toString().toLowerCase().includes("thread") ? "post" : "message",
          channel: ch.name || fileName, category: ch.category, title: i === 0 && ch.type?.toString().toLowerCase().includes("thread") ? ch.name : undefined,
          author_id: m.author?.id || m.author?.name, author_name: m.author?.nickname || m.author?.name,
          text: [m.content, ...(m.embeds || []).map((x) => [x.title, x.description].filter(Boolean).join("\n"))].filter(Boolean).join("\n"),
          reactions: (m.reactions || []).reduce((s, r) => s + (r.count || 0), 0), created: m.timestamp,
        }));
      }) };
    }
    if (Array.isArray(j)) return { source: "message list", items: j.map((m) => ({ kind: "message", channel: m.channel || fileName, title: m.title,
      author_id: m.author_id || m.author?.id || m.author, author_name: m.author?.name || m.author, text: m.text || m.content || "", reactions: m.reactions, created: m.created || m.timestamp })) };
  }
  if (/\.csv$/i.test(fileName) || /^[^\n]*,[^\n]*\n/.test(t) && /text|content|message|review/i.test(t.split("\n")[0])) {
    const rows = parseCsv(t);
    const head = rows.shift().map((h) => h.toLowerCase().trim());
    const col = (r, ...names) => { const i = head.findIndex((h) => names.includes(h)); return i >= 0 ? r[i] : undefined; };
    return { source: "csv", items: rows.filter((r) => r.some(Boolean)).map((r) => ({ kind: "post", channel: col(r, "channel", "area", "forum") || fileName,
      title: col(r, "title", "subject", "name"), text: col(r, "text", "content", "message", "review", "body") || "", author_id: col(r, "author", "user", "username"),
      author_name: col(r, "author", "user", "username"), tags: col(r, "tags", "tag")?.split(/[;|]/).map((x) => x.trim()).filter(Boolean),
      reactions: Number(col(r, "reactions", "likes", "votes", "upvotes")) || undefined, created: col(r, "date", "created", "timestamp") })) };
  }
  return { source: "text", items: t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p, i) => {
    const [first, ...rest] = p.split("\n");
    return { kind: "post", channel: fileName, title: rest.length ? first.slice(0, 120) : undefined, text: rest.length ? rest.join("\n") : p, author_id: `line-${i}` };
  }) };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Fills area, projects, sentiment and author pseudonyms on items that came from a file. */
export function enrichItems(items, { projects = [], anonymize = true } = {}) {
  const who = pseudonymizer(anonymize);
  return items.map((it) => {
    const area = it.area || areaOf({ name: it.channel || "", topic: it.title || "" }, it.category || "");
    const out = { ...it, area: area === "other" && it.kind === "post" ? "reviews" : area };
    out.projects = it.projects || projectsIn([it.channel, it.category, ...(it.tags || []), it.title], projects);
    out.sentiment = it.sentiment ?? sentiment(`${it.title || ""} ${it.text || ""}`);
    out.author = it.author || who(it.author_id || it.author_name || "unknown", it.author_name);
    delete out.author_id; delete out.author_name;
    return out;
  });
}
