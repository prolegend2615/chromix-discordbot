import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  formatWebSearchSources,
  runWebSearchAgent,
  searchWeb,
  WebSearchProviderError,
  type WebSearchResult,
} from "../src/services/web-search.js";

test("calls Brave with its subscription header and normalizes web results", async () => {
  let capturedUrl = "";
  let capturedHeaders: HeadersInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = input.toString();
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({
      web: {
        results: [
          {
            title: "Current result",
            url: "https://example.com/article",
            description: "A useful snippet.",
            page_age: "2026-10-21",
          },
          { title: "Unsafe link", url: "javascript:alert(1)", description: "ignored" },
        ],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const results = await searchWeb("brave", "  latest bot news ", {
    apiKey: "test-key",
    fetchImpl,
  });

  assert.match(capturedUrl, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
  assert.match(capturedUrl, /q=latest\+bot\+news/);
  assert.equal(new Headers(capturedHeaders).get("X-Subscription-Token"), "test-key");
  assert.deepEqual(results, [{
    provider: "brave",
    title: "Current result",
    url: "https://example.com/article",
    snippet: "A useful snippet.",
    publishedDate: "2026-10-21",
  }]);
});

test("calls Exa with its documented request shape and maps text highlights", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = input.toString();
    capturedInit = init;
    return new Response(JSON.stringify({
      results: [{
        title: "Research result",
        url: "https://example.org/research",
        highlights: ["First passage.", "Second passage."],
        publishedDate: "2026-10-20T00:00:00Z",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const results = await searchWeb("exa", "semantic research question", {
    apiKey: "exa-test-key",
    fetchImpl,
  });

  assert.equal(capturedUrl, "https://api.exa.ai/search");
  assert.equal(new Headers(capturedInit?.headers).get("x-api-key"), "exa-test-key");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    query: "semantic research question",
    type: "auto",
    numResults: 5,
    contents: { highlights: true },
  });
  assert.equal(results[0]?.snippet, "First passage. Second passage.");
  assert.equal(results[0]?.provider, "exa");
});

test("returns sanitized errors without exposing provider response bodies", async () => {
  const fetchImpl: typeof fetch = async () => new Response("sensitive-provider-body", { status: 401 });
  await assert.rejects(
    searchWeb("exa", "auth failure unique query", { apiKey: "not-a-real-key", fetchImpl }),
    error => {
      assert.ok(error instanceof WebSearchProviderError);
      assert.match(error.message, /rejected its API key/);
      assert.doesNotMatch(error.message, /sensitive-provider-body|not-a-real-key/);
      return true;
    },
  );

  await assert.rejects(
    searchWeb("brave", "missing-key unique query", { fetchImpl }),
    error => error instanceof WebSearchProviderError && error.kind === "not_configured",
  );
});

test("passes provider errors back to the model so it chooses the other provider", async () => {
  const modelTurns: Array<{ availableProviders: string[]; feedback?: { provider: string; outcome: string } }> = [];
  const calledProviders: string[] = [];
  const result = await runWebSearchAgent({
    ask: async context => {
      modelTurns.push({
        availableProviders: context.availableProviders,
        feedback: context.feedback
          ? { provider: context.feedback.provider, outcome: context.feedback.outcome }
          : undefined,
      });
      if (modelTurns.length === 1) return "use search_brave (latest release)";
      if (modelTurns.length === 2) {
        assert.equal(context.feedback?.outcome, "error");
        assert.match(context.feedback?.errorMessage ?? "", /rate-limited/);
        assert.deepEqual(context.availableProviders, ["exa"]);
        return "use search_exa (latest release)";
      }
      assert.equal(context.feedback?.outcome, "results");
      return "The release details are in the source.";
    },
    search: async provider => {
      calledProviders.push(provider);
      if (provider === "brave") {
        throw new WebSearchProviderError("brave", "rate_limit", "Brave rate-limited the search request (HTTP 429).");
      }
      return [{
        provider: "exa",
        title: "Release notes",
        url: "https://example.com/releases",
        snippet: "Release details.",
      }];
    },
  });

  assert.deepEqual(calledProviders, ["brave", "exa"]);
  assert.equal(modelTurns.length, 3);
  assert.equal(result.answer, "The release details are in the source.");
  assert.equal(result.results[0]?.provider, "exa");
});

test("never calls the same provider twice after the model repeats it", async () => {
  const calledProviders: string[] = [];
  let modelTurn = 0;
  const result = await runWebSearchAgent({
    ask: async context => {
      modelTurn += 1;
      if (modelTurn === 1) return "use search_brave (first try)";
      if (modelTurn === 2) return "use search_brave (repeat)";
      if (modelTurn === 3) {
        assert.deepEqual(context.availableProviders, ["exa"]);
        assert.match(context.feedback?.errorMessage ?? "", /already attempted/);
        return "use search_exa (fallback)";
      }
      return "Done with the alternate source.";
    },
    search: async provider => {
      calledProviders.push(provider);
      if (provider === "brave") throw new WebSearchProviderError("brave", "unavailable", "Brave is unavailable.");
      return [{
        provider: "exa",
        title: "Alternate source",
        url: "https://example.net/source",
        snippet: "Verified information.",
      }];
    },
  });

  assert.deepEqual(calledProviders, ["brave", "exa"]);
  assert.equal(modelTurn, 4);
  assert.equal(result.answer, "Done with the alternate source.");
});

test("after both providers fail, gives the model one final turn with search disabled", async () => {
  const calledProviders: string[] = [];
  let modelTurn = 0;
  const result = await runWebSearchAgent({
    ask: async context => {
      modelTurn += 1;
      if (modelTurn === 1) return "use search_brave (first provider)";
      if (modelTurn === 2) {
        assert.deepEqual(context.availableProviders, ["exa"]);
        assert.equal(context.feedback?.outcome, "error");
        return "use search_exa (fallback provider)";
      }
      assert.deepEqual(context.availableProviders, []);
      assert.equal(context.feedback?.provider, "exa");
      assert.equal(context.feedback?.outcome, "error");
      return "I couldn't verify this because both searches failed.";
    },
    search: async provider => {
      calledProviders.push(provider);
      throw new WebSearchProviderError(provider, "unavailable", `${provider} is unavailable.`);
    },
  });

  assert.deepEqual(calledProviders, ["brave", "exa"]);
  assert.equal(modelTurn, 3);
  assert.match(result.answer, /both searches failed/);
  assert.deepEqual(result.results, []);
});

test("formats source links safely without allowing source titles to ping everyone", () => {
  const results: WebSearchResult[] = [{
    provider: "brave",
    title: "@everyone [official] update",
    url: "https://example.com/update",
    snippet: "",
  }];
  const sources = formatWebSearchSources(results);
  assert.match(sources, /@\u200beveryone/);
  assert.match(sources, /https:\/\/example\.com\/update/);
  assert.doesNotMatch(sources, /(^|[^\\])\[official\]/);
});
