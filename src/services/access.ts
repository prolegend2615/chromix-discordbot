import { dbPromise } from "../database.js";
const WINDOW_MS=60000,COOLDOWN_MS=5000,MAX_PROMPTS=8;
const ATTACHMENT_WINDOW_MS=60*60*1000;
const attachmentQuotaQueues = new Map<string, Promise<void>>();

export async function getPromptViolationCount(userId:string){
  const db = await dbPromise;
  const now = Date.now();
  const row = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quota_violations WHERE user_id=? AND created_at> ?", userId, now - WINDOW_MS);
  return Number(row?.count ?? 0);
}

export async function checkPromptLimit(userId:string){
  const db = await dbPromise;
  const now = Date.now();
  const latest = await db.get<{ created_at: number }>("SELECT created_at FROM prompt_events WHERE user_id=? ORDER BY created_at DESC LIMIT 1", userId);
  if (latest && now - latest.created_at < COOLDOWN_MS) {
    return { ok: false as const, message: "Please wait before sending another prompt.", remaining: 0, violations: await getPromptViolationCount(userId) };
  }
  const count = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM prompt_events WHERE user_id=? AND created_at>?", userId, now - WINDOW_MS);
  const remaining = Math.max(0, MAX_PROMPTS - Number(count?.count ?? 0));
  if (Number(count?.count ?? 0) >= MAX_PROMPTS) {
    await db.run("INSERT INTO quota_violations(user_id,created_at,reason) VALUES(?,?,?)", userId, now, "prompt_limit");
    return { ok: false as const, message: "You have reached the limit of 8 prompts per minute. Please try again shortly.", remaining, violations: await getPromptViolationCount(userId) };
  }
  await db.run("INSERT INTO prompt_events(user_id,created_at) VALUES(?,?)", userId, now);
  return { ok: true as const, remaining: Math.max(0, MAX_PROMPTS - Number(count?.count ?? 0) - 1), violations: await getPromptViolationCount(userId) };
}

export async function getPromptStatus(userId:string){
  const db = await dbPromise;
  const now = Date.now();
  const count = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM prompt_events WHERE user_id=? AND created_at>?", userId, now - WINDOW_MS);
  const violations = await getPromptViolationCount(userId);
  return { remaining: Math.max(0, MAX_PROMPTS - Number(count?.count ?? 0)), cooldownSeconds: 0, violations, windowMs: WINDOW_MS };
}

export type AttachmentQuotaReservation =
  | { ok: true; eventIds: number[]; remaining: number; limit: number }
  | { ok: false; remaining: number; limit: number };

export async function reserveAttachmentUploads(userId: string, vip: boolean, uploadCount: number): Promise<AttachmentQuotaReservation> {
  const previous = attachmentQuotaQueues.get(userId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const db = await dbPromise;
    const now = Date.now();
    const limit = vip ? 10 : 3;
    await db.run("DELETE FROM attachment_upload_events WHERE user_id=? AND created_at<=?", userId, now - ATTACHMENT_WINDOW_MS);
    const row = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attachment_upload_events WHERE user_id=? AND created_at>?",
      userId,
      now - ATTACHMENT_WINDOW_MS,
    );
    const used = Number(row?.count ?? 0);
    const remaining = Math.max(0, limit - used);
    if (!Number.isInteger(uploadCount) || uploadCount < 1 || uploadCount > remaining) return { ok: false as const, remaining, limit };

    const eventIds: number[] = [];
    try {
      for (let index = 0; index < uploadCount; index += 1) {
        const result = await db.run("INSERT INTO attachment_upload_events(user_id,created_at) VALUES(?,?)", userId, now);
        if (typeof result.lastID === "number") eventIds.push(result.lastID);
      }
    } catch (error) {
      for (const eventId of eventIds) await db.run("DELETE FROM attachment_upload_events WHERE id=?", eventId);
      throw error;
    }
    return { ok: true as const, eventIds, remaining: remaining - uploadCount, limit };
  });
  const tail = current.then(() => undefined, () => undefined);
  attachmentQuotaQueues.set(userId, tail);
  try {
    return await current;
  } finally {
    if (attachmentQuotaQueues.get(userId) === tail) attachmentQuotaQueues.delete(userId);
  }
}

export async function releaseAttachmentUploadReservations(eventIds: number[]) {
  const db = await dbPromise;
  for (const eventId of eventIds) await db.run("DELETE FROM attachment_upload_events WHERE id=?", eventId);
}

export async function getAttachmentUploadStatus(userId: string, vip: boolean) {
  const db = await dbPromise;
  const now = Date.now();
  const limit = vip ? 10 : 3;
  await db.run("DELETE FROM attachment_upload_events WHERE user_id=? AND created_at<=?", userId, now - ATTACHMENT_WINDOW_MS);
  const row = await db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM attachment_upload_events WHERE user_id=? AND created_at>?",
    userId,
    now - ATTACHMENT_WINDOW_MS,
  );
  const used = Number(row?.count ?? 0);
  return { remaining: Math.max(0, limit - used), limit, resetsInMs: used ? await nextAttachmentResetInMs(userId, now) : 0 };
}

async function nextAttachmentResetInMs(userId: string, now: number) {
  const row = await (await dbPromise).get<{ created_at: number }>(
    "SELECT created_at FROM attachment_upload_events WHERE user_id=? ORDER BY created_at ASC LIMIT 1",
    userId,
  );
  return Math.max(0, (row?.created_at ?? now) + ATTACHMENT_WINDOW_MS - now);
}

export async function isChannelAllowed(guildId:string|undefined,channelId:string){if(!guildId)return true;const rules=await(await dbPromise).all<any[]>("SELECT channel_id,rule FROM channel_rules WHERE guild_id=?",guildId);if(rules.some(r=>r.channel_id===channelId&&r.rule==="ignore"))return false;const listening=rules.filter(r=>r.rule==="listen");return !listening.length||listening.some(r=>r.channel_id===channelId);}
export async function setChannelRule(guildId:string,channelId:string,rule:"listen"|"ignore"){await(await dbPromise).run("INSERT INTO channel_rules(guild_id,channel_id,rule,created_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,channel_id) DO UPDATE SET rule=excluded.rule,created_at=excluded.created_at",guildId,channelId,rule,Date.now());}
