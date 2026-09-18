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
    "SELECT id, user_id, guild_id, channel_id, message, remind_at, created_at FROM reminders WHERE remind_at <= ? ORDER BY remind_at ASC, id ASC",
    now,
  );
}

export async function deleteReminder(id: number) {
  const db = await dbPromise;
  await db.run("DELETE FROM reminders WHERE id=?", id);
}