export const MODELS = {
  gemini: ["gemini-3.6-flash"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b"],
  openrouter: ["google/gemini-3.6-flash", "deepseek/deepseek-v4-flash", "mistralai/mistral-small-2603"],
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

export function hasTimeWord(text: string) {
  return /\btime\b/i.test(text);
}

export function hasReminderIntent(text: string) {
  return /\b(?:remind(?:er|ing)?|remember|forget|notify|notification|alert|ping|tell|say|schedule|nudge|warn)\b|wake\s+me|let\s+me\s+know|message\s+me|don't\s+let\s+me\s+forget|do\s+not\s+let\s+me\s+forget|when\s+(?:it's|it is)\s+time/i.test(text);
}

export function isTransientNetworkError(error: unknown) {
  const value = error as { code?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const text = error instanceof Error ? error.message : String(error);
  return /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|connect timeout|fetch failed|network is unreachable/i.test(`${code} ${text}`);
}

export type SetAfkCommand = {
  reason: string;
};

export function parseSetAfkCommand(text: string): SetAfkCommand | null {
  const match = /^\s*use\s+set_afk\s*(?:\(([\s\S]*)\))?\s*$/i.exec(text);
  if (!match) return null;
  return { reason: match[1]?.trim() || "None" };
}

export type SetReminderCommand = {
  duration: string;
  message: string;
};

export function parseSetReminderCommand(text: string): SetReminderCommand | null {
  const match = /^\s*use\s+set_reminder\s*\(([^)]*)\)\s*\(([\s\S]*)\)\s*$/i.exec(text);
  if (!match) return null;
  const duration = match[1].trim();
  const message = match[2].trim();
  if (!duration || !message) return null;
  return { duration, message };
}

export const MAX_REMINDER_SECONDS = 12 * 60 * 60;

export function parseReminderDuration(value: string): number | null {
  const match = /^\s*(\d+)\s*([smh])\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const multiplier = match[2].toLowerCase() === "s" ? 1 : match[2].toLowerCase() === "m" ? 60 : 60 * 60;
  const seconds = amount * multiplier;
  return seconds <= MAX_REMINDER_SECONDS ? seconds : null;
}

export function formatReminderDuration(seconds: number) {
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
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

// --- SAM TTS Action ---

export type SamSpeakCommand = {
  text: string;
};

export function hasTtsIntent(text: string): boolean {
  return /\b(?:speak|say|tts|voice|read aloud|talk|pronounce|vocalize|robot voice|sam)\b/i.test(text);
}

export function parseSamSpeakCommand(text: string): SamSpeakCommand | null {
  const match = /^\s*use\s+sam_speak\s*\(([\s\S]*)\)\s*$/i.exec(text);
  if (!match) return null;
  const spokenText = match[1]?.trim();
  if (!spokenText) return null;
  return { text: spokenText };
}

// --- Avatar Action ---

export type ShowAvatarCommand = {
  target: string;
};

export function hasAvatarIntent(text: string): boolean {
  return /\b(?:avatar|profile\s*pic(?:ture)?|pfp|profile\s*photo|display\s*picture|profile\s*image|dp)\b/i.test(text);
}

/** Extracts a Discord user ID from a mention tag like <@123> or <@!123>. */
export function extractMentionId(text: string): string | null {
  const match = /<@!?(\d+)>\s*$/i.exec(text);
  if (match) return match[1];
  const anywhere = /<@!?(\d+)>/i.exec(text);
  return anywhere ? anywhere[1] : null;
}

/**
 * Parses the AI avatar action protocol. The target inside the parentheses is
 * either a mention tag (<@123> / <@!123>) naming another user, or "me"/"self"
 * for the requester's own avatar. Defaults to "me" when empty.
 */
export function parseShowAvatarCommand(text: string): ShowAvatarCommand | null {
  const match = /^\s*use\s+show_avatar\s*(?:\(([\s\S]*)\))?\s*$/i.exec(text);
  if (!match) return null;
  const raw = match[1]?.trim() || "";
  const target = raw || "me";
  return { target };
}

// --- Image Generation Action ---

export type GenerateImageCommand = {
  prompt: string;
};

export const IMAGE_GENERATION_WINDOW_MS = 15 * 60 * 1000;
export const IMAGE_GENERATIONS_PER_WINDOW = 3;
export const IMAGE_GENERATIONS_PER_UTC_DAY = 50;

/** Detect requests to create a new image, not requests to view an existing avatar. */
export function hasImageGenerationIntent(text: string): boolean {
  const explicitImageRequest = /\b(?:generate|create|make|draw|paint|illustrate|render|design)\b[\s\S]{0,80}\b(?:images?|pictures?|illustrations?|artworks?|art|photos?|wallpapers?|logos?|posters?|memes?|icons?|avatars?|portraits?|scenes?|landscapes?|profile\s*(?:pictures?|photos?|images?|pics?))\b/i;
  const drawingRequest = /\b(?:draw|paint|illustrate)\b/i;
  return explicitImageRequest.test(text) || drawingRequest.test(text);
}

/** Parses the AI action format used to request one generated image. */
export function parseGenerateImageCommand(text: string): GenerateImageCommand | null {
  const match = /^\s*use\s+generate_image\s*\(([\s\S]*)\)\s*$/i.exec(text);
  if (!match) return null;
  const prompt = match[1]?.trim().replace(/\s+/g, " ");
  if (!prompt) return null;
  return { prompt: prompt.slice(0, 1200) };
}

export type ImageQuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: "window" | "daily"; retryAt: number };

export function evaluateImageGenerationQuota(input: {
  requestsInWindow: number;
  imagesToday: number;
  oldestRequestAt: number | null;
  now: number;
}): ImageQuotaDecision {
  if (input.imagesToday >= IMAGE_GENERATIONS_PER_UTC_DAY) {
    const date = new Date(input.now);
    return {
      allowed: false,
      reason: "daily",
      retryAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
    };
  }
  if (input.requestsInWindow >= IMAGE_GENERATIONS_PER_WINDOW) {
    return {
      allowed: false,
      reason: "window",
      retryAt: (input.oldestRequestAt ?? input.now) + IMAGE_GENERATION_WINDOW_MS + 1,
    };
  }
  return { allowed: true };
}
