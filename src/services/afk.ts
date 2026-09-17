import { dbPromise } from "../database.js";

export type AfkStatus = {
  user_id: string;
  guild_id: string;
  reason: string;
  created_at: number;
};

export function normalizeAfkReason(reason: string) {
  return reason.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 300) || "None";
}

export async function setAfkStatus(userId: string, guildId: string | undefined, reason: string, createdAt: number) {
  const db = await dbPromise;
  await db.run(
    `INSERT INTO afk_status (user_id, guild_id, reason, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, guild_id) DO UPDATE SET reason=excluded.reason, created_at=excluded.created_at`,
    userId,
    guildId ?? "",
    normalizeAfkReason(reason),
    createdAt,
  );
}

export async function getAfkStatus(userId: string, guildId: string | undefined): Promise<AfkStatus | null> {
  const db = await dbPromise;
  return await db.get<AfkStatus>(
    "SELECT user_id, guild_id, reason, created_at FROM afk_status WHERE user_id=? AND guild_id=?",
    userId,
    guildId ?? "",
  ) ?? null;
}

export async function clearAfkStatus(userId: string, guildId: string | undefined) {
  const db = await dbPromise;
  await db.run("DELETE FROM afk_status WHERE user_id=? AND guild_id=?", userId, guildId ?? "");
}

export function formatAfkDuration(createdAt: number, now = Date.now()) {
  const totalSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `${days}d ${totalHours % 24}h`;
}

function escapeDiscordText(value: string) {
  return value.replace(/[<>]/g, "").replace(/[\\`*_~|]/g, "\\$&").replace(/\s+/g, " ").trim().slice(0, 300);
}

const AFK_RESPONSES = [
  (user: string, reason: string, duration: string) => `🌿 **${user}** is busy right now. Reason: ${reason}. AFK for ${duration}.`,
  (user: string, reason: string, duration: string) => `🌱 **${user}** is touching grass, don't ping them. Reason: ${reason}. AFK for ${duration}.`,
  (user: string, reason: string, duration: string) => `⏳ **${user}** is away at the moment. Reason: ${reason}. They have been AFK for ${duration}.`,
  (user: string, reason: string, duration: string) => `🛌 **${user}** is currently AFK. Reason: ${reason}. Away for ${duration}.`,
];

export function formatAfkMention(user: string, reason: string, createdAt: number, now = Date.now()) {
  const response = AFK_RESPONSES[Math.floor(Math.random() * AFK_RESPONSES.length)];
  return response(escapeDiscordText(user), escapeDiscordText(reason || "None"), formatAfkDuration(createdAt, now));
}