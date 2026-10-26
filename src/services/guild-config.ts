import { dbPromise } from "../database.js";

export type GuildConfig = {
  guild_id: string;
  welcome_enabled: number;
  welcome_channel_id: string | null;
  welcome_message: string;
  goodbye_enabled: number;
  goodbye_channel_id: string | null;
  goodbye_message: string;
  verification_enabled: number;
  verification_channel_id: string | null;
  verification_role_id: string | null;
  retention_days: number;
  giveaway_manager_role_id: string | null;
  giveaway_manager_role_name: string | null;
  updated_at: number;
};

const defaults = {
  welcome_enabled: 0, welcome_channel_id: null, welcome_message: "Welcome {user}!",
  goodbye_enabled: 0, goodbye_channel_id: null, goodbye_message: "Goodbye {user}.",
  verification_enabled: 0, verification_channel_id: null, verification_role_id: null,
  retention_days: 0, giveaway_manager_role_id: null, giveaway_manager_role_name: null,
} as const;

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const db = await dbPromise;
  const row = await db.get<GuildConfig>("SELECT * FROM guild_config WHERE guild_id=?", guildId);
  if (row) return row;
  const now = Date.now();
  await db.run("INSERT INTO guild_config(guild_id,updated_at) VALUES(?,?)", guildId, now);
  return { guild_id: guildId, ...defaults, updated_at: now };
}

export async function updateGuildConfig(guildId: string, changes: Partial<Omit<GuildConfig, "guild_id" | "updated_at">>) {
  await getGuildConfig(guildId);
  const entries = Object.entries(changes);
  if (!entries.length) return getGuildConfig(guildId);
  const db = await dbPromise;
  await db.run(
    `UPDATE guild_config SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE guild_id=?`,
    ...entries.map(([, value]) => value), Date.now(), guildId,
  );
  return getGuildConfig(guildId);
}

export function renderCommunityMessage(template: string, user: { id: string; username: string; globalName?: string | null }, guildName: string) {
  return template
    .replaceAll("{user}", user.globalName ?? user.username)
    .replaceAll("{mention}", `<@${user.id}>`)
    .replaceAll("{server}", guildName)
    .slice(0, 1800);
}
