import { dbPromise } from "../database.js";

export interface QuotaStatus {
  remaining: number;
  violations: number;
  windowMs: number;
}

export function calculateAverageResponseMs(responseTimesMs: number[]): number {
  if (responseTimesMs.length === 0) return 0;
  const total = responseTimesMs.reduce((sum, value) => sum + value, 0);
  return Math.round(total / responseTimesMs.length);
}

export function buildQuotaStatus({ remaining, violations, windowMs }: { remaining: number; violations: number; windowMs: number }): QuotaStatus {
  return { remaining, violations, windowMs };
}

export function resolveThreadConversationKey(guildId: string | undefined, threadId: string | undefined, userId: string): string {
  return `${guildId ?? "dm"}:${threadId ?? "channel"}:${userId}`;
}

export async function recordResponseMetric(userId: string, guildId: string | undefined, channelId: string, responseTimeMs: number) {
  const db = await dbPromise;
  await db.run("INSERT INTO response_metrics(user_id,guild_id,channel_id,response_time_ms,created_at) VALUES(?,?,?,?,?)", userId, guildId ?? "", channelId, responseTimeMs, Date.now());
}

export async function getAverageResponseTime(userId: string): Promise<number> {
  const db = await dbPromise;
  const rows = await db.all<{ response_time_ms: number }[]>("SELECT response_time_ms FROM response_metrics WHERE user_id=? ORDER BY created_at DESC LIMIT 20", userId);
  const values = rows.map(row => Number(row.response_time_ms ?? 0));
  return calculateAverageResponseMs(values);
}
