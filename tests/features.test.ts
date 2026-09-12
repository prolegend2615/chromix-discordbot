import test from "node:test";
import assert from "node:assert/strict";

import { calculateAverageResponseMs, buildQuotaStatus, resolveThreadConversationKey } from "../src/services/metrics.js";
import { setUserBlacklist, isUserBlacklisted } from "../src/services/settings.js";

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

test("resolveThreadConversationKey keeps thread chats distinct from channel chats", () => {
  assert.equal(resolveThreadConversationKey("guild-1", "thread-42", "user-9"), "guild-1:thread-42:user-9");
  assert.equal(resolveThreadConversationKey("guild-1", undefined, "user-9"), "guild-1:channel:user-9");
});

test("blacklist status flips on and off for a user", async () => {
  const userId = "blacklist-test-user";
  await setUserBlacklist(userId, true);
  assert.equal(await isUserBlacklisted(userId), true);
  await setUserBlacklist(userId, false);
  assert.equal(await isUserBlacklisted(userId), false);
});
