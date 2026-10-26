import { dbPromise } from "../database.js";
type Role = "user" | "assistant";
export interface HistoryMessage { role: Role; content: string; }
async function conversationId(userId: string, guildId: string | undefined, channelId: string) { const db = await dbPromise; const scope = guildId ?? ""; const row = await db.get<{ id: number }>("SELECT id FROM conversations WHERE user_id = ? AND guild_id = ? AND channel_id = ?", userId, scope, channelId); if (row) return row.id; const now = Date.now(); return (await db.run("INSERT INTO conversations (user_id, guild_id, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", userId, scope, channelId, now, now)).lastID!; }
export async function addHistory(userId: string, guildId: string | undefined, channelId: string, message: HistoryMessage, discordMessageId?: string, referencedMessageId?: string) { const db = await dbPromise; const id = await conversationId(userId, guildId, channelId); await db.run("INSERT INTO messages (conversation_id, discord_message_id, role, content, referenced_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, discordMessageId ?? null, message.role, message.content, referencedMessageId ?? null, Date.now()); await db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", Date.now(), id); }
export async function getHistory(userId: string, guildId: string | undefined, channelId: string, limit: number): Promise<HistoryMessage[]> { const db = await dbPromise; const row = await db.get<{ id: number }>("SELECT id FROM conversations WHERE user_id = ? AND guild_id = ? AND channel_id = ?", userId, guildId ?? "", channelId); if (!row) return []; return (await db.all<HistoryMessage[]>("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?", row.id, limit)).reverse(); }
export async function clearHistory(userId: string, guildId: string | undefined, channelId: string) { await (await dbPromise).run("DELETE FROM conversations WHERE user_id = ? AND guild_id = ? AND channel_id = ?", userId, guildId ?? "", channelId); }
export async function replaceHistoryWithSummary(userId: string, guildId: string | undefined, channelId: string, summary: string) {
  const db = await dbPromise;
  await clearHistory(userId, guildId, channelId);
  const now = Date.now();
  const result = await db.run("INSERT INTO conversations(user_id,guild_id,channel_id,created_at,updated_at) VALUES(?,?,?,?,?)", userId, guildId ?? "", channelId, now, now);
  await db.run("INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)", result.lastID, "assistant", summary.slice(0, 6000), now);
}
export async function replaceLastAssistant(userId: string, guildId: string | undefined, channelId: string, content: string) {
  const db = await dbPromise;
  const conversation = await db.get<{ id: number }>("SELECT id FROM conversations WHERE user_id=? AND guild_id=? AND channel_id=?", userId, guildId ?? "", channelId);
  if (!conversation) return false;
  const result = await db.run("UPDATE messages SET content=?,created_at=? WHERE id=(SELECT id FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1)", content, Date.now(), conversation.id);
  return result.changes === 1;
}
export async function pruneHistory(guildId: string, retentionDays: number) {
  if (retentionDays <= 0) return;
  const db = await dbPromise;
  await db.run("DELETE FROM conversations WHERE guild_id=? AND updated_at<?", guildId, Date.now() - retentionDays * 86400_000);
}
