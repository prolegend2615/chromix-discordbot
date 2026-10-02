import { config } from "../config.js";
import {
  evaluateImageGenerationQuota,
  IMAGE_GENERATION_WINDOW_MS,
} from "../logic.js";
import { dbPromise } from "../database.js";

const POLLINATIONS_IMAGE_URL = "https://gen.pollinations.ai/image/";
const POLLINATIONS_IMAGE_MODEL = "flux";
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type ImageGenerationReservation =
  | { allowed: true; eventId: number }
  | { allowed: false; reason: "window" | "daily"; retryAt: number };

let reservationQueue: Promise<unknown> = Promise.resolve();

function withReservationLock<T>(work: () => Promise<T>): Promise<T> {
  const next = reservationQueue.then(work, work);
  reservationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function getUtcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function reserveImageGeneration(guildId: string, now = Date.now()): Promise<ImageGenerationReservation> {
  return withReservationLock(async () => {
    const db = await dbPromise;
    const dayStart = getUtcDayStart(now);
    const cleanupBefore = Math.min(dayStart, now - IMAGE_GENERATION_WINDOW_MS);

    await db.exec("BEGIN IMMEDIATE");
    try {
      await db.run("DELETE FROM image_generation_events WHERE created_at < ?", cleanupBefore);

      const recent = await db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM image_generation_events WHERE guild_id = ? AND created_at >= ?",
        guildId,
        now - IMAGE_GENERATION_WINDOW_MS,
      );
      const today = await db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM image_generation_events WHERE guild_id = ? AND created_at >= ? AND (status = 'succeeded' OR (status = 'reserved' AND created_at >= ?))",
        guildId,
        dayStart,
        now - IMAGE_REQUEST_TIMEOUT_MS - 30_000,
      );
      const oldest = await db.get<{ created_at: number | null }>(
        "SELECT MIN(created_at) AS created_at FROM image_generation_events WHERE guild_id = ? AND created_at >= ?",
        guildId,
        now - IMAGE_GENERATION_WINDOW_MS,
      );

      const decision = evaluateImageGenerationQuota({
        requestsInWindow: recent?.count ?? 0,
        imagesToday: today?.count ?? 0,
        oldestRequestAt: oldest?.created_at ?? null,
        now,
      });
      if (!decision.allowed) {
        await db.exec("ROLLBACK");
        return decision;
      }

      const inserted = await db.run(
        "INSERT INTO image_generation_events (guild_id, created_at, status) VALUES (?, ?, 'reserved')",
        guildId,
        now,
      );
      const eventId = inserted.lastID;
      if (typeof eventId !== "number") throw new Error("Image generation quota reservation failed.");
      await db.exec("COMMIT");
      return { allowed: true, eventId };
    } catch (error) {
      await db.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function setGenerationStatus(eventId: number, status: "succeeded" | "failed"): Promise<void> {
  const db = await dbPromise;
  await db.run("UPDATE image_generation_events SET status = ? WHERE id = ?", status, eventId);
}

function formatQuotaMessage(reason: "window" | "daily", retryAt: number): string {
  if (reason === "daily") {
    return "This server has reached its limit of 50 generated images for today. The limit resets at 00:00 UTC.";
  }
  const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
  return `This server has reached its limit of 3 image generations in 15 minutes. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function getImageExtension(contentType: string | null): string {
  switch (contentType?.split(";")[0].trim().toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg":
    case "image/jpg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: throw new Error("Pollinations returned an unsupported image format.");
  }
}

export async function generateGuildImage(guildId: string, prompt: string): Promise<{ buffer: Buffer; extension: string }> {
  if (!config.pollinationsApiKey) {
    throw new Error("Image generation is not configured. Add POLLINATIONS_API_KEY to the bot's secret environment variables.");
  }

  const cleanedPrompt = prompt.trim().replace(/\s+/g, " ").slice(0, 1200);
  if (!cleanedPrompt) throw new Error("Please provide a description for the image.");

  const reservation = await reserveImageGeneration(guildId);
  if (!reservation.allowed) throw new Error(formatQuotaMessage(reservation.reason, reservation.retryAt));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(encodeURIComponent(cleanedPrompt), POLLINATIONS_IMAGE_URL);
    url.searchParams.set("model", POLLINATIONS_IMAGE_MODEL);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.pollinationsApiKey}`,
        Accept: "image/*",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[Image] Pollinations returned HTTP ${response.status}.`);
      if (response.status === 401 || response.status === 403) {
        throw new Error("Pollinations rejected the API key. Check POLLINATIONS_API_KEY in the bot's secret environment variables.");
      }
      if (response.status === 429) {
        throw new Error("Pollinations is rate-limiting image requests. Please try again later.");
      }
      throw new Error("Pollinations could not generate that image. Please revise the prompt and try again.");
    }

    const extension = getImageExtension(response.headers.get("content-type"));
    const image = Buffer.from(await response.arrayBuffer());
    if (image.length === 0) throw new Error("Pollinations returned an empty image.");
    if (image.length > MAX_IMAGE_BYTES) throw new Error("The generated image is too large to send in Discord.");

    await setGenerationStatus(reservation.eventId, "succeeded");
    return { buffer: image, extension };
  } catch (error) {
    await setGenerationStatus(reservation.eventId, "failed").catch(() => undefined);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Image generation timed out. Please try again.");
    }
    if (error instanceof Error && /fetch failed|network|econnreset|enotfound/i.test(error.message)) {
      throw new Error("Could not reach Pollinations. Please try again shortly.");
    }
    throw error instanceof Error
      ? error
      : new Error("Image generation failed. Please try again.");
  } finally {
    clearTimeout(timeout);
  }
}