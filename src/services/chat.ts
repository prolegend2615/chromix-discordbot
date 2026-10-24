import { ChannelType, PermissionsBitField, type Message, type MessageCreateOptions, type User, type GuildMember, type TextBasedChannel } from "discord.js";
import { getSettings } from "./settings.js";
import { addHistory, getHistory } from "./history.js";
import { checkPromptLimit, isChannelAllowed } from "./access.js";
import { streamAnswer } from "./ai.js";
import { recordResponseMetric, resolveThreadConversationKey } from "./metrics.js";
import { clearAfkStatus, getAfkStatus, normalizeAfkReason, setAfkStatus, type AfkStatus } from "./afk.js";
import {
  formatReminderDuration,
  hasImageGenerationIntent,
  hasPollIntent,
  hasScheduleMessageIntent,
  hasReminderIntent,
  hasRockPaperScissorsIntent,
  hasTicTacToeIntent,
  hasTtsIntent,
  hasTimerIntent,
  parseGenerateImageCommand,
  parseCreatePollCommand,
  parseScheduleMessageCommand,
  parseReminderDuration,
  parseRockPaperScissorsCommand,
  parseSamSpeakCommand,
  parseSetAfkCommand,
  parseSetReminderCommand,
  parseSetTimerCommand,
  parseShowAvatarCommand,
  parseTicTacToeCommand,
} from "../logic.js";
import { createReminder } from "./reminders.js";
import { reserveVoiceMessage, type VoiceReservation } from "./tts.js";
import { generateGuildImage } from "./image-generation.js";
import {
  executeChannelManagementCommand,
  parseChannelManagementCommand,
} from "./channel-management.js";
import { config } from "../config.js";
import { runWebSearchAgent, searchWeb, formatWebSearchSources } from "./web-search.js";
import { createPoll, buildPollPayload, getPoll, publishPoll } from "./polls.js";
import { createScheduledPost, createTimer, parseScheduleDuration } from "./scheduled-actions.js";

const activePrompts = new Set<string>();
const serverFactsCache = new Map<string, { expiresAt: number; facts: string }>();
const DISCORD_MESSAGE_LIMIT = 2000;

type SendableTextChannel = TextBasedChannel & {
  send: (content: string | MessageCreateOptions) => Promise<Message>;
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

const ACTION_PREFIXES = [
  "use set_afk (", "use set_reminder (", "use sam_speak (", "use show_avatar (",
  "use generate_image (", "use create_poll (", "use set_timer (", "use schedule_message (",
  "use create_channel", "use create_category", "use delete_channel", "use delete_category",
  "use rock_paper_scissors", "use tic_tac_toe", "use search_",
];

function createStreamingEditor(edit: (content: string) => Promise<unknown>) {
  let draft = "";
  let published = "";
  let lastEditAt = 0;
  let pending = Promise.resolve();

  const isActionOutput = (text: string) => {
    const normalized = text.trimStart().toLowerCase();
    return ACTION_PREFIXES.some(prefix => normalized.startsWith(prefix) || prefix.startsWith(normalized));
  };

  const enqueueEdit = (content: string) => {
    if (content === published) return;
    published = content;
    lastEditAt = Date.now();
    pending = pending.then(() => edit(content)).then(() => undefined).catch(() => undefined);
  };

  const visibleDraft = () => draft.length <= 1900 ? draft : `${draft.slice(0, 1897)}…`;

  return {
    push(text: string) {
      draft += text;
      if (isActionOutput(draft)) return;
      const visible = visibleDraft();
      const added = visible.length - published.length;
      if (visible.trim() && added >= 35 && Date.now() - lastEditAt >= 900) {
        enqueueEdit(visible);
      }
    },
    async finish() {
      if (!isActionOutput(draft) && draft.trim()) enqueueEdit(visibleDraft());
      await pending;
    },
    async reset(status = "Retrying with another AI provider…") {
      await pending;
      draft = "";
      published = "";
      enqueueEdit(status);
      await pending;
      published = "";
      lastEditAt = 0;
    },
  };
}

function getThreadChannelId(channel: TextBasedChannel): string | undefined {
  if (!("threadId" in channel)) return undefined;
  const threadId = channel.threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

async function getServerFacts(channel: TextBasedChannel): Promise<string> {
  if (!("guild" in channel) || !channel.guild) return "";
  const guild = channel.guild;
  const cached = serverFactsCache.get(guild.id);
  if (cached && cached.expiresAt > Date.now()) return cached.facts;
  let ownerName = "Unavailable";
  try {
    const owner = guild.members.cache.get(guild.ownerId) ?? await guild.fetchOwner();
    ownerName = owner.user.globalName ?? owner.user.username;
  } catch { /* Server facts should not block an otherwise useful answer. */ }
  const channels = guild.channels.cache;
  const roles = guild.roles.cache.filter(role => role.id !== guild.id).sort((a, b) => b.position - a.position);
  const highestRole = roles.first()?.name ?? "None";
  const channelCount = channels.size;
  const textChannelCount = channels.filter(item => item?.type === ChannelType.GuildText || item?.type === ChannelType.GuildAnnouncement).size;
  const voiceChannelCount = channels.filter(item => item?.type === ChannelType.GuildVoice || item?.type === ChannelType.GuildStageVoice).size;
  const categoryCount = channels.filter(item => item?.type === ChannelType.GuildCategory).size;
  const facts = [
    `Server owner: ${ownerName}`,
    `Member count: ${guild.memberCount}`,
    `Highest role: ${highestRole}`,
    `Channel count: ${channelCount} total including ${categoryCount} categories (${textChannelCount} text/announcement, ${voiceChannelCount} voice/stage).`,
  ].join("\n");
  serverFactsCache.set(guild.id, { expiresAt: Date.now() + 15 * 60_000, facts });
  return facts;
}

export async function runChat(args: {
  prompt: string;
  adminChat?: boolean;
  user: User;
  member: GuildMember | null;
  guildId?: string;
  guildName?: string;
  channel: TextBasedChannel;
  channelId: string;
  messageTimestamp?: number;
  sourceMessageId?: string;
  referencedMessageId?: string;
  reply: (content: string) => Promise<Message>;
  edit?: (content: string) => Promise<unknown>;
  onAfkSet?: (reason: string, placeholder: Message) => Promise<void>;
  onReminderSet?: (seconds: number, message: string, placeholder: Message) => Promise<void>;
  onAvatar?: (target: string, placeholder: Message) => Promise<void>;
  onRockPaperScissors?: (placeholder: Message) => Promise<void>;
  onTicTacToe?: (placeholder: Message) => Promise<void>;
  onWelcomeBack?: (status: AfkStatus) => Promise<void>;
}) {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error("Please include a message for me to answer.");
  if (args.adminChat && (!args.guildId || !args.member?.permissions.has(PermissionsBitField.Flags.Administrator))) {
    throw new Error("Only server administrators can use admin chat.");
  }
  if (hasImageGenerationIntent(prompt) && !args.guildId) {
    throw new Error("Image generation is only available in a Discord server, not in direct messages.");
  }
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
  let voiceReservation: VoiceReservation | undefined;

  try {
    if ("sendTyping" in args.channel) await args.channel.sendTyping();
    const placeholder = await args.reply("Thinking…");
    const editResponse = args.edit ?? (content => placeholder.edit(content));
    const streamingEditor = createStreamingEditor(editResponse);

    if (!args.adminChat && hasTtsIntent(prompt)) {
      voiceReservation = reserveVoiceMessage({ channel: args.channel, channelId: args.channelId });
      await editResponse("Generating voice…").catch(() => undefined);
    }

    if (existingAfk) await args.onWelcomeBack?.(existingAfk);

    const settings = await getSettings(args.user.id, args.guildId);
    const history = args.adminChat
      ? []
      : await getHistory(args.user.id, args.guildId, conversationChannelId, settings.vip ? 12 : 5);

    const userName = args.user.globalName ?? args.user.username;
    const serverNickname = args.member?.nickname ?? "None";
    const serverFacts = await getServerFacts(args.channel);
    const startedAt = Date.now();
    const webSearch = await runWebSearchAgent({
      enabled: !args.adminChat,
      ask: async context => {
        let response = "";
        await streamAnswer({
          prompt,
          userName,
          serverNickname,
          guildName: args.guildName ?? "Direct Message",
          serverFacts,
          settings,
          history,
          messageTimestamp: args.messageTimestamp ?? Date.now(),
          adminChatActionEnabled: args.adminChat,
          reminderActionEnabled: !args.adminChat && hasReminderIntent(prompt)
            && !hasScheduleMessageIntent(prompt) && !hasPollIntent(prompt) && !hasTimerIntent(prompt),
          pollActionEnabled: !args.adminChat && Boolean(args.guildId) && hasPollIntent(prompt),
          timerActionEnabled: !args.adminChat && hasTimerIntent(prompt),
          scheduledMessageActionEnabled: !args.adminChat && Boolean(args.guildId) && hasScheduleMessageIntent(prompt),
          ttsActionEnabled: !args.adminChat && hasTtsIntent(prompt),
          imageGenerationActionEnabled: !args.adminChat && hasImageGenerationIntent(prompt),
          rockPaperScissorsActionEnabled: !args.adminChat && hasRockPaperScissorsIntent(prompt),
          ticTacToeActionEnabled: !args.adminChat && hasTicTacToeIntent(prompt),
          webSearchActionEnabled: context.availableProviders.length > 0,
          webSearchAvailableProviders: context.availableProviders,
          webSearchFeedback: context.feedback,
          onDelta: text => {
            response += text;
            streamingEditor.push(text);
          },
          onProviderRetry: async remainingAttempts => {
            response = "";
            await streamingEditor.reset(remainingAttempts > 0 ? "Retrying with another AI provider…" : "The AI provider failed.");
          },
        });
        return response;
      },
      search: (provider, query) => searchWeb(provider, query, {
        apiKey: provider === "brave" ? config.braveSearchApiKey : config.exaApiKey,
      }),
      onSearchStart: () => streamingEditor.reset("Searching the web…"),
    });
    await streamingEditor.finish();
    let answer = webSearch.answer;

    const afkCommand = args.adminChat ? null : parseSetAfkCommand(answer);
    const reminderCommand = args.adminChat ? null : parseSetReminderCommand(answer);
    const pollCommand = args.adminChat ? null : parseCreatePollCommand(answer);
    const timerCommand = args.adminChat ? null : parseSetTimerCommand(answer);
    const scheduledMessageCommand = args.adminChat ? null : parseScheduleMessageCommand(answer);
    const avatarCommand = args.adminChat ? null : parseShowAvatarCommand(answer);
    const imageCommand = args.adminChat ? null : parseGenerateImageCommand(answer);
    const rockPaperScissorsCommand = !args.adminChat && hasRockPaperScissorsIntent(prompt)
      ? parseRockPaperScissorsCommand(answer)
      : null;
    const ticTacToeCommand = args.adminChat ? null : parseTicTacToeCommand(answer);
    const samSpeakCommand = args.adminChat ? null : parseSamSpeakCommand(answer);

    const channelManagementCommand = args.adminChat ? parseChannelManagementCommand(answer) : null;
    const hasToolAction = Boolean(
      afkCommand
      || reminderCommand
      || pollCommand
      || timerCommand
      || scheduledMessageCommand
      || avatarCommand
      || imageCommand
      || rockPaperScissorsCommand
      || ticTacToeCommand
      || samSpeakCommand
      || channelManagementCommand,
    );
    if (webSearch.results.length && !hasToolAction) {
      answer = `${answer}${formatWebSearchSources(webSearch.results)}`;
    }

    let actionResponseHandled = false;

    if (channelManagementCommand) {
      const guild = "guild" in args.channel && args.channel.guild ? args.channel.guild : null;
      if (!guild) {
        answer = "This admin action can only be used in a server channel.";
      } else {
        const result = await executeChannelManagementCommand(guild, channelManagementCommand);
        answer = result.message;
        actionResponseHandled = true;
        await editResponse(answer).catch(() => undefined);
      }
    }

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

    if (pollCommand) {
      if (!args.guildId || !isSendableTextChannel(args.channel)) {
        answer = "Polls can only be created in a server text channel.";
      } else {
        const delaySeconds = pollCommand.when === "now" ? 0 : parseScheduleDuration(pollCommand.when);
        if (delaySeconds === null) {
          answer = "I couldn't schedule that poll. Use a delay up to 30 days, such as 2h or 1d.";
        } else {
          const pollId = await createPoll({
            guildId: args.guildId,
            channelId: args.channelId,
            creatorId: args.user.id,
            question: pollCommand.question,
            options: pollCommand.options,
            scheduledAt: Date.now() + delaySeconds * 1000,
          });
          if (delaySeconds === 0) {
            const poll = await getPoll(pollId);
            if (!poll) throw new Error("I couldn't load the poll I just created.");
            const message = await args.channel.send(await buildPollPayload(poll));
            await publishPoll(pollId, message.id);
            answer = "Poll posted.";
          } else {
            answer = `Poll scheduled for <t:${Math.floor((Date.now() + delaySeconds * 1000) / 1000)}:F> (<t:${Math.floor((Date.now() + delaySeconds * 1000) / 1000)}:R>).`;
          }
        }
      }
      await editResponse(answer).catch(() => undefined);
      actionResponseHandled = true;
    }

    if (timerCommand) {
      const seconds = parseScheduleDuration(timerCommand.duration);
      if (seconds === null) {
        answer = "Timers need a positive duration up to 30 days, such as 10m or 2h.";
      } else {
        const dueAt = Date.now() + seconds * 1000;
        await createTimer({ channelId: args.channelId, creatorId: args.user.id, label: timerCommand.label, dueAt });
        answer = `Timer set for **${timerCommand.label}** — <t:${Math.floor(dueAt / 1000)}:R> (ends <t:${Math.floor(dueAt / 1000)}:t>).`;
      }
      await editResponse(answer).catch(() => undefined);
      actionResponseHandled = true;
    }

    if (scheduledMessageCommand) {
      const seconds = parseScheduleDuration(scheduledMessageCommand.duration);
      if (!args.guildId || seconds === null) {
        answer = !args.guildId ? "Scheduled messages can only be posted in a server channel." : "Schedule messages up to 30 days ahead, such as 2h or 1d.";
      } else {
        const scheduledAt = Date.now() + seconds * 1000;
        const id = await createScheduledPost({ guildId: args.guildId, channelId: args.channelId, creatorId: args.user.id, content: scheduledMessageCommand.message, scheduledAt });
        answer = `Message scheduled for <t:${Math.floor(scheduledAt / 1000)}:F> (<t:${Math.floor(scheduledAt / 1000)}:R>). Scheduled message #${id}.`;
      }
      await editResponse(answer).catch(() => undefined);
      actionResponseHandled = true;
    }

    if (samSpeakCommand) {
      const reservation = voiceReservation ?? reserveVoiceMessage({ channel: args.channel, channelId: args.channelId });
      if (!voiceReservation) await editResponse("Generating voice…").catch(() => undefined);
      const sent = await reservation.complete(samSpeakCommand.text);
      answer = sent ? "🔊 Sent a voice message!" : "I couldn't send the voice message in this channel.";
      await editResponse(answer).catch(() => undefined);
      actionResponseHandled = true;
    }

    if (imageCommand) {
      if (!args.guildId) {
        answer = "Image generation is only available in a Discord server, not in direct messages.";
        await editResponse(answer).catch(() => undefined);
        actionResponseHandled = true;
      } else {
        await editResponse("Generating image…").catch(() => undefined);
        try {
          const generated = await generateGuildImage(args.guildId, imageCommand.prompt);
          answer = `Generated image: ${imageCommand.prompt}`;
          await placeholder.edit({
            content: "Here is your generated image.",
            files: [{ attachment: generated.buffer, name: `chromix-image.${generated.extension}` }],
            allowedMentions: { parse: [], repliedUser: false },
          });
          actionResponseHandled = true;
        } catch (error) {
          answer = error instanceof Error ? error.message : "Image generation failed. Please try again.";
          await editResponse(answer).catch(() => undefined);
          actionResponseHandled = true;
        }
      }
    }

    if (avatarCommand) {
      answer = "Here is the avatar you asked for.";
      if (args.onAvatar) {
        await args.onAvatar(avatarCommand.target, placeholder);
        actionResponseHandled = true;
      }
    }

    if (rockPaperScissorsCommand) {
      answer = "Started a game of Rock, Paper, Scissors.";
      if (args.onRockPaperScissors) {
        await args.onRockPaperScissors(placeholder);
        actionResponseHandled = true;
      }
    }

    if (ticTacToeCommand) {
      answer = "Started a game of Tic-Tac-Toe.";
      if (args.onTicTacToe) {
        await args.onTicTacToe(placeholder);
        actionResponseHandled = true;
      }
    }

    if (!actionResponseHandled) {
      const chunks = splitDiscordMessage(answer);
      const editMessage = editResponse;
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
    if (!args.adminChat) {
      await addHistory(args.user.id, args.guildId, conversationChannelId, { role: "user", content: prompt }, args.sourceMessageId, args.referencedMessageId);
      await addHistory(args.user.id, args.guildId, conversationChannelId, { role: "assistant", content: answer }, placeholder.id);
    }
  } finally {
    voiceReservation?.cancel();
    activePrompts.delete(key);
  }
}
