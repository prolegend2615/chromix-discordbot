import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { dbPromise } from "../database.js";

export type Poll = {
  id: number;
  guild_id: string;
  channel_id: string;
  creator_id: string;
  question: string;
  options_json: string;
  scheduled_at: number;
  status: string;
  message_id: string | null;
  delivery_attempts: number;
  retry_at: number | null;
  last_error: string | null;
};

export async function createPoll(input: { guildId: string; channelId: string; creatorId: string; question: string; options: string[]; scheduledAt: number }) {
  const question = input.question.trim();
  const options = input.options.map(value => value.trim()).filter(Boolean);
  if (!question || question.length > 250 || options.some(value => value.length > 100)
    || options.length < 2 || options.length > 10 || new Set(options.map(value => value.toLowerCase())).size !== options.length) {
    throw new Error("A poll needs a question and 2–10 distinct options.");
  }
  const db = await dbPromise;
  const recentCount = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM polls WHERE guild_id=? AND created_at>?", input.guildId, Date.now() - 24 * 60 * 60_000);
  if (Number(recentCount?.count ?? 0) >= 20) throw new Error("This server has reached its limit of 20 polls per day.");
  const result = await (await dbPromise).run(
    "INSERT INTO polls(guild_id,channel_id,creator_id,question,options_json,scheduled_at,status,created_at) VALUES(?,?,?,?,?,?,'scheduled',?)",
    input.guildId, input.channelId, input.creatorId, question, JSON.stringify(options), input.scheduledAt, Date.now(),
  );
  return Number(result.lastID);
}

export async function getDuePolls(now = Date.now()): Promise<Poll[]> {
  return (await dbPromise).all<Poll[]>("SELECT * FROM polls WHERE status='scheduled' AND scheduled_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY scheduled_at,id", now, now);
}

export async function publishPoll(id: number, messageId: string) {
  await (await dbPromise).run("UPDATE polls SET status='open',message_id=? WHERE id=? AND status='scheduled'", messageId, id);
}

export async function getPoll(id: number): Promise<Poll | undefined> {
  return (await dbPromise).get<Poll>("SELECT * FROM polls WHERE id=?", id);
}

export async function getUserPolls(userId: string) {
  return (await dbPromise).all<Poll[]>("SELECT * FROM polls WHERE creator_id=? AND status IN ('scheduled','open') ORDER BY scheduled_at", userId);
}

export async function cancelPoll(id: number, userId: string) {
  const result = await (await dbPromise).run("UPDATE polls SET status='cancelled' WHERE id=? AND creator_id=? AND status IN ('scheduled','open')", id, userId);
  return result.changes === 1;
}

export async function votePoll(id: number, userId: string, optionIndex: number) {
  const poll = await getPoll(id);
  if (!poll || poll.status !== "open") throw new Error("This poll is no longer open.");
  const options = JSON.parse(poll.options_json) as string[];
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) throw new Error("That poll option is invalid.");
  await (await dbPromise).run(
    "INSERT INTO poll_votes(poll_id,user_id,option_index,created_at) VALUES(?,?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET option_index=excluded.option_index,created_at=excluded.created_at",
    id, userId, optionIndex, Date.now(),
  );
  return poll;
}

export async function buildPollPayload(poll: Poll) {
  const options = JSON.parse(poll.options_json) as string[];
  const rows = await (await dbPromise).all<{ option_index: number; count: number }[]>(
    "SELECT option_index,COUNT(*) AS count FROM poll_votes WHERE poll_id=? GROUP BY option_index", poll.id,
  );
  const counts = new Map(rows.map(row => [Number(row.option_index), Number(row.count)]));
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
  const embed = new EmbedBuilder().setTitle(poll.question).setColor(0x5865F2)
    .setDescription(options.map((option, index) => `**${index + 1}. ${option}** — ${counts.get(index) ?? 0} vote${counts.get(index) === 1 ? "" : "s"}`).join("\n"))
    .setFooter({ text: `${total} vote${total === 1 ? "" : "s"} • Poll #${poll.id}` });
  const menu = new StringSelectMenuBuilder().setCustomId(`poll:vote:${poll.id}`).setPlaceholder("Cast or change your vote")
    .addOptions(options.map((label, value) => ({ label, value: String(value) })));
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

export async function markPollDeliveryFailure(poll: Poll, error: unknown) {
  const db = await dbPromise;
  const attempts = Number(poll.delivery_attempts ?? 0) + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (attempts >= 3) {
    await db.run("INSERT INTO scheduled_delivery_failures(kind,action_id,guild_id,creator_id,error,created_at) VALUES(?,?,?,?,?,?)", "poll", poll.id, poll.guild_id, poll.creator_id, message, Date.now());
    await db.run("UPDATE polls SET status='failed',last_error=? WHERE id=?", message, poll.id);
    return { failed: true, attempts };
  }
  await db.run("UPDATE polls SET delivery_attempts=?,retry_at=?,last_error=? WHERE id=?", attempts, Date.now() + 60_000, message, poll.id);
  return { failed: false, attempts };
}
