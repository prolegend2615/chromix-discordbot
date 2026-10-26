import { randomUUID } from "node:crypto";
import { dbPromise } from "../database.js";

export type ChatSession = {
  user_id: string;
  guild_id: string;
  channel_id: string;
  chat_id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

function scope(guildId: string | undefined) { return guildId ?? ""; }

export function conversationChannelId(channelId: string, chatId: string) {
  return chatId === "default" ? channelId : `${channelId}::chat:${chatId}`;
}

export async function ensureChat(userId: string, guildId: string | undefined, channelId: string): Promise<ChatSession> {
  const db = await dbPromise;
  const guild = scope(guildId);
  let row = await db.get<ChatSession>("SELECT * FROM chat_sessions WHERE user_id=? AND guild_id=? AND channel_id=? ORDER BY updated_at DESC LIMIT 1", userId, guild, channelId);
  if (row) return row;
  const now = Date.now();
  await db.run("INSERT INTO chat_sessions(user_id,guild_id,channel_id,chat_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", userId, guild, channelId, "default", "Main chat", now, now);
  row = await db.get<ChatSession>("SELECT * FROM chat_sessions WHERE user_id=? AND guild_id=? AND channel_id=? AND chat_id='default'", userId, guild, channelId);
  return row!;
}

export async function listChats(userId: string, guildId: string | undefined, channelId: string, vip: boolean) {
  await ensureChat(userId, guildId, channelId);
  const db = await dbPromise;
  const chats = await db.all<ChatSession[]>("SELECT * FROM chat_sessions WHERE user_id=? AND guild_id=? AND channel_id=? ORDER BY updated_at DESC,created_at ASC", userId, scope(guildId), channelId);
  return { chats, limit: vip ? 10 : 3 };
}

export async function getCurrentChat(userId: string, guildId: string | undefined, channelId: string) {
  const { chats } = await listChats(userId, guildId, channelId, false);
  return chats[0]!;
}

export async function selectChat(userId: string, guildId: string | undefined, channelId: string, chatId: string) {
  const db = await dbPromise;
  const result = await db.run("UPDATE chat_sessions SET updated_at=? WHERE user_id=? AND guild_id=? AND channel_id=? AND chat_id=?", Date.now(), userId, scope(guildId), channelId, chatId);
  if (result.changes !== 1) throw new Error("That chat no longer exists.");
  return getCurrentChat(userId, guildId, channelId);
}

export async function createChat(userId: string, guildId: string | undefined, channelId: string, vip: boolean, name: string) {
  const { chats, limit } = await listChats(userId, guildId, channelId, vip);
  if (chats.length >= limit) throw new Error(`You can have up to ${limit} chats here${vip ? "" : ". VIP users can have up to 10"}.`);
  const cleanName = name.replace(/[\r\n<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40) || `Chat ${chats.length + 1}`;
  const now = Date.now();
  const chatId = randomUUID().replaceAll("-", "").slice(0, 18);
  const db = await dbPromise;
  await db.run("INSERT INTO chat_sessions(user_id,guild_id,channel_id,chat_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", userId, scope(guildId), channelId, chatId, cleanName, now, now);
  return (await db.get<ChatSession>("SELECT * FROM chat_sessions WHERE user_id=? AND guild_id=? AND channel_id=? AND chat_id=?", userId, scope(guildId), channelId, chatId))!;
}

export async function renameChat(userId: string, guildId: string | undefined, channelId: string, chatId: string, name: string) {
  const cleanName = name.replace(/[\r\n<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40);
  if (!cleanName) throw new Error("Chat names cannot be empty.");
  const db = await dbPromise;
  const result = await db.run("UPDATE chat_sessions SET name=?,updated_at=? WHERE user_id=? AND guild_id=? AND channel_id=? AND chat_id=?", cleanName, Date.now(), userId, scope(guildId), channelId, chatId);
  if (result.changes !== 1) throw new Error("That chat no longer exists.");
}

export async function deleteChat(userId: string, guildId: string | undefined, channelId: string, chatId: string) {
  const { chats } = await listChats(userId, guildId, channelId, true);
  if (chats.length <= 1) throw new Error("Keep at least one chat. You can rename the main chat instead.");
  const db = await dbPromise;
  await db.run("DELETE FROM conversations WHERE user_id=? AND guild_id=? AND channel_id=?", userId, scope(guildId), conversationChannelId(channelId, chatId));
  await db.run("DELETE FROM chat_sessions WHERE user_id=? AND guild_id=? AND channel_id=? AND chat_id=?", userId, scope(guildId), channelId, chatId);
}
