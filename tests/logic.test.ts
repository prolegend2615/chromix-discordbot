import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyProviderError, hasTimeWord, isModelAvailable, parsePrefixCommand, parseSetAfkRequest, userFacingProviderError } from "../src/logic.js";

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

test("parses AFK requests with a default reason", () => {
  assert.deepEqual(parseSetAfkRequest("set my afk, reason: dinner", "alice"), { username: "alice", reason: "dinner" });
  assert.deepEqual(parseSetAfkRequest("SET AFK", "alice"), { username: "alice", reason: "None" });
  assert.deepEqual(parseSetAfkRequest("please set my afk", "alice"), { username: "alice", reason: "None" });
  assert.equal(parseSetAfkRequest("don't set my afk", "alice"), null);
  assert.equal(parseSetAfkRequest("sometimes I am timely", "alice"), null);
});

test("classifies provider failures", () => {
  assert.equal(classifyProviderError(new Error("HTTP 429 rate limit")), "rate_limit");
  assert.equal(classifyProviderError(new Error("request timed out")), "timeout");
  assert.match(userFacingProviderError(new Error("503 unavailable")), /temporarily unavailable/);
});
