import { ActionRowBuilder, StringSelectMenuBuilder, type GuildMember } from "discord.js";
import { dbPromise } from "../database.js";

export type CommunityRoleOption = { roleId: string; label: string };

export async function createRoleMenu(input: { guildId: string; channelId: string; options: CommunityRoleOption[] }) {
  const options = input.options.filter(option => /^\d{15,22}$/.test(option.roleId) && option.label.trim()).slice(0, 25).map(option => ({ roleId: option.roleId, label: option.label.trim().slice(0, 100) }));
  if (options.length < 1) throw new Error("Add at least one valid role ID and label.");
  const db = await dbPromise;
  const result = await db.run("INSERT INTO community_role_menus(guild_id,channel_id,options_json,created_at) VALUES(?,?,?,?)", input.guildId, input.channelId, JSON.stringify(options), Date.now());
  return Number(result.lastID);
}

export async function attachRoleMenuMessage(id: number, messageId: string) {
  await (await dbPromise).run("UPDATE community_role_menus SET message_id=? WHERE id=?", messageId, id);
}

export async function getRoleMenu(id: number) {
  const row = await (await dbPromise).get<{ id: number; guild_id: string; channel_id: string; message_id: string | null; options_json: string }>("SELECT * FROM community_role_menus WHERE id=?", id);
  if (!row) return null;
  return { ...row, options: JSON.parse(row.options_json) as CommunityRoleOption[] };
}

export function buildRoleMenuPayload(menuId: number, options: CommunityRoleOption[]) {
  const menu = new StringSelectMenuBuilder().setCustomId(`community:roles:${menuId}`).setPlaceholder("Choose your roles").setMinValues(1).setMaxValues(Math.min(options.length, 25)).addOptions(options.map(option => ({ label: option.label, value: option.roleId })));
  return {
    content: "Choose the roles you want. Your selection replaces the roles managed by this menu.",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    allowedMentions: { parse: [] as const },
  };
}

export async function applyRoleMenuSelection(member: GuildMember, options: CommunityRoleOption[], selected: string[]) {
  const managed = new Set(options.map(option => option.roleId));
  const selectedSet = new Set(selected);
  const botHighestPosition = member.guild.members.me?.roles.highest.position ?? -1;
  for (const roleId of managed) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role || role.managed || role.position >= botHighestPosition) continue;
    if (selectedSet.has(roleId) && !member.roles.cache.has(roleId)) await member.roles.add(role, "Community role menu selection");
    if (!selectedSet.has(roleId) && member.roles.cache.has(roleId)) await member.roles.remove(role, "Community role menu selection");
  }
}
