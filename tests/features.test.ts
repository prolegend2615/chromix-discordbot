import test from "node:test";
import assert from "node:assert/strict";

import { calculateAverageResponseMs, buildQuotaStatus, resolvePromptLockKey } from "../src/services/metrics.js";
import { deleteUserDataExceptVip, setUserBlacklist, isUserBlacklisted } from "../src/services/settings.js";
import { dbPromise } from "../src/database.js";
import { createChat, deleteChat, listChats } from "../src/services/chats.js";

test("calculateAverageResponseMs averages a set of response timings", () => {
  assert.equal(calculateAverageResponseMs([1000, 2000, 3000]), 2000);
  assert.equal(calculateAverageResponseMs([]), 0);
});

test("buildQuotaStatus exposes the violation count and remaining budget", () => {
  const result = buildQuotaStatus({ remaining: 2, violations: 5, windowMs: 60000 });
  assert.equal(result.remaining, 2);
  assert.equal(result.violations, 5);
  assert.equal(result.windowMs, 60000);
});

test("resolvePromptLockKey keeps simultaneous prompts isolated by channel", () => {
  assert.equal(resolvePromptLockKey("guild-1", "thread-42", "user-9"), "guild-1:thread-42:user-9");
  assert.equal(resolvePromptLockKey("guild-1", "channel-12", "user-9"), "guild-1:channel-12:user-9");
  assert.notEqual(resolvePromptLockKey("guild-1", "channel-12", "user-9"), resolvePromptLockKey("guild-1", "channel-13", "user-9"));
});

test("blacklist status flips on and off for a user", async () => {
  const userId = "blacklist-test-user";
  await setUserBlacklist(userId, true);
  assert.equal(await isUserBlacklisted(userId), true);
  await setUserBlacklist(userId, false);
  assert.equal(await isUserBlacklisted(userId), false);
});

test("delete-my-data removes stored image quota records tied to the user", async () => {
  const userId = `image-quota-delete-${Date.now()}`;
  const db = await dbPromise;
  await db.run("INSERT INTO image_generation_events(guild_id,user_id,created_at,status) VALUES(?,?,?,'succeeded')", "delete-test-guild", userId, Date.now());
  await deleteUserDataExceptVip(userId);
  const remaining = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM image_generation_events WHERE user_id=?", userId);
  assert.equal(remaining?.count ?? 0, 0);
});

test("chat slots keep histories separate and enforce the free limit", async () => {
  const userId = `chat-slot-test-${Date.now()}`;
  const guildId = "chat-slot-guild";
  const channelId = `chat-slot-channel-${Date.now()}`;
  await createChat(userId, guildId, channelId, false, "Ideas");
  await createChat(userId, guildId, channelId, false, "Work");
  await assert.rejects(() => createChat(userId, guildId, channelId, false, "Too many"), /up to 3 chats/);
  const result = await listChats(userId, guildId, channelId, false);
  assert.equal(result.chats.length, 3);
  await deleteChat(userId, guildId, channelId, result.chats[0]!.chat_id);
  await deleteChat(userId, guildId, channelId, result.chats[1]!.chat_id);
});
