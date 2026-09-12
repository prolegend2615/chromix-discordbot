import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

mkdirSync("data", { recursive: true });
export const dbPromise = (async () => {
  const db = await open({ filename: join("data", "bot.db"), driver: sqlite3.Database });
  await db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  await db.exec(`CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT NOT NULL, guild_id TEXT NOT NULL DEFAULT '', custom_system_prompt TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT 'Default', custom_persona TEXT NOT NULL DEFAULT '', response_length TEXT NOT NULL DEFAULT 'Medium', safety_level TEXT NOT NULL DEFAULT 'Balanced', provider TEXT NOT NULL DEFAULT 'gemini', model TEXT NOT NULL DEFAULT 'gemini-3.6-flash', vip INTEGER NOT NULL DEFAULT 0, blacklisted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, guild_id)); CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, guild_id TEXT NOT NULL DEFAULT '', channel_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, guild_id, channel_id)); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, discord_message_id TEXT, role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), content TEXT NOT NULL, referenced_message_id TEXT, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at DESC); CREATE TABLE IF NOT EXISTS channel_rules (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, rule TEXT NOT NULL CHECK(rule IN ('listen', 'ignore')), created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, channel_id)); CREATE TABLE IF NOT EXISTS prompt_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS prompt_events_user_created ON prompt_events(user_id, created_at DESC); CREATE TABLE IF NOT EXISTS response_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, guild_id TEXT NOT NULL DEFAULT '', channel_id TEXT NOT NULL, response_time_ms INTEGER NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS response_metrics_user_created ON response_metrics(user_id, created_at DESC); CREATE TABLE IF NOT EXISTS quota_violations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT 'prompt_limit'); CREATE INDEX IF NOT EXISTS quota_violations_user_created ON quota_violations(user_id, created_at DESC);`);
  const columns = await db.all<{ name: string }[]>("PRAGMA table_info(user_settings)");
  if (!columns.some(c => c.name === "provider")) await db.exec("ALTER TABLE user_settings ADD COLUMN provider TEXT NOT NULL DEFAULT 'gemini'");
  if (!columns.some(c => c.name === "model")) await db.exec("ALTER TABLE user_settings ADD COLUMN model TEXT NOT NULL DEFAULT 'gemini-3.6-flash'");
  if (!columns.some(c => c.name === "custom_persona")) await db.exec("ALTER TABLE user_settings ADD COLUMN custom_persona TEXT NOT NULL DEFAULT ''");
  if (!columns.some(c => c.name === "blacklisted")) await db.exec("ALTER TABLE user_settings ADD COLUMN blacklisted INTEGER NOT NULL DEFAULT 0");
  await db.exec("UPDATE user_settings SET model = 'gemini-3.6-flash' WHERE model = 'gemini-2.5-flash'");
  return db;
})();
