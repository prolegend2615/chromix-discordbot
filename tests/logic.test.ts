import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyProviderError, isModelAvailable, parsePrefixCommand, userFacingProviderError } from "../src/logic.js";

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

test("classifies provider failures", () => {
  assert.equal(classifyProviderError(new Error("HTTP 429 rate limit")), "rate_limit");
  assert.equal(classifyProviderError(new Error("request timed out")), "timeout");
  assert.match(userFacingProviderError(new Error("503 unavailable")), /temporarily unavailable/);
});
