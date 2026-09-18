import type { Message, User, GuildMember, TextBasedChannel } from "discord.js";
import { getSettings } from "./settings.js";
import { addHistory, getHistory } from "./history.js";
import { checkPromptLimit, isChannelAllowed } from "./access.js";
import { streamAnswer } from "./ai.js";
import { recordResponseMetric, resolveThreadConversationKey } from "./metrics.js";
import { clearAfkStatus, getAfkStatus, normalizeAfkReason, setAfkStatus, type AfkStatus } from "./afk.js";
import { formatReminderDuration, hasReminderIntent, parseReminderDuration, parseSetAfkCommand, parseSetReminderCommand } from "../logic.js";
import { createReminder } from "./reminders.js";

const activePrompts = new Set<string>();
const DISCORD_MESSAGE_LIMIT = 2000;

type SendableTextChannel = TextBasedChannel & {
  send: (content: string) => Promise<Message>;
};

function isSendableTextChannel(channel: TextBasedChannel): channel is SendableTextChannel {
  return "send" in channel && typeof channel.send === "function";
}

function splitDiscordMessage(content: string): string[] {
  if (!content) return ["I could not generate a response."];
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const candidate = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
    const newline = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const splitAt = Math.max(newline, space);
    const cutAt = splitAt > 0 ? splitAt : DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^[ \n]+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function getThreadChannelId(channel: TextBasedChannel): string | undefined {
  if (!("threadId" in channel)) return undefined;
  const threadId = channel.threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

export async function runChat(args: {
  prompt: string; user: User; member: GuildMember | null; guildId?: string; guildName?: string;
  channel: TextBasedChannel; channelId: string; messageTimestamp?: number; sourceMessageId?: string; referencedMessageId?: string;
  reply: (content: string) => Promise<Message>;
  edit?: (content: string) => Promise<unknown>;
  onAfkSet?: (reason: string, placeholder: Message) => Promise<void>;
  onReminderSet?: (seconds: number, message: string, placeholder: Message) => Promise<void>;
  onWelcomeBack?: (status: AfkStatus) => Promise<void>;
}) {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error("Please include a message for me to answer.");
  if (!(await isChannelAllowed(args.guildId, args.channelId))) throw new Error("I am not enabled in this channel.");
  const existingAfk = await getAfkStatus(args.user.id, args.guildId);
  if (existingAfk) {
    await clearAfkStatus(args.user.id, args.guildId);
  }
  const threadId = getThreadChannelId(args.channel);
  const conversationChannelId = threadId ?? args.channelId;
  const key = resolveThreadConversationKey(args.guildId, threadId, args.user.id);
  if (activePrompts.has(key)) throw new Error("I am already answering your previous prompt.");
  const limit = await checkPromptLimit(args.user.id);
  if (!limit.ok) throw new Error(limit.message);

  activePrompts.add(key);
  try {
    if ("sendTyping" in args.channel) await args.channel.sendTyping();
    const placeholder = await args.reply("Thinking…");
    if (existingAfk) await args.onWelcomeBack?.(existingAfk);
    const settings = await getSettings(args.user.id, args.guildId);
    const history = await getHistory(args.user.id, args.guildId, conversationChannelId, settings.vip ? 12 : 5);
    // discord.js uses camelCase property names: User.globalName, User.username,
    // GuildMember.displayName, GuildMember.nickname, and Guild.name.
    const userName = args.user.globalName ?? args.user.username;
    const serverNickname = args.member?.nickname ?? "None";
    const startedAt = Date.now();
    let answer = "";
    await streamAnswer({
      prompt,
      userName,
      serverNickname,
      guildName: args.guildName ?? "Direct Message",
      settings,
      history,
      messageTimestamp: args.messageTimestamp ?? Date.now(),
       reminderActionEnabled: hasReminderIntent(prompt),
      onDelta: text => { answer += text; },
    });
    const afkCommand = parseSetAfkCommand(answer);
    const reminderCommand = hasReminderIntent(prompt) ? parseSetReminderCommand(answer) : null;
    let actionResponseHandled = false;
    if (afkCommand) {
      const reason = normalizeAfkReason(afkCommand.reason);
      await setAfkStatus(args.user.id, args.guildId, reason, args.messageTimestamp ?? Date.now());
      answer = `AFK status set. Reason: ${reason}.`;
      if (args.onAfkSet) {
        await args.onAfkSet(reason, placeholder);
        actionResponseHandled = true;
      }
    }
    if (reminderCommand) {
      const durationSeconds = parseReminderDuration(reminderCommand.duration);
      if (durationSeconds === null) {
        answer = "I could not set that reminder. Reminders must use seconds, minutes, or hours, and cannot be longer than 12 hours.";
      } else {
        const reminder = await createReminder({
          userId: args.user.id,
          guildId: args.guildId,
          channelId: args.channelId,
          duration: reminderCommand.duration,
          message: reminderCommand.message,
          now: args.messageTimestamp ?? Date.now(),
        });
        answer = `Reminder set for ${formatReminderDuration(reminder.seconds)}: ${reminder.message}`;
        if (args.onReminderSet) {
          await args.onReminderSet(reminder.seconds, reminder.message, placeholder);
          actionResponseHandled = true;
        }
      }
    }
    if (!actionResponseHandled) {
      const chunks = splitDiscordMessage(answer);
      const editMessage = args.edit ?? (content => placeholder.edit(content));
      await editMessage(chunks[0]);
      if (chunks.length > 1) {
        const sendableChannel = args.channel;
        if (!isSendableTextChannel(sendableChannel)) {
          throw new Error("This channel cannot receive additional response messages.");
        }
        for (const chunk of chunks.slice(1)) {
          await sendableChannel.send(chunk);
        }
      }
    }
    const responseTimeMs = Date.now() - startedAt;
    await recordResponseMetric(args.user.id, args.guildId, conversationChannelId, responseTimeMs);
    await addHistory(args.user.id, args.guildId, conversationChannelId, { role: "user", content: prompt }, args.sourceMessageId, args.referencedMessageId);
    await addHistory(args.user.id, args.guildId, conversationChannelId, { role: "assistant", content: answer }, placeholder.id);
  } finally {
    activePrompts.delete(key);
  }
}
