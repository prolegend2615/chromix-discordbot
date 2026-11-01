import { dbPromise } from "../database.js";

export type PersonalMemory = { id: number; user_id: string; memory: string; created_at: number; updated_at: number };
const MAX_PERSONAL_MEMORIES = 100;

export async function listPersonalMemories(userId: string) {
  return (await dbPromise).all<PersonalMemory[]>("SELECT * FROM personal_memories WHERE user_id=? ORDER BY updated_at DESC,id DESC", userId);
}

export async function addPersonalMemory(userId: string, memory: string) {
  const clean = memory.replace(/[\r\n<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500);
  if (!clean) throw new Error("Tell me what to remember.");
  const db = await dbPromise;
  const count = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM personal_memories WHERE user_id=?", userId);
  if (Number(count?.count ?? 0) >= MAX_PERSONAL_MEMORIES) throw new Error("Your VIP memory is full. Use `c.forget <id>` before adding another memory.");
  const now = Date.now();
  const result = await db.run("INSERT INTO personal_memories(user_id,memory,created_at,updated_at) VALUES(?,?,?,?)", userId, clean, now, now);
  return Number(result.lastID);
}

export async function deletePersonalMemory(userId: string, id: number) {
  const result = await (await dbPromise).run("DELETE FROM personal_memories WHERE user_id=? AND id=?", userId, id);
  return result.changes === 1;
}

export function formatPersonalMemories(memories: PersonalMemory[]) {
  if (!memories.length) return "";
  return memories.map(item => `- ${item.memory}`).join("\n");
}
