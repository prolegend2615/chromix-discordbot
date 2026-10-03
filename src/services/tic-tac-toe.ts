import { randomInt } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import {
  getTicTacToeBotMoves,
  getTicTacToeWinner,
  type TicTacToeBoard,
  type TicTacToeOutcome,
} from "../logic.js";

const GAME_LIFETIME_MS = 15 * 60 * 1000;
const BLANK_CELL_LABEL = "\u2800";

type GameSession = {
  ownerId: string;
  board: TicTacToeBoard;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  processing: boolean;
};

const activeGames = new Map<string, GameSession>();

function gameEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Tic-Tac-Toe")
    .setColor(0x5865F2)
    .setDescription(description);
}

function gameComponents(board: TicTacToeBoard, finished = false): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
      const index = rowIndex * 3 + columnIndex;
      const mark = board[index];
      const button = new ButtonBuilder()
        .setCustomId(`ttt:move:${index}`)
        .setLabel(mark ?? BLANK_CELL_LABEL)
        .setStyle(mark === "X" ? ButtonStyle.Primary : mark === "O" ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(finished || mark !== null);
      row.addComponents(button);
    }
    rows.push(row);
  }
  if (!finished) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ttt:end").setLabel("End Game").setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}

function clearGame(messageId: string, game: GameSession): void {
  clearTimeout(game.expiryTimer);
  if (activeGames.get(messageId) === game) activeGames.delete(messageId);
}

function outcomeDescription(outcome: TicTacToeOutcome): string {
  if (outcome === "X") return "You win! Three Xs in a row.";
  if (outcome === "O") return "Chromix wins! Three Os in a row.";
  if (outcome === "tie") return "It's a tie. The board is full.";
  return "Your turn (**X**). Choose an empty square.";
}

export async function startTicTacToeGame(message: Message, ownerId: string): Promise<void> {
  const game: GameSession = {
    ownerId,
    board: Array<TicTacToeBoard[number]>(9).fill(null),
    expiresAt: Date.now() + GAME_LIFETIME_MS,
    expiryTimer: setTimeout(() => {
      const expiredGame = activeGames.get(message.id);
      if (!expiredGame) return;
      activeGames.delete(message.id);
      void message.edit({
        content: "",
        embeds: [gameEmbed("This game expired. Ask me to start another one.")],
        components: gameComponents(expiredGame.board, true),
      }).catch(() => undefined);
    }, GAME_LIFETIME_MS),
    processing: false,
  };
  activeGames.set(message.id, game);

  try {
    await message.edit({
      content: "",
      embeds: [gameEmbed("You are **X** and Chromix is **O**. You go first—choose a square. Only you can play this game.")],
      components: gameComponents(game.board),
    });
  } catch (error) {
    clearGame(message.id, game);
    throw error;
  }
}

export async function handleTicTacToeButton(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const game = activeGames.get(messageId);
  if (!game || game.expiresAt <= Date.now()) {
    if (game) clearGame(messageId, game);
    await interaction.reply({ content: "This game has expired. Ask me to start another one.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== game.ownerId) {
    await interaction.reply({ content: "Only the person who started this game can play.", ephemeral: true });
    return;
  }
  if (game.processing) {
    await interaction.reply({ content: "Your previous move is still processing. Try again in a moment.", ephemeral: true });
    return;
  }

  if (interaction.customId === "ttt:end") {
    game.processing = true;
    try {
      await interaction.update({
        content: "",
        embeds: [gameEmbed("Game ended. Ask me to start another round whenever you are ready.")],
        components: gameComponents(game.board, true),
      });
      clearGame(messageId, game);
    } finally {
      game.processing = false;
    }
    return;
  }

  const moveIndex = /^ttt:move:([0-8])$/.exec(interaction.customId)?.[1];
  if (moveIndex === undefined) {
    await interaction.reply({ content: "That game button is not valid.", ephemeral: true });
    return;
  }
  const playerMove = Number(moveIndex);
  if (game.board[playerMove] !== null) {
    await interaction.reply({ content: "That square is already taken. Choose an empty square.", ephemeral: true });
    return;
  }

  const nextBoard: TicTacToeBoard = [...game.board];
  nextBoard[playerMove] = "X";
  let outcome = getTicTacToeWinner(nextBoard);
  let botMove: number | null = null;
  if (outcome === null) {
    const possibleMoves = getTicTacToeBotMoves(nextBoard);
    if (possibleMoves.length > 0) {
      botMove = possibleMoves[randomInt(possibleMoves.length)] ?? null;
      if (botMove === null) throw new Error("Could not choose a Tic-Tac-Toe square.");
      nextBoard[botMove] = "O";
      outcome = getTicTacToeWinner(nextBoard);
    } else {
      outcome = "tie";
    }
  }

  const moveSummary = botMove === null
    ? `You placed **X** in square **${playerMove + 1}**.`
    : `You placed **X** in square **${playerMove + 1}**. Chromix placed **O** in square **${botMove + 1}**.`;
  const description = `${moveSummary}\n\n${outcomeDescription(outcome)}`;
  const finished = outcome !== null;

  game.processing = true;
  try {
    await interaction.update({
      content: "",
      embeds: [gameEmbed(description)],
      components: gameComponents(nextBoard, finished),
    });
    game.board = nextBoard;
    if (finished) clearGame(messageId, game);
  } finally {
    game.processing = false;
  }
}