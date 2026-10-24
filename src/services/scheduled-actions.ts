import { dbPromise } from "../database.js";

export const MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
export type ScheduledPost = { id: number; channel_id: string; creator_id: string; content: string; scheduled_at: number };
export type Timer = { id: number; channel_id: string; creator_id: string; label: string; due_at: number };

export function parseScheduleDuration(value: string): number | null {
  const match = /^\s*(\d+)\s*([smhd])\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const seconds = amount * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[match[2].toLowerCase() as "s" | "m" | "h" | "d"];
  return seconds <= MAX_SCHEDULE_SECONDS ? seconds : null;
}

export async function createScheduledPost(input: { guildId: string; channelId: string; creatorId: string; content: string; scheduledAt: number }) {
  const content = input.content.trim();
  if (!content) throw new Error("The scheduled message cannot be empty.");
  if (content.length > 1800) throw new Error("Scheduled messages must be 1,800 characters or fewer.");
  const db = await dbPromise;
  const pending = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_posts WHERE creator_id=? AND status='scheduled'", input.creatorId);
  if (Number(pending?.count ?? 0) >= 10) throw new Error("You can have up to 10 scheduled messages pending at a time.");
  const now = Date.now();
  const result = await db.run(
    "INSERT INTO scheduled_posts(guild_id,channel_id,creator_id,content,scheduled_at,created_at) VALUES(?,?,?,?,?,?)",
    input.guildId, input.channelId, input.creatorId, content, input.scheduledAt, now,
  );
  return Number(result.lastID);
}

export async function getDueScheduledPosts(now = Date.now()): Promise<ScheduledPost[]> {
  return (await dbPromise).all<ScheduledPost[]>("SELECT id,channel_id,creator_id,content,scheduled_at FROM scheduled_posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at,id", now);
}

export async function markScheduledPostSent(id: number) {
  await (await dbPromise).run("UPDATE scheduled_posts SET status='sent' WHERE id=?", id);
}

export async function createTimer(input: { channelId: string; creatorId: string; label: string; dueAt: number }) {
  const label = input.label.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!label) throw new Error("Give the timer a short label.");
  const db = await dbPromise;
  const pending = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM timers WHERE creator_id=?", input.creatorId);
  if (Number(pending?.count ?? 0) >= 10) throw new Error("You can have up to 10 timers running at a time.");
  const result = await db.run("INSERT INTO timers(channel_id,creator_id,label,due_at,created_at) VALUES(?,?,?,?,?)", input.channelId, input.creatorId, label, input.dueAt, Date.now());
  return Number(result.lastID);
}

export async function getDueTimers(now = Date.now()): Promise<Timer[]> {
  return (await dbPromise).all<Timer[]>("SELECT id,channel_id,creator_id,label,due_at FROM timers WHERE due_at<=? ORDER BY due_at,id", now);
}

export async function deleteTimer(id: number) {
  await (await dbPromise).run("DELETE FROM timers WHERE id=?", id);
}
