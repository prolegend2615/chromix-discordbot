import { dbPromise } from "../database.js";

export const MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
export type ScheduledPost = { id: number; guild_id?: string; channel_id: string; creator_id: string; content: string; scheduled_at: number; delivery_attempts: number; retry_at: number | null; last_error: string | null };
export type Timer = { id: number; channel_id: string; creator_id: string; label: string; due_at: number; delivery_attempts: number; retry_at: number | null; last_error: string | null };

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
  return (await dbPromise).all<ScheduledPost[]>("SELECT id,guild_id,channel_id,creator_id,content,scheduled_at,delivery_attempts,retry_at,last_error FROM scheduled_posts WHERE status='scheduled' AND scheduled_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY scheduled_at,id", now, now);
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
  return (await dbPromise).all<Timer[]>("SELECT id,channel_id,creator_id,label,due_at,delivery_attempts,retry_at,last_error FROM timers WHERE due_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY due_at,id", now, now);
}

export async function deleteTimer(id: number) {
  await (await dbPromise).run("DELETE FROM timers WHERE id=?", id);
}

export async function getUserScheduledPosts(userId: string) {
  return (await dbPromise).all<ScheduledPost[]>("SELECT id,guild_id,channel_id,creator_id,content,scheduled_at,delivery_attempts,retry_at,last_error FROM scheduled_posts WHERE creator_id=? AND status='scheduled' ORDER BY scheduled_at", userId);
}

export async function deleteScheduledPost(id: number, userId: string) {
  const result = await (await dbPromise).run("UPDATE scheduled_posts SET status='cancelled' WHERE id=? AND creator_id=? AND status='scheduled'", id, userId);
  return result.changes === 1;
}

export async function getUserTimers(userId: string) {
  return (await dbPromise).all<Timer[]>("SELECT id,channel_id,creator_id,label,due_at,delivery_attempts,retry_at,last_error FROM timers WHERE creator_id=? ORDER BY due_at", userId);
}

export async function deleteUserTimer(id: number, userId: string) {
  const result = await (await dbPromise).run("DELETE FROM timers WHERE id=? AND creator_id=?", id, userId);
  return result.changes === 1;
}

async function markFailure(kind: "scheduled_message" | "timer", id: number, guildId: string, creatorId: string, attempts: number, error: unknown) {
  const db = await dbPromise;
  const next = attempts + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (next >= 3) {
    await db.run("INSERT INTO scheduled_delivery_failures(kind,action_id,guild_id,creator_id,error,created_at) VALUES(?,?,?,?,?,?)", kind, id, guildId, creatorId, message, Date.now());
    if (kind === "timer") await db.run("DELETE FROM timers WHERE id=?", id);
    else await db.run("UPDATE scheduled_posts SET status='failed',last_error=? WHERE id=?", message, id);
    return { failed: true, attempts: next };
  }
  const table = kind === "timer" ? "timers" : "scheduled_posts";
  await db.run(`UPDATE ${table} SET delivery_attempts=?,retry_at=?,last_error=? WHERE id=?`, next, Date.now() + 60_000, message, id);
  return { failed: false, attempts: next };
}

export async function markScheduledPostDeliveryFailure(post: ScheduledPost, error: unknown) {
  return markFailure("scheduled_message", post.id, post.guild_id ?? "", post.creator_id, post.delivery_attempts ?? 0, error);
}

export async function markTimerDeliveryFailure(timer: Timer, error: unknown) {
  return markFailure("timer", timer.id, "", timer.creator_id, timer.delivery_attempts ?? 0, error);
}
