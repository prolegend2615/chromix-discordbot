import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ButtonInteraction, Message } from "discord.js";
import {
  handleTicTacToeButton,
  startTicTacToeGame,
} from "../src/services/tic-tac-toe.js";

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

test("Tic-Tac-Toe gives the starter X, Chromix O, and rejects other players", async () => {
  const messageId = "tic-tac-toe-owner-test-message";
  const placeholder = {
    id: messageId,
    edit: async (_payload: unknown) => undefined,
  } as unknown as Message;
  await startTicTacToeGame(placeholder, "game-owner");

  try {
    const outsider = makeButtonInteraction(messageId, "another-player", "ttt:move:0");
    await handleTicTacToeButton(outsider.interaction);
    assert.equal(outsider.updates.length, 0);
    assert.deepEqual(outsider.replies[0], {
      content: "Only the person who started this game can play.",
      ephemeral: true,
    });

    const ownerMove = makeButtonInteraction(messageId, "game-owner", "ttt:move:4");
    await handleTicTacToeButton(ownerMove.interaction);
    assert.equal(ownerMove.updates.length, 1);

    const payload = ownerMove.updates[0] as {
      components?: Array<{
        toJSON: () => {
          components: Array<{ custom_id?: string; label?: string; disabled?: boolean }>;
        };
      }>;
      embeds?: Array<{ toJSON: () => { description?: string } }>;
    };
    const rows = payload.components?.map(row => row.toJSON().components) ?? [];
    assert.deepEqual(rows.map(row => row.length), [3, 3, 3, 1]);

    const cells = rows.slice(0, 3).flat();
    assert.equal(cells[4]?.label, "X");
    assert.equal(cells[4]?.disabled, true);
    const botCells = cells.filter(cell => cell.label === "O");
    assert.equal(botCells.length, 1);
    assert.ok([0, 2, 6, 8].includes(Number(botCells[0]?.custom_id?.split(":")[2])));
    assert.equal(botCells[0]?.disabled, true);
    assert.equal(cells.filter(cell => cell.label !== "X" && cell.label !== "O").length, 7);
    assert.match(payload.embeds?.[0]?.toJSON().description ?? "", /Your turn/);

    const endGame = makeButtonInteraction(messageId, "game-owner", "ttt:end");
    await handleTicTacToeButton(endGame.interaction);
    const endedPayload = endGame.updates[0] as typeof payload;
    const finalRows = endedPayload.components?.map(row => row.toJSON().components) ?? [];
    assert.deepEqual(finalRows.map(row => row.length), [3, 3, 3]);
    const finalCells = finalRows.flat();
    assert.ok(finalCells.every(cell => cell.disabled === true));
    assert.ok(finalCells.some(cell => cell.label === "X"));
    assert.ok(finalCells.some(cell => cell.label === "O"));
  } finally {
    const cleanup = makeButtonInteraction(messageId, "game-owner", "ttt:end");
    await handleTicTacToeButton(cleanup.interaction).catch(() => undefined);
  }
});