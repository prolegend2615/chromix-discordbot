import SamJs from "sam-js";
import type { TextBasedChannel } from "discord.js";
import { config } from "../config.js";

const sam = new SamJs({ pitch: 64, speed: 72 });
const MAX_TTS_CHARS = 200;
const OPENROUTER_TTS_URL = "https://openrouter.ai/api/v1/audio/speech";
const OPENROUTER_TTS_MODEL = "deepgram/flux-tts:free";
const OPENROUTER_TTS_TIMEOUT_MS = 30_000;

export function normalizeTtsText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code omitted ")
    .replace(/https?:\/\/\S+/gi, " link ")
    .replace(/<@!?\d+>/g, " user ")
    .replace(/[*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateTtsText(text: string): string {
  const trimmed = normalizeTtsText(text);
  if (trimmed.length <= MAX_TTS_CHARS) return trimmed || "Hello.";
  const sentenceEnds = [...trimmed.matchAll(/[.!?](?:\s|$)/g)];
  if (sentenceEnds.length >= 3) {
    const thirdEnd = sentenceEnds[2];
    const cutAt = thirdEnd.index! + thirdEnd[0].length;
    if (cutAt <= MAX_TTS_CHARS) return trimmed.slice(0, cutAt).trim();
  }
  const slice = trimmed.slice(0, MAX_TTS_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + ".";
}

export function generateSamWav(text: string): Buffer {
  const wavBytes = sam.wav(truncateTtsText(text));
  if (!wavBytes || !(wavBytes instanceof Uint8Array)) throw new Error("SAM failed to generate audio for the given text.");
  return Buffer.from(wavBytes);
}

async function generateFluxMp3(text: string): Promise<Buffer> {
  if (!config.openrouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TTS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.openrouterApiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/prolegend2615/chromix-discordbot",
        "X-Title": "Chromix Discord Bot",
      },
      body: JSON.stringify({
        model: OPENROUTER_TTS_MODEL,
        input: truncateTtsText(text),
        voice: config.openrouterTtsVoice,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error("OpenRouter Flux TTS failed (" + response.status + "): " + details.slice(0, 300));
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new Error("OpenRouter Flux TTS returned empty audio.");
    return audio;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendAudioAttachment(channel: TextBasedChannel, audio: Buffer, name: string): Promise<boolean> {
  if (!("send" in channel) || typeof channel.send !== "function") return false;
  await (channel.send as (payload: unknown) => Promise<unknown>)({ files: [{ attachment: audio, name }] });
  return true;
}

export async function sendVoiceMessage(args: { channel: TextBasedChannel; text: string }): Promise<boolean> {
  try {
    const fluxAudio = await generateFluxMp3(args.text);
    if (await sendAudioAttachment(args.channel, fluxAudio, "voice-message.mp3")) return true;
    throw new Error("The channel cannot send audio attachments.");
  } catch (error) {
    console.error("[TTS] Flux failed; using SAM fallback.", error);
  }
  try {
    const samAudio = generateSamWav(args.text);
    return await sendAudioAttachment(args.channel, samAudio, "voice-message.wav");
  } catch (error) {
    console.error("[TTS] SAM fallback failed.", error);
    return false;
  }
}

type VoiceQueueEntry = {
  channel: TextBasedChannel;
  text: string | undefined;
  cancelled: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  resolveResult: (sent: boolean) => void;
};

export type VoiceReservation = {
  position: number;
  complete: (text: string) => Promise<boolean>;
  cancel: () => void;
};

const voiceQueues = new Map<string, VoiceQueueEntry[]>();
const activeVoiceQueues = new Set<string>();

async function drainVoiceQueue(channelId: string): Promise<void> {
  if (activeVoiceQueues.has(channelId)) return;
  activeVoiceQueues.add(channelId);
  try {
    const queue = voiceQueues.get(channelId);
    if (!queue) return;
    while (queue.length > 0) {
      const entry = queue.shift()!;
      await entry.ready;
      let sent = false;
      if (!entry.cancelled && entry.text) {
        try {
          sent = await sendVoiceMessage({ channel: entry.channel, text: entry.text });
        } catch (error) {
          console.error("[TTS] Unexpected queued voice error.", error);
        }
      }
      entry.resolveResult(sent);
    }
  } finally {
    activeVoiceQueues.delete(channelId);
    const remaining = voiceQueues.get(channelId);
    if (!remaining || remaining.length === 0) voiceQueues.delete(channelId);
    else void drainVoiceQueue(channelId);
  }
}

export function reserveVoiceMessage(args: { channel: TextBasedChannel; channelId: string }): VoiceReservation {
  let resolveResult!: (sent: boolean) => void;
  let resolveReady!: () => void;
  let decisionMade = false;
  const result = new Promise<boolean>(resolve => { resolveResult = resolve; });
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const queue = voiceQueues.get(args.channelId) ?? [];
  const position = queue.length + (activeVoiceQueues.has(args.channelId) ? 1 : 0) + 1;
  const entry: VoiceQueueEntry = {
    channel: args.channel,
    text: undefined,
    cancelled: false,
    ready,
    resolveReady,
    resolveResult,
  };
  queue.push(entry);
  voiceQueues.set(args.channelId, queue);
  void drainVoiceQueue(args.channelId);
  return {
    position,
    complete(text: string) {
      if (!decisionMade) {
        decisionMade = true;
        entry.text = text;
        entry.resolveReady();
      }
      return result;
    },
    cancel() {
      if (decisionMade) return;
      decisionMade = true;
      entry.cancelled = true;
      entry.resolveReady();
    },
  };
}