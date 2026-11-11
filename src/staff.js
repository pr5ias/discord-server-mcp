// Slash commands for the server's staff: /lock, /unlock, /slowmode, /purge, /timeout, /untimeout, /kick,
// /ban, /unban, /role add|remove, /announce, /ticket close|claim and /modlog. They run inside Discord, with
// Discord's own permissions deciding who sees them, and answer only to the person who used them.
import { api, roleAbove, topRole, bits } from "./discord.js";
import { text } from "./i18n.js";
import { search, LOG_KINDS } from "./modlog.js";
import { LOCK, setOverride } from "./tools/utility.js";

const P = { kick: 1n << 1n, ban: 1n << 2n, admin: 1n << 3n, channels: 1n << 4n, audit: 1n << 7n, messages: 1n << 13n, roles: 1n << 28n, moderate: 1n << 40n };
const O = { sub: 1, string: 3, integer: 4, user: 6, channel: 7, role: 8 };
const opt = (type, name, pt, description, ptDescription, extra = {}) =>
  ({ type, name, name_localizations: { "pt-BR": pt }, description, description_localizations: { "pt-BR": ptDescription }, ...extra });
const reasonOpt = () => opt(O.string, "reason", "motivo", "Reason (shown in the audit log)", "Motivo (fica no registo de auditoria)", { max_length: 400 });

/** Every staff command, with the permission Discord asks for before showing it. */
export const STAFF_COMMANDS = {
  lock: { pt: "trancar", description: "Lock a channel: members can read but not write", ptDescription: "Trancar um canal: os membros leem mas não escrevem", perm: P.channels,
    options: [opt(O.channel, "channel", "canal", "Channel (default: this one)", "Canal (por omissão: este)"), reasonOpt()] },
  unlock: { pt: "destrancar", description: "Unlock a channel", ptDescription: "Destrancar um canal", perm: P.channels,
    options: [opt(O.channel, "channel", "canal", "Channel (default: this one)", "Canal (por omissão: este)")] },
  slowmode: { pt: "modo-lento", description: "Set slowmode (0 turns it off)", ptDescription: "Modo lento em segundos (0 desliga)", perm: P.channels,
    options: [opt(O.integer, "seconds", "segundos", "Seconds between messages", "Segundos entre mensagens", { required: true, min_value: 0, max_value: 21600 }),
      opt(O.channel, "channel", "canal", "Channel (default: this one)", "Canal (por omissão: este)")] },
  purge: { pt: "limpar", description: "Delete the latest messages", ptDescription: "Apagar as últimas mensagens", perm: P.messages,
    options: [opt(O.integer, "count", "quantidade", "How many (1-100)", "Quantas (1-100)", { required: true, min_value: 1, max_value: 100 }),
      opt(O.user, "member", "membro", "Only messages from this member", "Só mensagens deste membro")] },
  timeout: { pt: "silenciar", description: "Time a member out", ptDescription: "Silenciar um membro", perm: P.moderate,
    options: [opt(O.user, "member", "membro", "Member", "Membro", { required: true }),
      opt(O.integer, "minutes", "minutos", "Minutes (max 40320 = 28 days)", "Minutos (máx. 40320 = 28 dias)", { required: true, min_value: 1, max_value: 40320 }), reasonOpt()] },
  untimeout: { pt: "dessilenciar", description: "Remove a timeout", ptDescription: "Tirar o silêncio a um membro", perm: P.moderate,
    options: [opt(O.user, "member", "membro", "Member", "Membro", { required: true })] },
  kick: { pt: "expulsar", description: "Kick a member", ptDescription: "Expulsar um membro", perm: P.kick,
    options: [opt(O.user, "member", "membro", "Member", "Membro", { required: true }), reasonOpt()] },
  ban: { pt: "banir", description: "Ban a member", ptDescription: "Banir um membro", perm: P.ban,
    options: [opt(O.user, "member", "membro", "Member", "Membro", { required: true }), reasonOpt(),
      opt(O.integer, "delete_hours", "apagar_horas", "Also delete their messages from the last hours (0-168)", "Apagar também as mensagens das últimas horas (0-168)", { min_value: 0, max_value: 168 })] },
  unban: { pt: "desbanir", description: "Unban a user by id", ptDescription: "Remover o ban de um utilizador (id)", perm: P.ban,
    options: [opt(O.string, "user_id", "id", "User id", "Id do utilizador", { required: true })] },
  role: { pt: "cargo", description: "Give or take a role", ptDescription: "Dar ou tirar um cargo", perm: P.roles,
    options: [
      opt(O.sub, "add", "dar", "Give a role", "Dar um cargo", { options: [opt(O.user, "member", "membro", "Member", "Membro", { required: true }), opt(O.role, "role", "cargo", "Role", "Cargo", { required: true })] }),
      opt(O.sub, "remove", "tirar", "Take a role", "Tirar um cargo", { options: [opt(O.user, "member", "membro", "Member", "Membro", { required: true }), opt(O.role, "role", "cargo", "Role", "Cargo", { required: true })] }),
    ] },
  announce: { pt: "anunciar", description: "Post a message as the bot", ptDescription: "Publicar uma mensagem como o bot", perm: P.messages,
    options: [opt(O.channel, "channel", "canal", "Channel", "Canal", { required: true }), opt(O.string, "message", "mensagem", "Text (use \\n for new lines)", "Texto (\\n para mudar de linha)", { required: true, max_length: 2000 }),
      opt(O.role, "ping", "mencionar", "Role to ping", "Cargo a mencionar")] },
  ticket: { pt: "ticket", description: "Close or claim this ticket", ptDescription: "Fechar ou assumir este ticket", perm: null,
    options: [opt(O.sub, "close", "fechar", "Close this ticket", "Fechar este ticket"), opt(O.sub, "claim", "assumir", "Claim this ticket", "Assumir este ticket")] },
  modlog: { pt: "historico", description: "Search the moderation log by member and kind", ptDescription: "Procurar no registo de moderação por membro e tipo", perm: P.audit,
    options: [opt(O.user, "member", "membro", "Member (what they did or what happened to them)", "Membro (o que fez ou o que lhe aconteceu)"),
      opt(O.string, "kind", "tipo", "Kind", "Tipo", { choices: LOG_KINDS.map((k) => ({ name: k, value: k, name_localizations: { "pt-BR": { messages: "mensagens", members: "membros", moderation: "moderação", server: "servidor" }[k] } })) }),
      opt(O.integer, "days", "dias", "Last days (default 7)", "Últimos dias (por omissão 7)", { min_value: 1, max_value: 365 })] },
};

/** Command and subcommand names per language (Discord shows the member's language). */
const NAMES = {
  lock: { "pt-BR": "trancar", es: "bloquear", fr: "verrouiller", de: "sperren", it: "blocca", ru: "закрыть", ja: "ロック", "zh-CN": "锁定", ko: "잠금", pl: "zablokuj", tr: "kilitle" },
  unlock: { "pt-BR": "destrancar", es: "desbloquear", fr: "déverrouiller", de: "entsperren", it: "sblocca", ru: "открыть", ja: "ロック解除", "zh-CN": "解锁", ko: "잠금해제", pl: "odblokuj", tr: "kilidi-aç" },
  slowmode: { "pt-BR": "modo-lento", es: "modo-lento", fr: "mode-lent", de: "slowmode", it: "modalità-lenta", ru: "медленный-режим", ja: "低速モード", "zh-CN": "慢速模式", ko: "슬로우모드", pl: "tryb-powolny", tr: "yavaş-mod" },
  purge: { "pt-BR": "limpar", es: "purgar", fr: "purger", de: "löschen", it: "elimina", ru: "очистить", ja: "一括削除", "zh-CN": "清理", ko: "청소", pl: "wyczyść", tr: "temizle" },
  timeout: { "pt-BR": "silenciar", es: "aislar", fr: "exclure", de: "timeout", it: "timeout", ru: "тайм-аут", ja: "タイムアウト", "zh-CN": "禁言", ko: "타임아웃", pl: "wycisz", tr: "sustur" },
  untimeout: { "pt-BR": "dessilenciar", es: "quitar-aislamiento", fr: "lever-exclusion", de: "timeout-aufheben", it: "rimuovi-timeout", ru: "снять-тайм-аут", ja: "タイムアウト解除", "zh-CN": "解除禁言", ko: "타임아웃해제", pl: "odcisz", tr: "susturmayı-kaldır" },
  kick: { "pt-BR": "expulsar", es: "expulsar", fr: "expulser", de: "kicken", it: "espelli", ru: "выгнать", ja: "キック", "zh-CN": "踢出", ko: "추방", pl: "wyrzuć", tr: "at" },
  ban: { "pt-BR": "banir", es: "banear", fr: "bannir", de: "bannen", it: "banna", ru: "бан", ja: "バン", "zh-CN": "封禁", ko: "차단", pl: "zbanuj", tr: "yasakla" },
  unban: { "pt-BR": "desbanir", es: "desbanear", fr: "débannir", de: "entbannen", it: "sbanna", ru: "разбан", ja: "バン解除", "zh-CN": "解封", ko: "차단해제", pl: "odbanuj", tr: "yasağı-kaldır" },
  role: { "pt-BR": "cargo", es: "rol", fr: "rôle", de: "rolle", it: "ruolo", ru: "роль", ja: "ロール", "zh-CN": "身份组", ko: "역할", pl: "rola", tr: "rol" },
  "role.add": { "pt-BR": "dar", es: "dar", fr: "donner", de: "geben", it: "dai", ru: "выдать", ja: "付与", "zh-CN": "添加", ko: "지급", pl: "daj", tr: "ver" },
  "role.remove": { "pt-BR": "tirar", es: "quitar", fr: "retirer", de: "nehmen", it: "togli", ru: "забрать", ja: "剥奪", "zh-CN": "移除", ko: "회수", pl: "zabierz", tr: "al" },
  announce: { "pt-BR": "anunciar", es: "anunciar", fr: "annoncer", de: "ankündigen", it: "annuncia", ru: "объявить", ja: "お知らせ", "zh-CN": "公告", ko: "공지", pl: "ogłoś", tr: "duyur" },
  ticket: { "pt-BR": "ticket", es: "ticket", fr: "ticket", de: "ticket", it: "ticket", ru: "тикет", ja: "チケット", "zh-CN": "工单", ko: "티켓", pl: "zgłoszenie", tr: "talep" },
  "ticket.close": { "pt-BR": "fechar", es: "cerrar", fr: "fermer", de: "schließen", it: "chiudi", ru: "закрыть", ja: "閉じる", "zh-CN": "关闭", ko: "닫기", pl: "zamknij", tr: "kapat" },
  "ticket.claim": { "pt-BR": "assumir", es: "asumir", fr: "prendre", de: "übernehmen", it: "prendi", ru: "взять", ja: "担当", "zh-CN": "认领", ko: "담당", pl: "przejmij", tr: "üstlen" },
  modlog: { "pt-BR": "historico", es: "historial", fr: "historique", de: "modlog", it: "registro", ru: "журнал", ja: "ログ検索", "zh-CN": "日志", ko: "기록", pl: "dziennik", tr: "kayıt" },
};
/** Discord locale codes for each of our languages. */
const LOCALES = { "pt-BR": ["pt-BR"], es: ["es-ES", "es-419"], fr: ["fr"], de: ["de"], it: ["it"], ru: ["ru"], ja: ["ja"], "zh-CN": ["zh-CN"], ko: ["ko"], pl: ["pl"], tr: ["tr"] };
const localized = (key) => Object.fromEntries(Object.entries(NAMES[key] || {}).flatMap(([l, n]) => LOCALES[l].map((code) => [code, n])));

/**
 * Registers (or updates) the chosen staff commands in a server; returns { name: command id }.
 * names: "member" = English, shown in each member's own Discord language where we have one;
 * "english" = English for everyone; a language code = that language for everyone.
 */
export async function registerStaffCommands(guild, appId, list = Object.keys(STAFF_COMMANDS), { names = "member" } = {}) {
  const out = {};
  const strip = (opts) => opts?.map((o) => ({ ...o, name_localizations: undefined, description_localizations: undefined, options: strip(o.options) }));
  for (const name of list) {
    const c = STAFF_COMMANDS[name];
    const fixed = names !== "member" && names !== "english" ? names : null;
    const base = fixed && fixed !== "en" ? NAMES[name]?.[fixed] || name : name;
    let options = c.options;
    if (names === "member") {
      options = options?.map((o) => (o.type === O.sub ? { ...o, name_localizations: { ...o.name_localizations, ...localized(`${name}.${o.name}`) } } : o));
    } else {
      // One name for everyone: subcommands in that language too, no per-member translations.
      options = strip(options)?.map((o) => (o.type === O.sub && fixed && fixed !== "en" ? { ...o, name: NAMES[`${name}.${o.name}`]?.[fixed] || o.name } : o));
    }
    const created = await api("POST", `/applications/${appId}/guilds/${guild}/commands`, {
      name: base,
      name_localizations: names === "member" ? { ...localized(name), "pt-BR": c.pt } : undefined,
      description: c.description,
      description_localizations: names === "member" ? { "pt-BR": c.ptDescription } : undefined,
      type: 1, options, default_member_permissions: c.perm === null ? undefined : String(c.perm), contexts: [0],
    });
    out[name] = created.id;
  }
  return out;
}

/** The command this interaction is, by id first (names can be translated). */
const commandOf = (entry, d) => Object.keys(entry.commands || {}).find((n) => entry.commands[n] === d.data?.id)
  || Object.keys(entry.commands || {}).find((n) => n === d.data?.name || NAMES[n] && Object.values(NAMES[n]).includes(d.data?.name));
/** Subcommand name in English, whatever language it was registered in. */
const subOf = (cmd, sub) => (sub && !["add", "remove", "close", "claim"].includes(sub)
  ? ["add", "remove", "close", "claim"].find((k) => NAMES[`${cmd}.${k}`] && Object.values(NAMES[`${cmd}.${k}`]).includes(sub)) || sub : sub);

const optionsOf = (d) => {
  const top = d.data?.options || [];
  const sub = top.find((o) => o.type === O.sub);
  const list = sub ? sub.options || [] : top;
  return { sub: sub?.name, get: (n) => list.find((o) => o.name === n)?.value };
};

/**
 * Handles a staff command. Returns "ticket:close" / "ticket:claim" for the ticket buttons' own logic,
 * true when it answered, false when the command is not one of ours.
 */
export async function handleStaffCommand(d, bot, entry, { staffReason }) {
  const name = commandOf(entry, d);
  if (!name) return false;
  const parsed = optionsOf(d);
  const sub = subOf(name, parsed.sub);
  const { get } = parsed;
  if (name === "ticket") return `ticket:${sub}`;
  const t = (k, vars) => text(k, { lang: entry.language, locale: d.guild_locale || d.locale, texts: entry.texts, vars });
  const g = d.guild_id;
  const userId = d.member.user.id;
  const perms = BigInt(d.member.permissions || 0);
  const need = STAFF_COMMANDS[name].perm;
  // Discord hides the commands from members without the permission; this also covers changed overrides.
  if (need && !(perms & P.admin) && !(perms & need)) {
    await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: t("cmd_no_permission"), flags: 64 } });
    return true;
  }
  await api("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: 64 } });
  const reply = (content, embeds) => api("PATCH", `/webhooks/${d.application_id}/${d.token}/messages/@original`, { content, embeds, allowed_mentions: { parse: [] } });
  const why = (r) => staffReason(name === "role" ? `role ${sub}` : name, userId, r);
  const reasonHeader = (r) => ({ reason: why(r) });

  // Members can only act on members below them, and the bot only below its own top role.
  const below = async (targetId) => {
    const [roles, guild, target, me] = await Promise.all([api("GET", `/guilds/${g}/roles`), api("GET", `/guilds/${g}`),
      api("GET", `/guilds/${g}/members/${targetId}`).catch(() => null), api("GET", `/guilds/${g}/members/${bot.id}`)]);
    if (!target) return true;
    if (guild.owner_id === targetId) return false;
    const targetTop = topRole(roles, target.roles) || roles.find((r) => r.id === g);
    const myTop = topRole(roles, me.roles);
    const callerTop = topRole(roles, d.member.roles) || roles.find((r) => r.id === g);
    const callerOk = guild.owner_id === userId || roleAbove(callerTop, targetTop);
    return callerOk && myTop && roleAbove(myTop, targetTop);
  };

  try {
    switch (name) {
      case "lock":
      case "unlock": {
        const cid = get("channel") || d.channel_id;
        const c = await api("GET", `/channels/${cid}`);
        if (name === "lock") {
          await setOverride(c, g, [], LOCK, why(get("reason")));
        } else {
          const old = (c.permission_overwrites || []).find((o) => o.id === g);
          if (old) await api("PUT", `/channels/${cid}/permissions/${g}`, { type: 0, allow: old.allow, deny: (BigInt(old.deny) & ~BigInt(bits(LOCK))).toString() }, reasonHeader());
        }
        await reply(t(name === "lock" ? "cmd_locked" : "cmd_unlocked", { channel: `<#${cid}>` }));
        return true;
      }
      case "slowmode": {
        const cid = get("channel") || d.channel_id;
        await api("PATCH", `/channels/${cid}`, { rate_limit_per_user: get("seconds") }, reasonHeader());
        await reply(t("cmd_slowmode", { channel: `<#${cid}>`, seconds: get("seconds") }));
        return true;
      }
      case "purge": {
        const who = get("member");
        const msgs = (await api("GET", `/channels/${d.channel_id}/messages?limit=100`)).filter((m) => !who || m.author.id === who).slice(0, get("count"));
        const recent = msgs.filter((m) => Date.now() - Date.parse(m.timestamp) < 13.9 * 24 * 3600 * 1000).map((m) => m.id);
        if (recent.length > 1) await api("POST", `/channels/${d.channel_id}/messages/bulk-delete`, { messages: recent }, reasonHeader());
        else if (recent.length === 1) await api("DELETE", `/channels/${d.channel_id}/messages/${recent[0]}`, undefined, reasonHeader());
        await reply(t("cmd_purged", { count: recent.length }));
        return true;
      }
      case "timeout":
      case "untimeout":
      case "kick":
      case "ban": {
        const target = get("member");
        if (!(await below(target))) {
          await reply(t("cmd_higher", { user: `<@${target}>` }));
          return true;
        }
        if (name === "timeout") {
          await api("PATCH", `/guilds/${g}/members/${target}`, { communication_disabled_until: new Date(Date.now() + get("minutes") * 60000).toISOString() }, reasonHeader(get("reason")));
          await reply(t("cmd_timeout", { user: `<@${target}>`, minutes: get("minutes") }));
        return true;
        }
        if (name === "untimeout") {
          await api("PATCH", `/guilds/${g}/members/${target}`, { communication_disabled_until: null }, reasonHeader());
          await reply(t("cmd_untimeout", { user: `<@${target}>` }));
        return true;
        }
        if (name === "kick") {
          await api("DELETE", `/guilds/${g}/members/${target}`, undefined, reasonHeader(get("reason")));
          await reply(t("cmd_kicked", { user: `<@${target}>` }));
        return true;
        }
        await api("PUT", `/guilds/${g}/bans/${target}`, { delete_message_seconds: (get("delete_hours") || 0) * 3600 }, reasonHeader(get("reason")));
        await reply(t("cmd_banned", { user: `<@${target}>` }));
        return true;
      }
      case "unban": {
        await api("DELETE", `/guilds/${g}/bans/${get("user_id")}`, undefined, reasonHeader());
        await reply(t("cmd_unbanned", { user: `<@${get("user_id")}>` }));
        return true;
      }
      case "role": {
        const target = get("member");
        const roleId = get("role");
        const [roles, guild, me] = await Promise.all([api("GET", `/guilds/${g}/roles`), api("GET", `/guilds/${g}`), api("GET", `/guilds/${g}/members/${bot.id}`)]);
        const r = roles.find((x) => x.id === roleId);
        const callerTop = topRole(roles, d.member.roles);
        const myTop = topRole(roles, me.roles);
        if (r.managed || !(myTop && roleAbove(myTop, r)) || !(guild.owner_id === userId || (callerTop && roleAbove(callerTop, r)))) {
          await reply(t("cmd_higher", { user: r.name }));
        return true;
        }
        await api(sub === "add" ? "PUT" : "DELETE", `/guilds/${g}/members/${target}/roles/${roleId}`, undefined, reasonHeader());
        await reply(t(sub === "add" ? "cmd_role_added" : "cmd_role_removed", { user: `<@${target}>`, role: `<@&${roleId}>` }));
        return true;
      }
      case "announce": {
        const ping = get("ping");
        await api("POST", `/channels/${get("channel")}/messages`, {
          content: `${ping ? `<@&${ping}>\n` : ""}${String(get("message")).replaceAll("\\n", "\n")}`,
          allowed_mentions: { roles: ping ? [ping] : [] },
        });
        await reply(t("cmd_announced", { channel: `<#${get("channel")}>` }));
        return true;
      }
      case "modlog": {
        const days = get("days") || 7;
        const rows = search(g, { user: get("member"), kind: get("kind"), since: new Date(Date.now() - days * 86400000).toISOString(), limit: 20 });
        if (!rows.length) {
          await reply(t("modlog_empty"));
          return true;
        }
        const lines = rows.map((r) => `<t:${Math.floor(Date.parse(r.at) / 1000)}:R> **${r.type.replaceAll("_", " ")}**`
          + `${r.subject ? ` · <@${r.subject}>` : ""}${r.actor && r.actor !== r.subject ? ` ← <@${r.actor}>` : ""}${r.summary ? `\n> ${r.summary.slice(0, 150)}` : ""}`);
        await reply(undefined, [{ title: t("modlog_title", { count: rows.length }), description: lines.join("\n").slice(0, 4000), color: 0x5865f2 }]);
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    await reply(t("cmd_error", { error: String(e?.message || e).slice(0, 300) })).catch(() => {});
    return true;
  }
}
