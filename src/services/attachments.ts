export type DiscordAttachmentInput = {
  name: string;
  url: string;
  contentType: string | null;
  size: number;
};

export type PreparedAttachment =
  | { kind: "image" | "pdf"; name: string; mimeType: string; data: Buffer }
  | { kind: "text"; name: string; mimeType: string; text: string };

export type AttachmentDescriptor = DiscordAttachmentInput & {
  name: string;
  kind: PreparedAttachment["kind"];
  mimeType: string;
};

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_PER_FILE = 40_000;
const MAX_TEXT_TOTAL = 80_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv",
  json: "application/json", xml: "text/xml", html: "text/html", htm: "text/html",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", ts: "text/x-typescript",
  py: "text/x-python", java: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain",
  rs: "text/plain", go: "text/plain", sh: "text/plain", yaml: "text/plain", yml: "text/plain",
  log: "text/plain", sql: "text/plain", toml: "text/plain", rtf: "text/rtf",
};

function cleanName(value: string) {
  const basename = value.split(/[\\/]/u).pop() ?? "attachment";
  return basename.replace(/[\r\n\u0000-\u001f<>]/gu, "_").slice(0, 120) || "attachment";
}

function classify(input: DiscordAttachmentInput): AttachmentDescriptor {
  const name = cleanName(input.name);
  const extension = /\.([^.]+)$/u.exec(name)?.[1]?.toLowerCase() ?? "";
  const declaredType = input.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const mimeType = declaredType === "image/jpg" ? "image/jpeg" : declaredType;
  let kind: PreparedAttachment["kind"] | undefined;

  if (IMAGE_TYPES.has(mimeType) || ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) kind = "image";
  else if (mimeType === "application/pdf" || extension === "pdf") kind = "pdf";
  else if (TEXT_EXTENSIONS[extension] || mimeType.startsWith("text/") || mimeType === "application/json") kind = "text";

  if (!kind) {
    throw new Error(`I can read PNG, JPEG, WebP, and GIF images, PDFs, and common text/code files. “${name}” isn’t a supported file type.`);
  }
  if (!Number.isFinite(input.size) || input.size < 0 || input.size > MAX_FILE_BYTES) {
    throw new Error(`“${name}” is too large for analysis. Each attachment must be 8 MB or smaller.`);
  }
  return {
    ...input,
    name,
    kind,
    mimeType: kind === "image"
      ? (IMAGE_TYPES.has(mimeType) ? mimeType : ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[extension])
      : kind === "pdf" ? "application/pdf" : (TEXT_EXTENSIONS[extension] ?? (mimeType || "text/plain")),
  };
}

export function validateAttachmentInputs(inputs: DiscordAttachmentInput[]): AttachmentDescriptor[] {
  if (!inputs.length) return [];
  let totalBytes = 0;
  const descriptors = inputs.map(input => {
    const descriptor = classify(input);
    totalBytes += descriptor.size;
    return descriptor;
  });
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Attachments in one message must total 16 MB or less.");
  return descriptors;
}

async function download(descriptor: AttachmentDescriptor): Promise<Buffer> {
  let url: URL;
  try { url = new URL(descriptor.url); }
  catch { throw new Error(`I couldn't read “${descriptor.name}”: its Discord attachment URL is invalid.`); }
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
    throw new Error(`I couldn't read “${descriptor.name}”: attachment URLs must come from Discord.`);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error(`I couldn't download “${descriptor.name}” from Discord (HTTP ${response.status}).`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_BYTES) throw new Error(`“${descriptor.name}” is too large for analysis. Each attachment must be 8 MB or smaller.`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error(`“${descriptor.name}” is too large for analysis. Each attachment must be 8 MB or smaller.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

export async function prepareAttachments(descriptors: AttachmentDescriptor[]): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  let totalDownloadedBytes = 0;
  let totalTextCharacters = 0;
  for (const descriptor of descriptors) {
    const data = await download(descriptor);
    totalDownloadedBytes += data.length;
    if (totalDownloadedBytes > MAX_TOTAL_BYTES) throw new Error("Attachments in one message must total 16 MB or less.");
    if (descriptor.kind === "image") {
      const mimeType = sniffImage(data);
      if (!mimeType) throw new Error(`“${descriptor.name}” doesn’t contain a supported PNG, JPEG, WebP, or GIF image.`);
      prepared.push({ kind: "image", name: descriptor.name, mimeType, data });
    } else if (descriptor.kind === "pdf") {
      if (data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error(`“${descriptor.name}” doesn’t appear to be a valid PDF.`);
      prepared.push({ kind: "pdf", name: descriptor.name, mimeType: "application/pdf", data });
    } else {
      if (data.includes(0)) throw new Error(`“${descriptor.name}” appears to be a binary file, not a readable text/code file.`);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { throw new Error(`“${descriptor.name}” isn’t valid UTF-8 text. Please upload a plain-text or code file.`); }
      const available = Math.max(0, MAX_TEXT_TOTAL - totalTextCharacters);
      const allowance = Math.min(MAX_TEXT_PER_FILE, available);
      const clipped = text.slice(0, allowance);
      totalTextCharacters += clipped.length;
      prepared.push({
        kind: "text",
        name: descriptor.name,
        mimeType: descriptor.mimeType,
        text: clipped + (clipped.length < text.length ? "\n[File text was shortened to fit the analysis limit.]" : ""),
      });
    }
  }
  return prepared;
}
