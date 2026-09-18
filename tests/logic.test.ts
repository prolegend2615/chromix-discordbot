import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyProviderError, formatReminderDuration, hasReminderIntent, hasTimeWord, isModelAvailable, isTransientNetworkError, parsePrefixCommand, parseReminderDuration, parseSetAfkCommand, parseSetReminderCommand, userFacingProviderError } from "../src/logic.js";

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

test("detects reminder intent without forcing the action for every chat", () => {
  assert.equal(hasReminderIntent("remind me in 10 minutes"), true);
  assert.equal(hasReminderIntent("please notify me later"), true);
  assert.equal(hasReminderIntent("schedule a nudge for later"), true);
  assert.equal(hasReminderIntent("tell me a joke"), true);
  assert.equal(hasReminderIntent("what is the weather?"), false);
});

test("parses only the AI AFK action protocol", () => {
  assert.deepEqual(parseSetAfkCommand("use set_afk (dinner)"), { reason: "dinner" });
  assert.deepEqual(parseSetAfkCommand("USE SET_AFK (None)"), { reason: "None" });
  assert.deepEqual(parseSetAfkCommand("use set_afk ()"), { reason: "None" });
  assert.equal(parseSetAfkCommand("set my afk, reason: dinner"), null);
  assert.equal(parseSetAfkCommand("use set_afk (dinner) and then say okay"), null);
});

test("parses and limits the AI reminder action protocol", () => {
  assert.deepEqual(parseSetReminderCommand("use set_reminder (10m) (check the oven)"), {
    duration: "10m",
    message: "check the oven",
  });
  assert.deepEqual(parseSetReminderCommand("USE SET_REMINDER (2h) (call mom (important))"), {
    duration: "2h",
    message: "call mom (important)",
  });
  assert.deepEqual(parseSetReminderCommand("use set_reminder (13h) (too late)"), {
    duration: "13h",
    message: "too late",
  });
  assert.equal(parseSetReminderCommand("use set_reminder (10m)"), null);
  assert.equal(parseSetReminderCommand("use set_reminder (10m) (check) and then say okay"), null);
  assert.equal(parseReminderDuration("30s"), 30);
  assert.equal(parseReminderDuration("5m"), 300);
  assert.equal(parseReminderDuration("12h"), 43200);
  assert.equal(parseReminderDuration("13h"), null);
  assert.equal(parseReminderDuration("0m"), null);
  assert.equal(formatReminderDuration(7200), "2h");
});

test("classifies provider failures", () => {
  assert.equal(classifyProviderError(new Error("HTTP 429 rate limit")), "rate_limit");
  assert.equal(classifyProviderError(new Error("request timed out")), "timeout");
  assert.match(userFacingProviderError(new Error("503 unavailable")), /temporarily unavailable/);
});
