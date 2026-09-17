import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyProviderError, hasTimeWord, isModelAvailable, isTransientNetworkError, parsePrefixCommand, parseSetAfkCommand, userFacingProviderError } from "../src/logic.js";

test("parses prefix commands and arguments case-insensitively", () => {
  assert.deepEqual(parsePrefixCommand("  C.CHAT hello world"), { name: "chat", args: ["hello", "world"] });
  assert.equal(parsePrefixCommand("hello"), null);
});

test("validates provider models", () => {
  assert.equal(isModelAvailable("gemini", "gemini-3.6-flash"), true);
  assert.equal(isModelAvailable("gemini", "llama-3.3-70b-versatile"), false);
  assert.equal(isModelAvailable("groq", "llama-3.1-8b-instant"), true);
  assert.equal(isModelAvailable("openrouter", "deepseek/deepseek-v4-flash"), true);
});

test("matches only the standalone time word", () => {
  assert.equal(hasTimeWord("What TIME is it?"), true);
  assert.equal(hasTimeWord("sometimes"), false);
  assert.equal(hasTimeWord("timely"), false);
});

test("recognizes transient Discord connection failures", () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })), true);
  assert.equal(isTransientNetworkError(new Error("401 Unauthorized")), false);
});

test("parses only the AI AFK action protocol", () => {
  assert.deepEqual(parseSetAfkCommand("use set_afk (dinner)"), { reason: "dinner" });
  assert.deepEqual(parseSetAfkCommand("USE SET_AFK (None)"), { reason: "None" });
  assert.deepEqual(parseSetAfkCommand("use set_afk ()"), { reason: "None" });
  assert.equal(parseSetAfkCommand("set my afk, reason: dinner"), null);
  assert.equal(parseSetAfkCommand("use set_afk (dinner) and then say okay"), null);
});

test("classifies provider failures", () => {
  assert.equal(classifyProviderError(new Error("HTTP 429 rate limit")), "rate_limit");
  assert.equal(classifyProviderError(new Error("request timed out")), "timeout");
  assert.match(userFacingProviderError(new Error("503 unavailable")), /temporarily unavailable/);
});
