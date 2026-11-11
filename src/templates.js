// Ready-made server layouts for preview_blueprint and apply_blueprint.
// They follow the structure most Discord servers use: an info area at the top (welcome, rules,
// announcements), a community area, topic or support areas, voice at the bottom, and a private staff area.

/** Everyone can read and react; only the given roles (staff by default) can post. */
const readOnlyFor = (...writers) => [
  { target: "@everyone", allow: ["ViewChannel", "ReadMessageHistory", "AddReactions"], deny: ["SendMessages", "CreatePublicThreads", "CreatePrivateThreads"] },
  ...writers.map((w) => ({ target: w, allow: ["SendMessages"] })),
];
const readOnly = readOnlyFor("Moderator");

const staffRoles = [
  { name: "Admin", color: "#e74c3c", hoist: true, permissions: ["Administrator"] },
  { name: "Moderator", color: "#3498db", hoist: true,
    permissions: ["ViewChannel", "SendMessages", "ManageMessages", "KickMembers", "ModerateMembers", "ViewAuditLog", "ManageThreads", "MuteMembers", "MoveMembers"] },
  // Most servers list their bots in their own group in the member list.
  { name: "Bots", color: "#95a5a6", hoist: true, for_bots: true },
];

const staffCategory = {
  name: "Staff",
  overrides: [{ target: "@everyone", deny: ["ViewChannel"] }, { target: "Moderator", allow: ["ViewChannel", "SendMessages", "Connect"] }],
  channels: [
    { name: "staff-chat", type: "text", topic: "Staff discussion" },
    { name: "mod-logs", type: "text", topic: "Moderation and bot logs" },
    { name: "Staff Voice", type: "voice" },
  ],
};

const info = (extra = []) => ({
  name: "Information",
  channels: [
    { name: "👋-welcome", type: "text", topic: "Start here: what this server is and where to go", overrides: readOnly },
    { name: "📜-rules", type: "text", topic: "Read before posting", overrides: readOnly },
    { name: "📢-announcements", type: "announcement", topic: "News and updates", overrides: readOnly },
    ...extra,
  ],
});

const voice = (...names) => ({ name: "Voice", channels: names.map((n) => (typeof n === "string" ? { name: n, type: "voice" } : n)) });

export const TEMPLATES = {
  community: {
    description: "Friends or general community: info, chat, media, voice, staff",
    roles: [...staffRoles, { name: "Member", color: "#2ecc71", hoist: true }, { name: "Announcements Ping", color: "#f1c40f" }],
    categories: [
      info([{ name: "🎭-roles", type: "text", topic: "Pick your roles", overrides: readOnly }]),
      { name: "Community", channels: [
        { name: "💬-general", type: "text", topic: "Main chat" },
        { name: "👋-introductions", type: "text", topic: "Say hi and tell us about yourself", slowmode: 60 },
        { name: "🎲-off-topic", type: "text", topic: "Anything goes (within the rules)" },
        { name: "📷-media", type: "text", topic: "Pictures, clips and memes", slowmode: 10 },
        { name: "🤖-bot-commands", type: "text", topic: "Use bot commands here" },
      ] },
      voice("Lounge", "Gaming", "Music"),
      staffCategory,
    ],
  },

  gaming: {
    description: "Gaming group or game community: LFG, clips, game talk, voice squads",
    roles: [...staffRoles, { name: "Gamer", color: "#9b59b6", hoist: true }, { name: "Event Ping", color: "#e67e22" }],
    categories: [
      info([{ name: "📰-updates", type: "text", topic: "Game patches and news", overrides: readOnly }]),
      { name: "Community", channels: [
        { name: "💬-general", type: "text", topic: "Main chat" },
        { name: "🎲-off-topic", type: "text", topic: "Not about the game" },
        { name: "😂-memes", type: "text", slowmode: 10 },
        { name: "🎬-clips", type: "text", topic: "Best plays and highlights", slowmode: 30 },
      ] },
      { name: "Game", channels: [
        { name: "🎮-game-chat", type: "text", topic: "Talk about the game" },
        { name: "🔎-lfg", type: "forum", topic: "Looking for group: say the game mode, platform, region and time.",
          tags: [{ name: "PC", emoji: "🖥️" }, { name: "Console", emoji: "🎮" }, { name: "Mobile", emoji: "📱" }] },
        { name: "🧠-strategies", type: "text", topic: "Guides, builds and tips" },
        { name: "📅-events", type: "text", topic: "Game nights and tournaments", overrides: readOnly },
      ] },
      voice("General", { name: "Squad 1", type: "voice", user_limit: 5 }, { name: "Squad 2", type: "voice", user_limit: 5 }, "AFK"),
      staffCategory,
    ],
  },

  creator: {
    description: "Content creator or streamer: announcements and uploads, fan chat, fan art, events",
    roles: [...staffRoles, { name: "Subscriber", color: "#e91e63", hoist: true }, { name: "Member", color: "#95a5a6" },
      { name: "Stream Ping", color: "#9146ff" }, { name: "Video Ping", color: "#ff0000" }],
    categories: [
      info([{ name: "🔴-live-and-uploads", type: "announcement", topic: "New videos and streams", overrides: readOnly },
        { name: "🎭-roles", type: "text", topic: "Pick your roles and notifications", overrides: readOnly }]),
      { name: "Community", channels: [
        { name: "💬-general", type: "text", topic: "Main chat" },
        { name: "🎲-off-topic", type: "text" },
        { name: "🎨-fan-art", type: "text", topic: "Share what you made", slowmode: 30 },
        { name: "😂-memes", type: "text", slowmode: 10 },
        { name: "💡-suggestions", type: "forum", topic: "Ideas for videos and streams. One per post.",
          tags: [{ name: "Video idea", emoji: "🎬" }, { name: "Stream idea", emoji: "🔴" }, { name: "Done", emoji: "✅" }] },
      ] },
      voice("Lounge", { name: "Watch Party", type: "voice" }, { name: "Stage", type: "stage" }),
      staffCategory,
    ],
  },

  project: {
    description: "Product, app, game or open-source community: news, changelog, support forums, suggestions, showcase",
    roles: [...staffRoles, { name: "Member", color: "#2ecc71", hoist: true }, { name: "Updates Ping", color: "#ad1457" }],
    categories: [
      info([
        { name: "📝-changelog", type: "text", topic: "Release notes for every version", overrides: readOnly },
        { name: "🔗-links", type: "text", topic: "Downloads, website and socials", overrides: readOnly },
        { name: "📚-faq", type: "text", topic: "Answers to common questions", overrides: readOnly },
      ]),
      { name: "Community", channels: [
        { name: "💬-general", type: "text", topic: "Main chat" },
        { name: "🎲-off-topic", type: "text" },
        { name: "📷-showcase", type: "text", topic: "Show what you made with it", slowmode: 30 },
      ] },
      { name: "Support", channels: [
        { name: "❓-help", type: "forum", topic: "Ask for help: one question per post, say the version you use and what you tried.",
          tags: [{ name: "Solved", emoji: "✅" }, { name: "Open", emoji: "🟡" }] },
        { name: "🐛-bug-reports", type: "forum", topic: "One bug per post: steps to reproduce, version, logs or screenshots.",
          tags: [{ name: "Confirmed", emoji: "🟢" }, { name: "Fixed", emoji: "✅" }, { name: "Can't reproduce", emoji: "🔴" }] },
        { name: "💡-suggestions", type: "forum", topic: "Feature ideas. One per post.",
          tags: [{ name: "Planned", emoji: "🗓️" }, { name: "Approved", emoji: "🟢" }, { name: "Rejected", emoji: "🔴" }] },
      ] },
      voice("General"),
      staffCategory,
    ],
  },

  study: {
    description: "Study group or class: resources, homework help, study rooms",
    roles: [...staffRoles, { name: "Student", color: "#3498db", hoist: true }],
    categories: [
      info([{ name: "📅-deadlines", type: "text", topic: "Exams and due dates", overrides: readOnly }]),
      { name: "Study", channels: [
        { name: "💬-general", type: "text", topic: "Main chat" },
        { name: "📚-resources", type: "text", topic: "Notes, links and books" },
        { name: "❓-homework-help", type: "forum", topic: "Ask a question. Put the subject in the title.",
          tags: [{ name: "Solved", emoji: "✅" }] },
        { name: "🎲-off-topic", type: "text" },
      ] },
      voice("Quiet Room", { name: "Group Room 1", type: "voice", user_limit: 6 }, { name: "Group Room 2", type: "voice", user_limit: 6 }),
      staffCategory,
    ],
  },
};
