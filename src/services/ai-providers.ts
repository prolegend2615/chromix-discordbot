export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderAttempt = {
  provider: string;
  model: string;
  generate: () => Promise<string>;
};

type OpenAICompatibleRequest = {
  provider: string;
  endpoint: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
};

function extractMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

export async function requestOpenAICompatibleChat(input: OpenAICompatibleRequest): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxTokens,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new Error(`${input.provider} request failed: ${error instanceof Error ? error.message : "network error"}`);
  }

  if (!response.ok) {
    throw new Error(`${input.provider} request failed with HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${input.provider} returned invalid JSON.`);
  }

  const content = extractMessageContent(
    (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content,
  );
  if (!content.trim()) throw new Error(`${input.provider} returned an empty response.`);
  return content;
}

export async function generateWithProviderFallback(
  attempts: ProviderAttempt[],
  onFailure: (attempt: ProviderAttempt, error: unknown, remaining: number) => void = () => undefined,
) {
  if (!attempts.length) throw new Error("No AI providers are configured.");

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    try {
      const text = await attempt.generate();
      if (!text.trim()) throw new Error(`${attempt.provider} returned an empty response.`);
      return { text, provider: attempt.provider, model: attempt.model, attemptNumber: index + 1 };
    } catch (error) {
      lastError = error;
      onFailure(attempt, error, attempts.length - index - 1);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Every configured AI provider failed.");
}
