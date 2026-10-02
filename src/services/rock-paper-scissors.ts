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
  getRockPaperScissorsWinner,
  type RockPaperScissorsMove,
  type RockPaperScissorsWinner,
} from "../logic.js";

const MOVES: readonly RockPaperScissorsMove[] = ["rock", "paper", "scissors"];
const MOVE_LABELS: Record<RockPaperScissorsMove, string> = {
  rock: "Rock",
  paper: "Paper",
  scissors: "Scissors",
};
const GAME_LIFETIME_MS = 15 * 60 * 1000;

type GameSession = {
  ownerId: string;
  playerWins: number;
  botWins: number;
  ties: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  processing: boolean;
};

const activeGames = new Map<string, GameSession>();

function gameButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rps:choice:rock").setLabel("Rock").setEmoji("🪨").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rps:choice:paper").setLabel("Paper").setEmoji("📄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rps:choice:scissors").setLabel("Scissors").setEmoji("✂️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rps:end").setLabel("End Game").setStyle(ButtonStyle.Danger),
  );
}

function gameEmbed(
  game: Pick<GameSession, "playerWins" | "botWins" | "ties">,
  description: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Rock, Paper, Scissors")
    .setColor(0x5865F2)
    .setDescription(description)
    .addFields({
      name: "Score",
      value: `You: **${game.playerWins}**  •  Chromix: **${game.botWins}**  •  Ties: **${game.ties}**`,
    });
}

function winnerText(winner: RockPaperScissorsWinner): string {
  if (winner === "player") return "You win this round!";
  if (winner === "bot") return "I win this round!";
  return "It's a tie!";
}

function clearGame(messageId: string, game: GameSession) {
  clearTimeout(game.expiryTimer);
  if (activeGames.get(messageId) === game) activeGames.delete(messageId);
}

export async function startRockPaperScissorsGame(message: Message, ownerId: string): Promise<void> {
  const game: GameSession = {
    ownerId,
    playerWins: 0,
    botWins: 0,
    ties: 0,
    expiresAt: Date.now() + GAME_LIFETIME_MS,
    expiryTimer: setTimeout(() => {
      const expiredGame = activeGames.get(message.id);
      if (!expiredGame) return;
      activeGames.delete(message.id);
      void message.edit({
        content: "",
        embeds: [gameEmbed(expiredGame, "This game expired. Ask me to start another one.")],
        components: [],
      }).catch(() => undefined);
    }, GAME_LIFETIME_MS),
    processing: false,
  };
  activeGames.set(message.id, game);

  try {
    await message.edit({
      content: "",
      embeds: [gameEmbed(game, "Choose Rock, Paper, or Scissors below to play a round. Keep playing until you press **End Game**. Only the person who started this game can make moves.")],
      components: [gameButtons()],
    });
  } catch (error) {
    clearGame(message.id, game);
    throw error;
  }
}

export async function handleRockPaperScissorsButton(interaction: ButtonInteraction): Promise<void> {
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

  if (interaction.customId === "rps:end") {
    game.processing = true;
    try {
      await interaction.update({
        content: "",
        embeds: [gameEmbed(game, `Game ended. Final score: **You ${game.playerWins} – ${game.botWins} Chromix**.`)],
        components: [],
      });
      clearGame(messageId, game);
    } finally {
      game.processing = false;
    }
    return;
  }

  const choice = /^rps:choice:(rock|paper|scissors)$/.exec(interaction.customId)?.[1] as RockPaperScissorsMove | undefined;
  if (!choice) {
    await interaction.reply({ content: "That game button is not valid.", ephemeral: true });
    return;
  }

  const botChoice = MOVES[randomInt(MOVES.length)];
  if (!botChoice) throw new Error("Could not choose a Rock, Paper, or Scissors move.");
  const winner = getRockPaperScissorsWinner(choice, botChoice);
  const nextGame: GameSession = {
    ...game,
    playerWins: game.playerWins + (winner === "player" ? 1 : 0),
    botWins: game.botWins + (winner === "bot" ? 1 : 0),
    ties: game.ties + (winner === "tie" ? 1 : 0),
  };
  const description = `You chose **${MOVE_LABELS[choice]}**. I chose **${MOVE_LABELS[botChoice]}**.\n\n**${winnerText(winner)}**`;

  game.processing = true;
  try {
    await interaction.update({
      content: "",
      embeds: [gameEmbed(nextGame, description)],
      components: [gameButtons()],
    });
    game.playerWins = nextGame.playerWins;
    game.botWins = nextGame.botWins;
    game.ties = nextGame.ties;
  } finally {
    game.processing = false;
  }
}