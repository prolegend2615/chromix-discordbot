import { parseWebSearchCommand, type WebSearchProvider } from "../logic.js";

export type WebSearchResult = {
  provider: WebSearchProvider;
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
};

export type WebSearchFeedback = {
  provider: WebSearchProvider;
  query: string;
  outcome: "results" | "empty" | "error";
  errorMessage?: string;
  results: WebSearchResult[];
};

export type WebSearchPromptContext = {
  availableProviders: WebSearchProvider[];
  feedback?: WebSearchFeedback;
};

export class WebSearchProviderError extends Error {
  constructor(
    readonly provider: WebSearchProvider,
    readonly kind: "not_configured" | "invalid_request" | "authentication" | "rate_limit" | "unavailable" | "network" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

const PROVIDERS: WebSearchProvider[] = ["brave", "exa"];
const MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 2 * 60 * 1000;
const searchCache = new Map<string, { expiresAt: number; results: WebSearchResult[] }>();

function providerName(provider: WebSearchProvider) {
  return provider === "brave" ? "Brave" : "Exa";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function mapResults(provider: WebSearchProvider, payload: unknown): WebSearchResult[] {
  const root = asRecord(payload);
  const resultList = provider === "brave"
    ? asRecord(root.web).results
    : root.results;
  if (!Array.isArray(resultList)) return [];

  return resultList.slice(0, MAX_RESULTS).flatMap((raw): WebSearchResult[] => {
    const item = asRecord(raw);
    const url = safeHttpsUrl(item.url);
    if (!url) return [];

    const highlights = Array.isArray(item.highlights)
      ? item.highlights.map(asText).filter(Boolean).join(" ")
      : "";
    const snippet = asText(
      provider === "brave"
        ? item.description ?? item.snippet
        : item.summary ?? item.text ?? highlights,
    ).slice(0, 1200);
    const publishedDate = asText(item.page_age ?? item.publishedDate);

    return [{
      provider,
      title: asText(item.title).slice(0, 240) || url,
      url,
      snippet,
      ...(publishedDate ? { publishedDate: publishedDate.slice(0, 100) } : {}),
    }];
  });
}

function httpError(provider: WebSearchProvider, status: number): WebSearchProviderError {
  const label = providerName(provider);
  if (status === 401 || status === 403) {
    return new WebSearchProviderError(provider, "authentication", `${label} rejected its API key (HTTP ${status}).`);
  }
  if (status === 429) {
    return new WebSearchProviderError(provider, "rate_limit", `${label} rate-limited the search request (HTTP 429).`);
  }
  if (status >= 500) {
    return new WebSearchProviderError(provider, "unavailable", `${label} is temporarily unavailable (HTTP ${status}).`);
  }
  return new WebSearchProviderError(provider, "invalid_request", `${label} rejected the search request (HTTP ${status}).`);
}

export async function searchWeb(
  provider: WebSearchProvider,
  query: string,
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<WebSearchResult[]> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH) {
    throw new WebSearchProviderError(provider, "invalid_request", "The web search query must be between 1 and 500 characters.");
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    const variable = provider === "brave" ? "BRAVE_SEARCH_API_KEY" : "EXA_API_KEY";
    throw new WebSearchProviderError(provider, "not_configured", `${providerName(provider)} search is not configured; ${variable} is missing.`);
  }

  const cacheKey = `${provider}:${normalizedQuery.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  if (cached) searchCache.delete(cacheKey);

  const fetchImpl = options.fetchImpl ?? fetch;
  const label = providerName(provider);
  let response: Response;
  try {
    if (provider === "brave") {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", normalizedQuery);
      url.searchParams.set("count", String(MAX_RESULTS));
      url.searchParams.set("safesearch", "moderate");
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      response = await fetchImpl("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query: normalizedQuery,
          type: "auto",
          numResults: MAX_RESULTS,
          contents: { highlights: true },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    }
  } catch {
    throw new WebSearchProviderError(provider, "network", `${label} search could not reach the provider or timed out.`);
  }

  if (!response.ok) throw httpError(provider, response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WebSearchProviderError(provider, "invalid_response", `${label} returned an invalid search response.`);
  }

  const results = mapResults(provider, payload);
  searchCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, results });
  while (searchCache.size > 100) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey === undefined) break;
    searchCache.delete(oldestKey);
  }
  return results;
}

function uniqueResults(results: WebSearchResult[]) {
  const seen = new Set<string>();
  return results.filter(result => {
    const key = result.url.replace(/#.*$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fallbackMessage() {
  return "I couldn't complete the web search. Please try again.";
}

/**
 * Gives the model the provider response, then lets it choose the next step.
 * Each provider is called at most once per user request.
 */
export async function runWebSearchAgent(input: {
  enabled?: boolean;
  ask: (context: WebSearchPromptContext) => Promise<string>;
  search: (provider: WebSearchProvider, query: string) => Promise<WebSearchResult[]>;
  onSearchStart?: (provider: WebSearchProvider, query: string) => Promise<unknown> | unknown;
}): Promise<{ answer: string; results: WebSearchResult[] }> {
  const attempted = new Set<WebSearchProvider>();
  const collectedResults: WebSearchResult[] = [];
  let feedback: WebSearchFeedback | undefined;
  let answer = "";

  for (let turn = 0; turn < 5; turn += 1) {
    const availableProviders = input.enabled === false
      ? []
      : PROVIDERS.filter(provider => !attempted.has(provider));
    answer = await input.ask({ availableProviders, feedback });

    const command = parseWebSearchCommand(answer);
    if (!command) {
      if (/^\s*use\s+search_(?:brave|exa)\b/i.test(answer)) {
        return { answer: fallbackMessage(), results: uniqueResults(collectedResults) };
      }
      return { answer, results: uniqueResults(collectedResults) };
    }

    if (!availableProviders.includes(command.provider)) {
      feedback = {
        provider: command.provider,
        query: command.query,
        outcome: "error",
        errorMessage: "That provider is unavailable because it was already attempted. Do not repeat it; choose an available provider or answer from the supplied results.",
        results: uniqueResults(collectedResults),
      };
      continue;
    }

    attempted.add(command.provider);
    try {
      try {
        await input.onSearchStart?.(command.provider, command.query);
      } catch {
        // A failed status-message edit should not prevent the actual search.
      }
      const results = await input.search(command.provider, command.query);
      collectedResults.push(...results);
      const mergedResults = uniqueResults(collectedResults);
      feedback = {
        provider: command.provider,
        query: command.query,
        outcome: mergedResults.length ? "results" : "empty",
        ...(mergedResults.length ? {} : { errorMessage: "The provider returned no usable results." }),
        results: mergedResults,
      };
    } catch (error) {
      feedback = {
        provider: command.provider,
        query: command.query,
        outcome: "error",
        errorMessage: error instanceof WebSearchProviderError
          ? error.message
          : `${providerName(command.provider)} search failed due to a network or provider error.`,
        results: uniqueResults(collectedResults),
      };
    }
  }

  return {
    answer: /^\s*use\s+search_(?:brave|exa)\b/i.test(answer) ? fallbackMessage() : answer,
    results: uniqueResults(collectedResults),
  };
}

function escapeDiscordMentions(text: string) {
  return text
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/<@!?(\d+)>/g, "<@\u200b$1>");
}

export function formatWebSearchSources(results: WebSearchResult[]) {
  const sources = uniqueResults(results).slice(0, 5);
  if (!sources.length) return "";
  const lines = sources.map((result, index) => {
    const title = escapeDiscordMentions(result.title)
      .replace(/[\[\]]/g, "\\$&")
      .slice(0, 180);
    return `${index + 1}. [${title || "Source"}](<${result.url}>)`;
  });
  return `\n\nSources:\n${lines.join("\n")}`;
}
