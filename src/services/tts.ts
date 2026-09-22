import SamJs from "sam-js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { TextBasedChannel, GuildMember } from "discord.js";

const sam = new SamJs({ pitch: 64, speed: 72 });

/** Maximum characters allowed in a single TTS request to keep clips short. */
const MAX_TTS_CHARS = 200;

/**
 * Truncate text to at most ~3 sentences or MAX_TTS_CHARS, whichever is shorter.
 * Discord users dislike long robotic voice messages, so we enforce brevity.
 */
export function truncateTtsText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TTS_CHARS) return trimmed || "Hello.";

  // Try to cut at sentence boundaries (period, exclamation, question mark followed by space or end)
  const sentenceEnds = [...trimmed.matchAll(/[.!?](?:\s|$)/g)];
  if (sentenceEnds.length >= 3) {
    const thirdEnd = sentenceEnds[2];
    const cutAt = thirdEnd.index! + thirdEnd[0].length;
    if (cutAt <= MAX_TTS_CHARS) {
      return trimmed.slice(0, cutAt).trim();
    }
  }

  // Fallback: hard truncate at MAX_TTS_CHARS on a word boundary
  const slice = trimmed.slice(0, MAX_TTS_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + ".";
}

/**
 * Generate a SAM robotic-voice WAV buffer from text.
 */
export function generateSamWav(text: string): Buffer {
  const truncated = truncateTtsText(text);
  const wavBytes = sam.wav(truncated);
  if (!wavBytes || !(wavBytes instanceof Uint8Array)) {
    throw new Error("SAM failed to generate audio for the given text.");
  }
  return Buffer.from(wavBytes);
}

/**
 * Play SAM-generated TTS audio in the voice channel the member is currently in.
 * Returns true if playback completed successfully, false otherwise.
 */
export async function playTtsInVoiceChannel(args: {
  member: GuildMember | null;
  guildId: string;
  channelId: string;
  text: string;
}): Promise<boolean> {
  const { member, guildId, channelId, text } = args;

  if (!member?.voice?.channel) {
    return false;
  }

  const voiceChannel = member.voice.channel;
  const wavBuffer = generateSamWav(text);

  let connection: VoiceConnection | undefined;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer();
    const stream = Readable.from(wavBuffer);
    const resource = createAudioResource(stream, { inlineVolume: false });

    connection.subscribe(player);
    player.play(resource);

    // Wait for playback to finish or error
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("TTS playback timed out after 30 seconds."));
      }, 30_000);

      player.on(AudioPlayerStatus.Idle, () => {
        clearTimeout(timeout);
        resolve();
      });

      player.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return true;
  } catch (error) {
    console.error("[TTS] Playback failed:", error);
    return false;
  } finally {
    if (connection) {
      try { connection.destroy(); } catch {}
    }
  }
}
