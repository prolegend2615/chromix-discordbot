import SamJs from "sam-js";
import type { TextBasedChannel } from "discord.js";

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
 * Send a SAM-generated voice message as an audio file attachment in the text channel.
 * Discord renders .wav/.ogg attachments as playable inline audio bubbles.
 * Returns true if sent successfully, false otherwise.
 */
export async function sendVoiceMessage(args: {
  channel: TextBasedChannel;
  text: string;
}): Promise<boolean> {
  const { channel, text } = args;

  if (!("send" in channel) || typeof channel.send !== "function") {
    return false;
  }

  try {
    const wavBuffer = generateSamWav(text);

    await (channel.send as (payload: unknown) => Promise<unknown>)({
      files: [{
        attachment: wavBuffer,
        name: "voice-message.wav",
      }],
    });

    return true;
  } catch (error) {
    console.error("[TTS] Failed to send voice message:", error);
    return false;
  }
}
