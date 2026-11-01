import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ButtonInteraction, Message } from "discord.js";
import {
  handleRockPaperScissorsButton,
  startRockPaperScissorsGame,
} from "../src/services/rock-paper-scissors.js";

function makeButtonInteraction(messageId: string, userId: string, customId: string) {
  const replies: unknown[] = [];
  const updates: unknown[] = [];
  const interaction = {
    customId,
    message: { id: messageId },
    user: { id: userId },
    reply: async (payload: unknown) => { replies.push(payload); },
    update: async (payload: unknown) => { updates.push(payload); },
  } as unknown as ButtonInteraction;
  return { interaction, replies, updates };
}

test("only the player who started a game can change or end it", async () => {
  const messageId = "rps-owner-test-message";
  const placeholder = {
    id: messageId,
    edit: async (_payload: unknown) => undefined,
  } as unknown as Message;
  await startRockPaperScissorsGame(placeholder, "game-owner");

  try {
    const outsider = makeButtonInteraction(messageId, "another-player", "rps:choice:rock");
    await handleRockPaperScissorsButton(outsider.interaction);

    assert.equal(outsider.updates.length, 0);
    assert.deepEqual(outsider.replies[0], {
      content: "Only the person who started this game can play.",
      ephemeral: true,
    });

    const ownerEnd = makeButtonInteraction(messageId, "game-owner", "rps:end");
    await handleRockPaperScissorsButton(ownerEnd.interaction);
    assert.equal(ownerEnd.updates.length, 1);

    const endPayload = ownerEnd.updates[0] as {
      components?: unknown[];
      embeds?: Array<{ toJSON: () => { description?: string } }>;
    };
    assert.deepEqual(endPayload.components, []);
    assert.match(endPayload.embeds?.[0]?.toJSON().description ?? "", /You 0 – 0 Chromix/);
  } finally {
    const cleanup = makeButtonInteraction(messageId, "game-owner", "rps:end");
    await handleRockPaperScissorsButton(cleanup.interaction).catch(() => undefined);
  }
});