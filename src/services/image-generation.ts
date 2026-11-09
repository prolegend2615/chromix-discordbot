import { config } from "../config.js";
import {
  evaluateImageGenerationQuota,
  IMAGE_GENERATION_WINDOW_MS,
} from "../logic.js";
import { dbPromise } from "../database.js";

const POLLINATIONS_IMAGE_URL = "https://gen.pollinations.ai/image/";
const POLLINATIONS_IMAGE_MODEL = "flux";
const XKIRO_IMAGE_URL = "https://api.xkiro.com/v1/images/generations";
const XKIRO_IMAGE_MODEL = "sensenova/sensenova-u1.5-lite";
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
        "SELECT COUNT(*) AS count FROM image_generation_events WHERE guild_id = ? AND created_at >= ? AND (status = 'succeeded' OR (status = 'reserved' AND created_at >= ?))",
        guildId,
        now - IMAGE_GENERATION_WINDOW_MS,
        now - IMAGE_REQUEST_TIMEOUT_MS * 2 - 30_000,
      );
      const today = await db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM image_generation_events WHERE guild_id = ? AND created_at >= ? AND (status = 'succeeded' OR (status = 'reserved' AND created_at >= ?))",
        guildId,
        dayStart,
        now - IMAGE_REQUEST_TIMEOUT_MS * 2 - 30_000,
      );
      const oldest = await db.get<{ created_at: number | null }>(
        "SELECT MIN(created_at) AS created_at FROM image_generation_events WHERE guild_id = ? AND created_at >= ? AND (status = 'succeeded' OR (status = 'reserved' AND created_at >= ?))",
        guildId,
        now - IMAGE_GENERATION_WINDOW_MS,
        now - IMAGE_REQUEST_TIMEOUT_MS * 2 - 30_000,
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
    default: throw new Error("The image provider returned an unsupported image format.");
  }
}

type GeneratedImage = { buffer: Buffer; extension: string };

async function generatePollinationsImage(prompt: string): Promise<GeneratedImage> {
  if (!config.pollinationsApiKey) throw new Error("Pollinations is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(encodeURIComponent(prompt), POLLINATIONS_IMAGE_URL);
    url.searchParams.set("model", POLLINATIONS_IMAGE_MODEL);
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.pollinationsApiKey}`, Accept: "image/*" },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[Image] Pollinations returned HTTP ${response.status}.`);
      if (response.status === 401 || response.status === 403) throw new Error("Pollinations rejected its API key.");
      if (response.status === 429) throw new Error("Pollinations is rate-limiting image requests.");
      throw new Error("Pollinations could not generate that image.");
    }
    const extension = getImageExtension(response.headers.get("content-type"));
    const image = Buffer.from(await response.arrayBuffer());
    if (!image.length) throw new Error("Pollinations returned an empty image.");
    if (image.length > MAX_IMAGE_BYTES) throw new Error("The generated image is too large to send in Discord.");
    return { buffer: image, extension };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Pollinations image generation timed out.");
    if (error instanceof Error && /fetch failed|network|econnreset|enotfound/i.test(error.message)) throw new Error("Could not reach Pollinations.");
    throw error instanceof Error ? error : new Error("Pollinations image generation failed.");
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadXkiroImage(url: string, signal: AbortSignal): Promise<GeneratedImage> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
    throw new Error("Xkiro returned an invalid image URL.");
  }
  const response = await fetch(parsedUrl, { headers: { Accept: "image/*" }, signal });
  if (!response.ok) throw new Error(`Xkiro image download failed with HTTP ${response.status}.`);
  const extension = getImageExtension(response.headers.get("content-type"));
  const image = Buffer.from(await response.arrayBuffer());
  if (!image.length) throw new Error("Xkiro returned an empty image.");
  if (image.length > MAX_IMAGE_BYTES) throw new Error("The generated image is too large to send in Discord.");
  return { buffer: image, extension };
}

async function generateXkiroImage(prompt: string): Promise<GeneratedImage> {
  if (!config.xkiroApiKey) throw new Error("Xkiro is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
  try {
    const createResponse = await fetch(XKIRO_IMAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.xkiroApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: XKIRO_IMAGE_MODEL, prompt, size: "1024x1024" }),
      signal: controller.signal,
    });
    if (!createResponse.ok) throw new Error(`Xkiro image job creation failed with HTTP ${createResponse.status}.`);
    const created = await createResponse.json() as { id?: unknown; job_id?: unknown; data?: { id?: unknown } };
    const jobId = [created.id, created.job_id, created.data?.id].find(value => typeof value === "string" && value.trim());
    if (typeof jobId !== "string") throw new Error("Xkiro did not return an image job ID.");

    const deadline = Date.now() + IMAGE_REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pollResponse = await fetch(`${XKIRO_IMAGE_URL}/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${config.xkiroApiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!pollResponse.ok) throw new Error(`Xkiro image job polling failed with HTTP ${pollResponse.status}.`);
      const job = await pollResponse.json() as {
        status?: unknown; url?: unknown; data?: Array<{ url?: unknown }>;
      };
      const status = typeof job.status === "string" ? job.status.toLowerCase() : "";
      if (["failed", "cancelled", "canceled"].includes(status)) throw new Error("Xkiro could not generate the image.");
      const imageUrl = job.data?.[0]?.url ?? job.url;
      if (status === "succeeded" || (typeof imageUrl === "string" && imageUrl.length > 0)) {
        if (typeof imageUrl !== "string") throw new Error("Xkiro finished without returning an image URL.");
        return await downloadXkiroImage(imageUrl, controller.signal);
      }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    throw new Error("Xkiro image generation timed out.");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Xkiro image generation timed out.");
    throw error instanceof Error ? error : new Error("Xkiro image generation failed.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateGuildImage(
  guildId: string,
  prompt: string,
  provider: "pollinations" | "xkiro" = "pollinations",
): Promise<GeneratedImage> {
  const cleanedPrompt = prompt.trim().replace(/\s+/g, " ").slice(0, 1200);
  if (!cleanedPrompt) throw new Error("Please provide a description for the image.");
  if (!config.pollinationsApiKey && !config.xkiroApiKey) {
    throw new Error("Image generation is not configured. Add POLLINATIONS_API_KEY or XKIRO_API_KEY to the bot environment.");
  }
  const reservation = await reserveImageGeneration(guildId);
  if (!reservation.allowed) throw new Error(formatQuotaMessage(reservation.reason, reservation.retryAt));

  const selectedProvider = provider === "xkiro" ? "xkiro" : "pollinations";
  const fallbackProvider = selectedProvider === "xkiro" ? "pollinations" : "xkiro";
  try {
    let result: GeneratedImage;
    try {
      result = selectedProvider === "xkiro"
        ? await generateXkiroImage(cleanedPrompt)
        : await generatePollinationsImage(cleanedPrompt);
    } catch (primaryError) {
      const fallbackAvailable = fallbackProvider === "xkiro" ? Boolean(config.xkiroApiKey) : Boolean(config.pollinationsApiKey);
      if (!fallbackAvailable) throw primaryError;
      console.warn(`[Image] ${selectedProvider} failed; trying ${fallbackProvider}.`, primaryError instanceof Error ? primaryError.message : primaryError);
      result = fallbackProvider === "xkiro"
        ? await generateXkiroImage(cleanedPrompt)
        : await generatePollinationsImage(cleanedPrompt);
    }
    await setGenerationStatus(reservation.eventId, "succeeded");
    return result;
  } catch (error) {
    await setGenerationStatus(reservation.eventId, "failed").catch(() => undefined);
    throw error instanceof Error ? error : new Error("Image generation failed. Please try again.");
  }
}
