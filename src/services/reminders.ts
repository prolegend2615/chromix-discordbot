import { dbPromise } from "../database.js";
import { MAX_REMINDER_SECONDS, parseReminderDuration } from "../logic.js";

export const MAX_REMINDER_MS = MAX_REMINDER_SECONDS * 1000;
export const MAX_REMINDER_MESSAGE_LENGTH = 1000;

export type Reminder = {
  id: number;
  user_id: string;
  guild_id: string;
  channel_id: string;
  message: string;
  remind_at: number;
  created_at: number;
  delivery_attempts: number;
  retry_at: number | null;
  last_error: string | null;
};

function normalizeReminderMessage(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_REMINDER_MESSAGE_LENGTH);
}

export function validateReminderRequest(duration: string, message: string, now = Date.now()) {
  const seconds = parseReminderDuration(duration);
  const normalizedMessage = normalizeReminderMessage(message);
  if (seconds === null) return { ok: false as const, error: "Reminders must use a positive duration in seconds, minutes, or hours, with a maximum of 12 hours." };
  if (!normalizedMessage) return { ok: false as const, error: "The reminder message cannot be empty." };
  return {
    ok: true as const,
    seconds,
    message: normalizedMessage,
    remindAt: now + seconds * 1000,
  };
}

export async function createReminder(args: {
  userId: string;
  guildId?: string;
  channelId: string;
  duration: string;
  message: string;
  now?: number;
}) {
  const now = args.now ?? Date.now();
  const validated = validateReminderRequest(args.duration, args.message, now);
  if (!validated.ok) throw new Error(validated.error);
  if (validated.remindAt - now > MAX_REMINDER_MS) {
    throw new Error("Reminders cannot be set for more than 12 hours.");
  }
  const db = await dbPromise;
  const result = await db.run(
    "INSERT INTO reminders (user_id, guild_id, channel_id, message, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args.userId,
    args.guildId ?? "",
    args.channelId,
    validated.message,
    validated.remindAt,
    now,
  );
  return {
    id: Number(result.lastID),
    seconds: validated.seconds,
    message: validated.message,
    remindAt: validated.remindAt,
  };
}

export async function getDueReminders(now = Date.now()): Promise<Reminder[]> {
  const db = await dbPromise;
  return db.all<Reminder[]>(
    "SELECT id, user_id, guild_id, channel_id, message, remind_at, created_at, delivery_attempts, retry_at, last_error FROM reminders WHERE remind_at <= ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY remind_at ASC, id ASC",
    now, now,
  );
}

export async function deleteReminder(id: number) {
  const db = await dbPromise;
  await db.run("DELETE FROM reminders WHERE id=?", id);
}

export async function getUserReminders(userId: string, guildId?: string) {
  return (await dbPromise).all<Reminder[]>("SELECT id,user_id,guild_id,channel_id,message,remind_at,created_at,delivery_attempts,retry_at,last_error FROM reminders WHERE user_id=? AND guild_id=? ORDER BY remind_at", userId, guildId ?? "");
}

export async function deleteUserReminder(id: number, userId: string) {
  const result = await (await dbPromise).run("DELETE FROM reminders WHERE id=? AND user_id=?", id, userId);
  return result.changes === 1;
}

export async function markReminderDeliveryFailure(reminder: Reminder, error: unknown) {
  const db = await dbPromise;
  const attempts = Number(reminder.delivery_attempts ?? 0) + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (attempts >= 3) {
    await db.run("INSERT INTO scheduled_delivery_failures(kind,action_id,guild_id,creator_id,error,created_at) VALUES(?,?,?,?,?,?)", "reminder", reminder.id, reminder.guild_id, reminder.user_id, message, Date.now());
    await db.run("DELETE FROM reminders WHERE id=?", reminder.id);
    return { failed: true, attempts };
  }
  await db.run("UPDATE reminders SET delivery_attempts=?,retry_at=?,last_error=? WHERE id=?", attempts, Date.now() + 60_000, message, reminder.id);
  return { failed: false, attempts };
}
