import { strict as assert } from "node:assert";
import { test } from "node:test";
import { generateWithProviderFallback, requestOpenAICompatibleChat, type ProviderAttempt } from "../src/services/ai-providers.js";

test("sends an OpenAI-compatible chat request and extracts its answer", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: "text", text: "Hello" }, { type: "text", text: " there" }] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const answer = await requestOpenAICompatibleChat({
    provider: "Xkiro",
    endpoint: "https://api.xkiro.com/v1/chat/completions",
    apiKey: "test-secret",
    model: "qwen/qwen3.8-max:free",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ],
    maxTokens: 500,
    fetchImpl,
  });

  assert.equal(answer, "Hello there");
  assert.equal(requestUrl, "https://api.xkiro.com/v1/chat/completions");
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer test-secret");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: "qwen/qwen3.8-max:free",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ],
    max_tokens: 500,
  });
});

test("does not include provider response bodies or API keys in HTTP errors", async () => {
  const fetchImpl: typeof fetch = async () => new Response("private error body", { status: 401 });
  await assert.rejects(
    requestOpenAICompatibleChat({
      provider: "APInex",
      endpoint: "https://api.apinex.bond/v1/chat/completions",
      apiKey: "test-secret",
      model: "free/gpt-6-luna",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 500,
      fetchImpl,
    }),
    error => {
      assert.match((error as Error).message, /HTTP 401/);
      assert.doesNotMatch((error as Error).message, /private error body|test-secret/);
      return true;
    },
  );
});

test("tries fallback providers in order and returns the first complete answer", async () => {
  const tried: string[] = [];
  const failures: string[] = [];
  const attempts: ProviderAttempt[] = [
    {
      provider: "primary",
      model: "selected-model",
      generate: async () => {
        tried.push("primary");
        throw new Error("primary unavailable");
      },
    },
    {
      provider: "fallback",
      model: "fallback-model",
      generate: async () => {
        tried.push("fallback");
        return "complete answer";
      },
    },
    {
      provider: "unused",
      model: "unused-model",
      generate: async () => {
        tried.push("unused");
        return "should not be used";
      },
    },
  ];

  const result = await generateWithProviderFallback(attempts, (attempt, _error, remaining) => {
    failures.push(`${attempt.provider}:${remaining}`);
  });

  assert.deepEqual(tried, ["primary", "fallback"]);
  assert.deepEqual(failures, ["primary:2"]);
  assert.deepEqual(result, {
    text: "complete answer",
    provider: "fallback",
    model: "fallback-model",
    attemptNumber: 2,
  });
});

test("tries the next model after a temporary-unavailability error", async () => {
  const tried: string[] = [];
  const result = await generateWithProviderFallback([
    {
      provider: "primary",
      model: "primary-model",
      generate: async () => {
        tried.push("primary");
        throw new Error("The AI provider is temporarily unavailable. Please try again shortly.");
      },
    },
    {
      provider: "fallback",
      model: "fallback-model",
      generate: async () => {
        tried.push("fallback");
        return "fallback answer";
      },
    },
  ]);

  assert.deepEqual(tried, ["primary", "fallback"]);
  assert.equal(result.model, "fallback-model");
  assert.equal(result.text, "fallback answer");
});

test("throws the last provider error when every fallback fails", async () => {
  const attempts: ProviderAttempt[] = [
    { provider: "one", model: "one", generate: async () => { throw new Error("first failure"); } },
    { provider: "two", model: "two", generate: async () => { throw new Error("last failure"); } },
  ];
  await assert.rejects(generateWithProviderFallback(attempts), /last failure/);
});
