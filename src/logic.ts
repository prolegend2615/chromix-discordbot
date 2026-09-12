export const MODELS = {
  gemini: ["gemini-3.6-flash"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
} as const;

export function parsePrefixCommand(content: string, prefix = "c.") {
  const trimmed = content.trim();
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const [name, ...args] = trimmed.slice(prefix.length).trim().split(/\s+/);
  return name ? { name: name.toLowerCase(), args } : null;
}

export function isModelAvailable(provider: keyof typeof MODELS, model: string) {
  return (MODELS[provider] as readonly string[]).includes(model);
}

export function classifyProviderError(error: unknown): "rate_limit" | "timeout" | "unavailable" | "invalid" | "unknown" {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/rate.?limit|too many requests|429/.test(text)) return "rate_limit";
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/401|403|invalid.*(key|api)|bad request/.test(text)) return "invalid";
  if (/503|502|unavailable|overloaded|network|fetch failed/.test(text)) return "unavailable";
  return "unknown";
}

export function userFacingProviderError(error: unknown) {
  switch (classifyProviderError(error)) {
    case "rate_limit": return "The AI provider is rate-limiting requests. Please try again in a moment.";
    case "timeout": return "The AI request timed out. Please try again.";
    case "unavailable": return "The AI provider is temporarily unavailable. Please try again shortly.";
    case "invalid": return "The AI provider configuration is invalid. Please contact the bot administrator.";
    default: return "The AI request failed unexpectedly. Please try again.";
  }
}
