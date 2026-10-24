import { randomInt } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
} from "discord.js";
import { dbPromise } from "../database.js";

export type Giveaway = {
  id: number;
  guild_id: string;
  channel_id: string;
  creator_id: string;
  prize: string;
  ends_at: number;
  winner_count: number;
  required_role_id: string | null;
  required_role_name: string | null;
  status: "publishing" | "active" | "drawing" | "ended" | "cancelled";
  message_id: string | null;
  winner_ids_json: string | null;
  created_at: number;
  ended_at: number | null;
};

export async function resolveGiveawayRole(guild: Guild, roleInput: string | null) {
  if (!roleInput) return null;
  const roleId = /^(?:<@&)?(\d{15,22})>?$/.exec(roleInput.trim())?.[1];
  const findRole = (roles: typeof guild.roles.cache) => roleId
    ? roles.get(roleId) ?? null
    : roles.find(candidate => candidate.name.toLocaleLowerCase() === roleInput.trim().toLocaleLowerCase()) ?? null;
  const role = findRole(guild.roles.cache) ?? findRole(await guild.roles.fetch());
  if (!role) throw new Error(`I couldn't find the required role “${roleInput}”. Mention the role or provide its exact name.`);
  return role;
}

export async function createGiveaway(input: {
  guildId: string;
  channelId: string;
  creatorId: string;
  prize: string;
  endsAt: number;
  winnerCount: number;
  requiredRoleId: string | null;
  requiredRoleName: string | null;
}) {
  const prize = input.prize.trim().replace(/\s+/g, " ");
  if (!prize || prize.length > 200) throw new Error("Giveaway prizes must be between 1 and 200 characters.");
  if (!Number.isSafeInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > 20) {
    throw new Error("Choose between 1 and 20 winners.");
  }
  if (input.endsAt <= Date.now()) throw new Error("The giveaway end time must be in the future.");

  const result = await (await dbPromise).run(
    "INSERT INTO giveaways(guild_id,channel_id,creator_id,prize,ends_at,winner_count,required_role_id,required_role_name,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'publishing',?)",
    input.guildId,
    input.channelId,
    input.creatorId,
    prize,
    input.endsAt,
    input.winnerCount,
    input.requiredRoleId,
    input.requiredRoleName,
    Date.now(),
  );
  return Number(result.lastID);
}

export async function publishGiveaway(id: number, messageId: string) {
  const result = await (await dbPromise).run(
    "UPDATE giveaways SET message_id=?,status='active' WHERE id=? AND status='publishing'",
    messageId,
    id,
  );
  return result.changes === 1;
}

export async function deleteGiveaway(id: number) {
  await (await dbPromise).run("DELETE FROM giveaways WHERE id=? AND status='publishing'", id);
}

export async function getGiveaway(id: number): Promise<Giveaway | undefined> {
  return (await dbPromise).get<Giveaway>("SELECT * FROM giveaways WHERE id=?", id);
}

export async function getGiveawayEntryCount(id: number) {
  const row = await (await dbPromise).get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM giveaway_entries WHERE giveaway_id=?",
    id,
  );
  return Number(row?.count ?? 0);
}

export type GiveawayEntryResult = "joined" | "already_joined" | "left" | "not_entered" | "closed" | "missing";

export async function joinGiveaway(id: number, userId: string): Promise<GiveawayEntryResult> {
  const now = Date.now();
  const result = await (await dbPromise).run(
    "INSERT OR IGNORE INTO giveaway_entries(giveaway_id,user_id,joined_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM giveaways WHERE id=? AND status='active' AND ends_at>?)",
    id,
    userId,
    now,
    id,
    now,
  );
  if (result.changes === 1) return "joined";
  const giveaway = await getGiveaway(id);
  if (!giveaway) return "missing";
  return giveaway.status === "active" && giveaway.ends_at > Date.now() ? "already_joined" : "closed";
}

export async function leaveGiveaway(id: number, userId: string): Promise<GiveawayEntryResult> {
  const now = Date.now();
  const result = await (await dbPromise).run(
    "DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=? AND EXISTS(SELECT 1 FROM giveaways WHERE id=? AND status='active' AND ends_at>?)",
    id,
    userId,
    id,
    now,
  );
  if (result.changes === 1) return "left";
  const giveaway = await getGiveaway(id);
  if (!giveaway) return "missing";
  return giveaway.status === "active" && giveaway.ends_at > Date.now() ? "not_entered" : "closed";
}

export async function getDueGiveaways(now = Date.now()): Promise<Giveaway[]> {
  return (await dbPromise).all<Giveaway[]>(
    "SELECT * FROM giveaways WHERE (status='active' AND ends_at<=?) OR status='drawing' ORDER BY ends_at,id",
    now,
  );
}

/** Claims a due giveaway before reading entries so later button actions cannot change the draw. */
export async function drawGiveaway(id: number, now = Date.now()): Promise<Giveaway | null> {
  const db = await dbPromise;
  await db.run("UPDATE giveaways SET status='drawing' WHERE id=? AND status='active' AND ends_at<=?", id, now);
  let giveaway = await getGiveaway(id);
  if (!giveaway || giveaway.status !== "drawing") return null;

  if (giveaway.winner_ids_json === null) {
    const entries = await db.all<{ user_id: string }[]>(
      "SELECT user_id FROM giveaway_entries WHERE giveaway_id=? ORDER BY joined_at,user_id",
      id,
    );
    const pool = [...entries];
    const winners: string[] = [];
    const winnerCount = Math.min(giveaway.winner_count, pool.length);
    for (let index = 0; index < winnerCount; index += 1) {
      const winnerIndex = randomInt(pool.length);
      winners.push(pool.splice(winnerIndex, 1)[0].user_id);
    }
    await db.run(
      "UPDATE giveaways SET winner_ids_json=? WHERE id=? AND status='drawing' AND winner_ids_json IS NULL",
      JSON.stringify(winners),
      id,
    );
    giveaway = await getGiveaway(id);
  }
  return giveaway?.status === "drawing" ? giveaway : null;
}

export async function markGiveawayEnded(id: number) {
  await (await dbPromise).run(
    "UPDATE giveaways SET status='ended',ended_at=? WHERE id=? AND status='drawing'",
    Date.now(),
    id,
  );
}

export async function buildGiveawayPayload(giveaway: Giveaway, forceOpen = false) {
  const isOpen = forceOpen || giveaway.status === "active";
  const endTimestamp = Math.floor(giveaway.ends_at / 1000);
  const entryCount = await getGiveawayEntryCount(giveaway.id);
  const winnerIds = giveaway.winner_ids_json ? JSON.parse(giveaway.winner_ids_json) as string[] : [];
  const winnerMentions = winnerIds.map(id => `<@${id}>`);
  const host = giveaway.creator_id === "0" ? "a server admin" : `<@${giveaway.creator_id}>`;
  const embed = new EmbedBuilder()
    .setColor(isOpen ? 0xA855F7 : 0x22C55E)
    .setAuthor({ name: isOpen ? "✦ CHROMIX  /  COMMUNITY GIVEAWAY" : "✦ CHROMIX  /  GIVEAWAY COMPLETE" })
    .setTitle(`${isOpen ? "🎁" : "🎉"} ${giveaway.prize}`)
    .setDescription(isOpen
      ? `A special drop for this server.\n\n**Hosted by** ${host}`
      : winnerMentions.length
        ? `**Winner${winnerMentions.length === 1 ? "" : "s"}:** ${winnerMentions.join(", ")}\n\nCongratulations!`
        : "No eligible entries joined this time.")
    .addFields(
      { name: "⏳  ENDS", value: `<t:${endTimestamp}:F>\n<t:${endTimestamp}:R>`, inline: true },
      { name: "🎟️  ENTRIES", value: `**${entryCount}** participant${entryCount === 1 ? "" : "s"}`, inline: true },
      { name: "🏆  WINNERS", value: `**${giveaway.winner_count}** winner${giveaway.winner_count === 1 ? "" : "s"}${winnerMentions.length ? `\n${winnerMentions.join("\n")}` : ""}`, inline: true },
      { name: "🔐  ELIGIBILITY", value: giveaway.required_role_id ? `Requires <@&${giveaway.required_role_id}>` : "Open to everyone in the server", inline: false },
    )
    .setFooter({ text: `Giveaway #${giveaway.id}  •  Enter below${isOpen ? " before it ends" : "  •  Thanks for joining"}` })
    .setTimestamp(new Date(giveaway.created_at));

  const mentions = winnerIds.length ? { parse: [] as const, users: winnerIds } : { parse: [] as const };
  if (!isOpen) {
    return {
      content: winnerMentions.length ? `🎊 Congratulations ${winnerMentions.join(", ")}!` : "🎊 Giveaway ended.",
      embeds: [embed],
      components: [],
      allowedMentions: mentions,
    };
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`giveaway:join:${giveaway.id}`).setLabel("Join Giveaway").setEmoji("🎉").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`giveaway:leave:${giveaway.id}`).setLabel("Leave").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] as const } };
}
