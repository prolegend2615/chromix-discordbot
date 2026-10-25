export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

export type ProviderAttempt = {
  provider: string;
  model: string;
  generate: (onChunk?: (text: string) => void) => Promise<string>;
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

function extractDeltaContent(value: unknown): string {
  return extractMessageContent(value);
}

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

export async function requestOpenAICompatibleChat(input: OpenAICompatibleRequest, onChunk?: (text: string) => void): Promise<string> {
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
        stream: true,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new Error(`${input.provider} request failed: ${error instanceof Error ? error.message : "network error"}`);
  }

  if (!response.ok) {
    throw new Error(`${input.provider} request failed with HTTP ${response.status}.`);
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error(`${input.provider} returned invalid JSON.`); }
    const content = extractMessageContent(
      (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content,
    );
    if (!content.trim()) throw new Error(`${input.provider} returned an empty response.`);
    onChunk?.(content);
    return content;
  }

  if (!response.body) throw new Error(`${input.provider} returned an empty response stream.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let streamEnded = false;
  const processLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") streamEnded = true;
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch { throw new Error(`${input.provider} returned invalid streaming JSON.`); }
    const delta = extractDeltaContent((payload as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]?.delta?.content);
    if (delta) {
      content += delta;
      onChunk?.(delta);
    }
  };
  while (!streamEnded) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line.trimEnd());
    if (done) break;
  }
  if (buffer) processLine(buffer.trimEnd());
  if (!content.trim()) throw new Error(`${input.provider} returned an empty response.`);
  return content;
}

export async function generateWithProviderFallback(
  attempts: ProviderAttempt[],
  onFailure: (attempt: ProviderAttempt, error: unknown, remaining: number) => void | Promise<void> = () => undefined,
  onChunk?: (text: string) => void,
) {
  if (!attempts.length) throw new Error("No AI providers are configured.");

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    try {
      const text = await attempt.generate(onChunk);
      if (!text.trim()) throw new Error(`${attempt.provider} returned an empty response.`);
      return { text, provider: attempt.provider, model: attempt.model, attemptNumber: index + 1 };
    } catch (error) {
      lastError = error;
      await onFailure(attempt, error, attempts.length - index - 1);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Every configured AI provider failed.");
}
