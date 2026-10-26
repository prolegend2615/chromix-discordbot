export const MODELS = {
  gemini: ["gemini-3.6-flash"],
  xkiro: ["qwen/qwen3.8-max:free"],
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

export type WebSearchProvider = "brave" | "exa";

export type WebSearchCommand = {
  provider: WebSearchProvider;
  query: string;
};

/** Read a complete AI action at the end of a response, allowing prose before it
 * and the redundant closing parenthesis some providers add around the command. */
function readAction(text: string, name: string, argumentCount?: number): string[] | null {
  const pattern = new RegExp(`\\buse\\s+${name}\\b`, "i");
  const match = pattern.exec(text);
  if (!match) return null;
  let cursor = match.index + match[0].length;
  const args: string[] = [];

  for (let index = 0; argumentCount === undefined || index < argumentCount; index += 1) {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (argumentCount === undefined && text[cursor] !== "(") break;
    if (text[cursor] !== "(") return null;
    cursor += 1;
    const start = cursor;
    let depth = 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "(") depth += 1;
      else if (text[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) return null;
    args.push(text.slice(start, cursor - 1));
  }

  const trailing = text.slice(cursor).trim();
  // Permit an enclosing pair, Markdown wrappers, and terminal punctuation.
  if (trailing && !/^[)`*_~\s.!?]*$/.test(trailing)) return null;
  // Don't recognize a command quoted as an example or discussion.
  const preceding = text.slice(0, match.index).trimEnd();
  if (/(?:["'`]|\b(?:example|format|syntax|command)\s*:)\s*$/i.test(preceding)) return null;
  return args;
}

function readNoArgAction(text: string, name: string): boolean {
  const match = new RegExp(`\\buse\\s+${name}\\b`, "i").exec(text);
  if (!match) return false;
  const trailing = text.slice(match.index + match[0].length).trim();
  if (trailing && !/^[)`*_~\s.!?]*$/.test(trailing)) return false;
  const preceding = text.slice(0, match.index).trimEnd();
  return !/(?:["'`]|\b(?:example|format|syntax|command)\s*:)\s*$/i.test(preceding);
}

export function readToolActionArguments(text: string, name: string, argumentCount?: number): string[] | null {
  return readAction(text, name, argumentCount);
}

export function hasToolAction(text: string): boolean {
  return /\buse\s+(?:set_afk|set_reminder|sam_speak|show_avatar|generate_image|create_poll|set_timer|schedule_message|get_recent_messages|create_giveaway|create_role|create_channel|create_category|create_layout|delete_channel|delete_category|view_channels|configure_community|rock_paper_scissors|tic_tac_toe|search_(?:brave|exa))\b/i.test(text);
}

export function parseGetRecentMessagesCommand(text: string): { count: number } | null {
  const args = readAction(text, "get_recent_messages", 1);
  if (!args) return null;
  const count = Number(args[0].trim());
  if (!Number.isInteger(count) || count < 1 || count > 20) return null;
  return { count };
}

export type CreateGiveawayCommand = {
  duration: string;
  prize: string;
  winnerCount: number;
  requiredRole: string | null;
};

export function parseCreateGiveawayCommand(text: string): CreateGiveawayCommand | null {
  const args = readAction(text, "create_giveaway", 4);
  if (!args) return null;
  const duration = args[0].trim();
  const prize = args[1].trim();
  const winnerCount = Number(args[2].trim());
  const role = args[3].trim();
  if (!duration || !prize || prize.length > 200 || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20 || !role) return null;
  return { duration, prize, winnerCount, requiredRole: /^none$/i.test(role) ? null : role };
}

/** Parses one complete, provider-specific web search action from the AI. */
export function parseWebSearchCommand(text: string): WebSearchCommand | null {
  const match = /\buse\s+search_(brave|exa)\b/i.exec(text);
  if (!match) return null;
  const args = readAction(text, `search_${match[1]}`, 1);
  if (!args) return null;
  const query = args[0].trim().replace(/\s+/g, " ");
  if (!query || query.length > 500) return null;
  return { provider: match[1].toLowerCase() as WebSearchProvider, query };
}

export function hasReminderIntent(text: string) {
  return /\b(?:remind(?:er|ing)?|remember|forget|notify|notification|alert|ping|tell|say|schedule|nudge|warn)\b|wake\s+me|let\s+me\s+know|message\s+me|don't\s+let\s+me\s+forget|do\s+not\s+let\s+me/i.test(text);
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
  const args = readAction(text, "set_afk", 1);
  if (args) return { reason: args[0].trim() || "None" };
  if (readNoArgAction(text, "set_afk")) return { reason: "None" };
  return null;
}

export type SetReminderCommand = {
  duration: string;
  message: string;
};

export function parseSetReminderCommand(text: string): SetReminderCommand | null {
  const args = readAction(text, "set_reminder", 2);
  if (!args) return null;
  const duration = args[0].trim();
  const message = args[1].trim();
  if (!duration || !message) return null;
  return { duration, message };
}

export type CreatePollCommand = { when: string; question: string; options: string[] };
export function hasPollIntent(text: string) { return /\b(?:poll|survey)\b|\b(?:create|make|start|schedule)\b.{0,40}\bvot(?:e|ing)\b/i.test(text); }
export function parseCreatePollCommand(text: string): CreatePollCommand | null {
  const args = readAction(text, "create_poll", 3);
  if (!args) return null;
  const when = args[0].trim().toLowerCase();
  const question = args[1].trim();
  const options = args[2].split("|").map(option => option.trim()).filter(Boolean);
  if (!question || options.length < 2 || options.length > 10) return null;
  return { when, question, options };
}

export type SetTimerCommand = { duration: string; label: string };
export function hasTimerIntent(text: string) { return /\b(?:timer|countdown)\b/i.test(text); }
export function parseSetTimerCommand(text: string): SetTimerCommand | null {
  const args = readAction(text, "set_timer", 2);
  if (!args || !args[0].trim() || !args[1].trim()) return null;
  return { duration: args[0].trim(), label: args[1].trim() };
}

export type ScheduleMessageCommand = { duration: string; message: string };
export function hasScheduleMessageIntent(text: string) {
  return /\b(?:message|announcement|post)\b/i.test(text)
    && /\b(?:schedule|scheduled|tomorrow|later|today|at|in)\b/i.test(text);
}
export function parseScheduleMessageCommand(text: string): ScheduleMessageCommand | null {
  const args = readAction(text, "schedule_message", 2);
  if (!args || !args[0].trim() || !args[1].trim()) return null;
  return { duration: args[0].trim(), message: args[1].trim() };
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
  const args = readAction(text, "sam_speak", 1);
  if (!args) return null;
  const spokenText = args[0].trim();
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
  const args = readAction(text, "show_avatar", 1);
  const raw = args?.[0].trim() || "";
  if (!args && !readNoArgAction(text, "show_avatar")) return null;
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
  const explicitImageRequest = /\b(?:generate|create|make|draw|paint|illustrate|render|design)\b[\s\S]{0,80}\b(?:images?|pictures?|illustrations?|artworks?|art|photos?|wallpapers?|logos?|posters?|graphics?)\b/i.test(text);
  const drawingRequest = /\b(?:draw|paint|illustrate)\b/i;
  return explicitImageRequest || drawingRequest.test(text);
}

/** Parses the AI action format used to request one generated image. */
export function parseGenerateImageCommand(text: string): GenerateImageCommand | null {
  const args = readAction(text, "generate_image", 1);
  if (!args) return null;
  const prompt = args[0].trim().replace(/\s+/g, " ");
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

// --- Rock, Paper, Scissors Action ---

export type RockPaperScissorsMove = "rock" | "paper" | "scissors";
export type RockPaperScissorsWinner = "player" | "bot" | "tie";

/** Detect requests to start a game, not questions about the game's rules. */
export function hasRockPaperScissorsIntent(text: string): boolean {
  if (/^\s*(?:how|what|when|where)\b/i.test(text)) return false;
  return /\b(?:play|start|challenge)\b[\s\S]{0,60}\b(?:rock[\s,/-]+paper[\s,/-]+scissors?|rps)\b/i.test(text);
}

/** Parses the AI action used to open a button-based game. */
export function parseRockPaperScissorsCommand(text: string): { action: "start" } | null {
  return readNoArgAction(text, "rock_paper_scissors") ? { action: "start" } : null;
}

export function getRockPaperScissorsWinner(
  playerMove: RockPaperScissorsMove,
  botMove: RockPaperScissorsMove,
): RockPaperScissorsWinner {
  if (playerMove === botMove) return "tie";
  if (
    (playerMove === "rock" && botMove === "scissors")
    || (playerMove === "paper" && botMove === "rock")
    || (playerMove === "scissors" && botMove === "paper")
  ) return "player";
  return "bot";
}

// --- Tic-Tac-Toe Action ---

export type TicTacToeMark = "X" | "O";
export type TicTacToeBoard = Array<TicTacToeMark | null>;
export type TicTacToeOutcome = TicTacToeMark | "tie" | null;

/** Detect game-start requests without treating rules questions as requests to play. */
export function hasTicTacToeIntent(text: string): boolean {
  if (/^\s*(?:how|what|when|where|why)\b/i.test(text)) return false;
  return /\b(?:play|start|challenge)\b[\s\S]{0,60}\b(?:tic[\s-]*tac[\s-]*toe|noughts?\s+and\s+crosses|ttt)\b/i.test(text);
}

/** Parses the AI action used to open a button-based game. */
export function parseTicTacToeCommand(text: string): { action: "start" } | null {
  return readNoArgAction(text, "tic_tac_toe") ? { action: "start" } : null;
}

const TIC_TAC_TOE_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function getTicTacToeWinner(board: TicTacToeBoard): TicTacToeOutcome {
  for (const [first, second, third] of TIC_TAC_TOE_LINES) {
    const mark = board[first];
    if (mark && mark === board[second] && mark === board[third]) return mark;
  }
  return board.length === 9 && board.every(cell => cell !== null) ? "tie" : null;
}

/** Prefer a winning move, then block X, then choose center/corners before edges. */
export function getTicTacToeBotMoves(board: TicTacToeBoard): number[] {
  const available = board.flatMap((cell, index) => cell === null ? [index] : []);
  const movesThatWin = available.filter(index => {
    const next = [...board];
    next[index] = "O";
    return getTicTacToeWinner(next) === "O";
  });
  if (movesThatWin.length) return movesThatWin;

  const movesThatBlock = available.filter(index => {
    const next = [...board];
    next[index] = "X";
    return getTicTacToeWinner(next) === "X";
  });
  if (movesThatBlock.length) return movesThatBlock;
  if (available.includes(4)) return [4];

  const corners = available.filter(index => [0, 2, 6, 8].includes(index));
  return corners.length ? corners : available;
}

// --- Channel Management Action ---

export type ChannelManagementCommand =
  | { action: "create_role"; name: string; color: string }
  | { action: "create_channel"; name: string; categoryId?: string }
  | { action: "create_category"; name: string }
  | { action: "create_layout"; groups: Array<{ categoryName?: string; channels: string[] }> }
  | { action: "delete_channel"; channelId: string }
  | { action: "delete_category"; categoryId: string };

export function hasChannelManagementIntent(text: string): boolean {
  return /\b(?:create|make|new|delete|remove)\b[\s\S]{0,100}\b(?:channel|category)\b/i.test(text);
}

/**
 * Parses AI channel management commands:
 *  - `use create_channel (name)`
 *  - `use create_channel (name) (categoryId)`
 *  - `use create_category (name)`
 *  - `use delete_channel (channelId)`
 *  - `use delete_category (categoryId)`
 */
export function parseChannelManagementCommand(text: string): ChannelManagementCommand | null {
  let match = /^\s*use\s+create_role\s*\(([\s\S]*?)\)\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const name = match[1]?.trim().replace(/\s+/gu, " ");
    const color = match[2]?.trim();
    if (!name || name.length > 100 || /[\r\n\u0000-\u001f]/u.test(name) || !color || !/^#?[\da-f]{6}$/i.test(color)) return null;
    return { action: "create_role", name, color: color.startsWith("#") ? color.toUpperCase() : `#${color.toUpperCase()}` };
  }

  const layoutArgs = readAction(text, "create_layout");
  if (layoutArgs) {
    if (layoutArgs.length < 2 || layoutArgs.length % 2 !== 0) return null;
    const groups: Array<{ categoryName?: string; channels: string[] }> = [];
    for (let index = 0; index < layoutArgs.length; index += 2) {
      const category = layoutArgs[index].trim();
      const uncategorized = /^none$/i.test(category);
      const categoryName = uncategorized ? undefined : category;
      const channels = layoutArgs[index + 1].split("|").map(name => name.trim()).filter(Boolean);
      if ((!uncategorized && !categoryName) || channels.length === 0) return null;
      groups.push({ categoryName, channels });
    }
    return { action: "create_layout", groups };
  }

  // Create channel: use create_channel (name) or use create_channel (name) (categoryId)
  match = /^\s*use\s+create_channel\s*\(([\s\S]*?)\)\s*(?:\(([\s\S]*?)\))?\s*$/i.exec(text);
  if (match) {
    const name = match[1]?.trim();
    const categoryId = match[2]?.trim();
    if (!name) return null;
    return { action: "create_channel", name, categoryId: categoryId || undefined };
  }

  // Create category: use create_category (name)
  match = /^\s*use\s+create_category\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const name = match[1]?.trim();
    if (!name) return null;
    return { action: "create_category", name };
  }

  // Delete channel: use delete_channel (channelId)
  match = /^\s*use\s+delete_channel\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const channelId = match[1].trim();
    if (!channelId) return null;
    return { action: "delete_channel", channelId };
  }

  // Delete category: use delete_category (categoryId)
  match = /^\s*use\s+delete_category\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const categoryId = match[1].trim();
    if (!categoryId) return null;
    return { action: "delete_category", categoryId };
  }

  return null;
}
