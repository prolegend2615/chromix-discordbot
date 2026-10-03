import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyProviderError, evaluateImageGenerationQuota, extractMentionId, formatReminderDuration, getRockPaperScissorsWinner, getTicTacToeBotMoves, getTicTacToeWinner, hasAvatarIntent, hasImageGenerationIntent, hasReminderIntent, hasRockPaperScissorsIntent, hasTicTacToeIntent, hasTimeWord, isModelAvailable, isTransientNetworkError, parseGenerateImageCommand, parsePrefixCommand, parseReminderDuration, parseRockPaperScissorsCommand, parseSetAfkCommand, parseSetReminderCommand, parseShowAvatarCommand, parseTicTacToeCommand, userFacingProviderError } from "../src/logic.js";

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

test("recognizes transient Discord connection failures", () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })), true);
  assert.equal(isTransientNetworkError(new Error("401 Unauthorized")), false);
});

test("detects reminder intent without forcing the action for every chat", () => {
  assert.equal(hasReminderIntent("remind me in 10 minutes"), true);
  assert.equal(hasReminderIntent("please notify me later"), true);
  assert.equal(hasReminderIntent("schedule a nudge for later"), true);
  assert.equal(hasReminderIntent("tell me a joke"), true);
  assert.equal(hasReminderIntent("what is the weather?"), false);
});

test("parses only the AI AFK action protocol", () => {
  assert.deepEqual(parseSetAfkCommand("use set_afk (dinner)"), { reason: "dinner" });
  assert.deepEqual(parseSetAfkCommand("USE SET_AFK (None)"), { reason: "None" });
  assert.deepEqual(parseSetAfkCommand("use set_afk ()"), { reason: "None" });
  assert.equal(parseSetAfkCommand("set my afk, reason: dinner"), null);
  assert.equal(parseSetAfkCommand("use set_afk (dinner) and then say okay"), null);
});

test("parses and limits the AI reminder action protocol", () => {
  assert.deepEqual(parseSetReminderCommand("use set_reminder (10m) (check the oven)"), {
    duration: "10m",
    message: "check the oven",
  });
  assert.deepEqual(parseSetReminderCommand("USE SET_REMINDER (2h) (call mom (important))"), {
    duration: "2h",
    message: "call mom (important)",
  });
  assert.deepEqual(parseSetReminderCommand("use set_reminder (13h) (too late)"), {
    duration: "13h",
    message: "too late",
  });
  assert.equal(parseSetReminderCommand("use set_reminder (10m)"), null);
  assert.equal(parseSetReminderCommand("use set_reminder (10m) (check) and then say okay"), null);
  assert.equal(parseReminderDuration("30s"), 30);
  assert.equal(parseReminderDuration("5m"), 300);
  assert.equal(parseReminderDuration("12h"), 43200);
  assert.equal(parseReminderDuration("13h"), null);
  assert.equal(parseReminderDuration("0m"), null);
  assert.equal(formatReminderDuration(7200), "2h");
});

test("recognizes avatar / profile picture intent", () => {
  assert.equal(hasAvatarIntent("show me my avatar"), true);
  assert.equal(hasAvatarIntent("show my pfp"), true);
  assert.equal(hasAvatarIntent("what is your profile picture"), true);
  assert.equal(hasAvatarIntent("tell me a joke"), false);
});

test("extracts user IDs from Discord mention tags", () => {
  assert.equal(extractMentionId("<@123456789012345678>"), "123456789012345678");
  assert.equal(extractMentionId("<@!987654321098765432>"), "987654321098765432");
  assert.equal(extractMentionId("no mention here"), null);
});

test("parses the AI avatar action protocol", () => {
  assert.deepEqual(parseShowAvatarCommand("use show_avatar (me)"), { target: "me" });
  assert.deepEqual(parseShowAvatarCommand("use show_avatar (self)"), { target: "self" });
  assert.deepEqual(parseShowAvatarCommand("use show_avatar (<@123456789012345678>)"), { target: "<@123456789012345678>" });
  assert.deepEqual(parseShowAvatarCommand("use show_avatar ()"), { target: "me" });
  assert.equal(parseShowAvatarCommand("show me my avatar please"), null);
  assert.equal(parseShowAvatarCommand("use show_avatar (me) and then say hi"), null);
});

test("recognizes image creation requests without treating avatar display as image generation", () => {
  assert.equal(hasImageGenerationIntent("create an image of a red fox"), true);
  assert.equal(hasImageGenerationIntent("create images for my server"), true);
  assert.equal(hasImageGenerationIntent("draw a tiny castle on a cloud"), true);
  assert.equal(hasImageGenerationIntent("make me a new avatar"), true);
  assert.equal(hasImageGenerationIntent("show me my avatar"), false);
  assert.equal(hasImageGenerationIntent("what is image generation?"), false);
});

test("parses only a complete image generation action", () => {
  assert.deepEqual(parseGenerateImageCommand("use generate_image (a fox in a blue forest)"), {
    prompt: "a fox in a blue forest",
  });
  assert.deepEqual(parseGenerateImageCommand("use generate_image (a tiny (storybook) fox)"), {
    prompt: "a tiny (storybook) fox",
  });
  assert.equal(parseGenerateImageCommand("use generate_image ()"), null);
  assert.equal(parseGenerateImageCommand("use generate_image (fox) then say hello"), null);
});

test("enforces per-server rolling and UTC-day image limits", () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  assert.deepEqual(evaluateImageGenerationQuota({
    requestsInWindow: 2,
    imagesToday: 49,
    oldestRequestAt: now - 60_000,
    now,
  }), { allowed: true });
  assert.deepEqual(evaluateImageGenerationQuota({
    requestsInWindow: 3,
    imagesToday: 3,
    oldestRequestAt: now - 60_000,
    now,
  }), { allowed: false, reason: "window", retryAt: now - 60_000 + 15 * 60 * 1000 + 1 });
  assert.deepEqual(evaluateImageGenerationQuota({
    requestsInWindow: 0,
    imagesToday: 50,
    oldestRequestAt: null,
    now,
  }), { allowed: false, reason: "daily", retryAt: Date.UTC(2026, 9, 3) });
});

test("classifies provider failures", () => {
  assert.equal(classifyProviderError(new Error("HTTP 429 rate limit")), "rate_limit");
  assert.equal(classifyProviderError(new Error("request timed out")), "timeout");
  assert.match(userFacingProviderError(new Error("503 unavailable")), /temporarily unavailable/);
});

test("detects start-game requests without mistaking rules questions for requests", () => {
  assert.equal(hasRockPaperScissorsIntent("let play rock paper scissors"), true);
  assert.equal(hasRockPaperScissorsIntent("Can we play Rock, Paper, Scissors?"), true);
  assert.equal(hasRockPaperScissorsIntent("Start a game of RPS"), true);
  assert.equal(hasRockPaperScissorsIntent("How do you play rock paper scissors?"), false);
  assert.equal(hasRockPaperScissorsIntent("What are the rules of rock paper scissors?"), false);
});

test("parses only the exact Rock, Paper, Scissors game action", () => {
  assert.deepEqual(parseRockPaperScissorsCommand("use rock_paper_scissors"), { action: "start" });
  assert.deepEqual(parseRockPaperScissorsCommand(" USE ROCK_PAPER_SCISSORS "), { action: "start" });
  assert.equal(parseRockPaperScissorsCommand("use rock_paper_scissors then say hello"), null);
});

test("resolves all Rock, Paper, Scissors round outcomes", () => {
  assert.equal(getRockPaperScissorsWinner("rock", "scissors"), "player");
  assert.equal(getRockPaperScissorsWinner("paper", "rock"), "player");
  assert.equal(getRockPaperScissorsWinner("scissors", "paper"), "player");
  assert.equal(getRockPaperScissorsWinner("scissors", "rock"), "bot");
  assert.equal(getRockPaperScissorsWinner("rock", "paper"), "bot");
  assert.equal(getRockPaperScissorsWinner("paper", "scissors"), "bot");
  assert.equal(getRockPaperScissorsWinner("rock", "rock"), "tie");
});

test("detects Tic-Tac-Toe game requests without mistaking rules questions for requests", () => {
  assert.equal(hasTicTacToeIntent("Can we play tic tac toe?"), true);
  assert.equal(hasTicTacToeIntent("Start tic-tac-toe"), true);
  assert.equal(hasTicTacToeIntent("Let's play TTT"), true);
  assert.equal(hasTicTacToeIntent("How do you play tic tac toe?"), false);
  assert.equal(hasTicTacToeIntent("What are the rules of noughts and crosses?"), false);
});

test("parses only the exact Tic-Tac-Toe game action", () => {
  assert.deepEqual(parseTicTacToeCommand("use tic_tac_toe"), { action: "start" });
  assert.deepEqual(parseTicTacToeCommand(" USE TIC_TAC_TOE "), { action: "start" });
  assert.equal(parseTicTacToeCommand("use tic_tac_toe then say hello"), null);
});

test("detects Tic-Tac-Toe wins and ties", () => {
  assert.equal(getTicTacToeWinner(["X", "X", "X", "O", "O", null, null, null, null]), "X");
  assert.equal(getTicTacToeWinner(["X", "X", "O", "X", "O", null, "O", null, null]), "O");
  assert.equal(getTicTacToeWinner(["X", "O", "X", "X", "O", "O", "O", "X", "X"]), "tie");
  assert.equal(getTicTacToeWinner(["X", null, "O", null, "X", null, null, "O", null]), null);
});

test("Chromix takes a win, blocks an immediate player win, and prefers center", () => {
  assert.deepEqual(getTicTacToeBotMoves(["O", "O", null, "X", "X", null, null, null, null]), [2]);
  assert.deepEqual(getTicTacToeBotMoves(["X", "X", null, "O", null, null, null, null, null]), [2]);
  assert.deepEqual(getTicTacToeBotMoves(["X", null, null, null, null, null, null, null, null]), [4]);
});
