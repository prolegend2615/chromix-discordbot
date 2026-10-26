import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, ModalBuilder,
  MessageFlags, PermissionsBitField, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Message, type MessageCreateOptions, type StringSelectMenuInteraction, type User,
} from "discord.js";
import { config } from "./config.js";
import { runChat } from "./services/chat.js";
import { clearHistory, getHistory } from "./services/history.js";
import { deleteUserDataExceptVip, getSettings, isUserBlacklisted, PERSONAS, resetSettings, setUserBlacklist, setVip, updateRoleplaySettings, updateSettings, ROLEPLAY_TRAITS, RESPONSE_STYLES, type Persona, type Provider, type ResponseLength, type ResponseStyle, type RoleplayIntensity, type RoleplayRelationship, type RoleplayTrait, type SafetyLevel } from "./services/settings.js";
import { getAttachmentUploadStatus, getPromptStatus, setChannelRule } from "./services/access.js";
import { getAverageResponseTime } from "./services/metrics.js";
import { clearAfkStatus, formatAfkDuration, formatAfkMention, getAfkStatus, type AfkStatus } from "./services/afk.js";
import { extractMentionId, formatReminderDuration, isTransientNetworkError, MODELS, userFacingProviderError } from "./logic.js";
import { deleteReminder, getDueReminders, getUserReminders, deleteUserReminder, markReminderDeliveryFailure } from "./services/reminders.js";
import { handleRockPaperScissorsButton, startRockPaperScissorsGame } from "./services/rock-paper-scissors.js";
import { handleTicTacToeButton, startTicTacToeGame } from "./services/tic-tac-toe.js";
import { buildPollPayload, cancelPoll, getDuePolls, getPoll, getUserPolls, publishPoll, votePoll, markPollDeliveryFailure } from "./services/polls.js";
import { deleteTimer, deleteScheduledPost, deleteUserTimer, getDueScheduledPosts, getDueTimers, getUserScheduledPosts, getUserTimers, markScheduledPostSent, markScheduledPostDeliveryFailure, markTimerDeliveryFailure, parseScheduleDuration } from "./services/scheduled-actions.js";
import { buildGiveawayPayload, drawGiveaway, getDueGiveaways, getGiveaway, joinGiveaway, leaveGiveaway, markGiveawayEnded } from "./services/giveaways.js";
import { cancelGiveaway, canManageGiveaways, editGiveaway, rerollGiveaway, setGiveawayManagerRole } from "./services/giveaways.js";
import { getGuildConfig, renderCommunityMessage, updateGuildConfig } from "./services/guild-config.js";
import { conversationChannelId, createChat, deleteChat, getCurrentChat, listChats, renameChat, selectChat } from "./services/chats.js";
import { applyRoleMenuSelection, attachRoleMenuMessage, buildRoleMenuPayload, createRoleMenu, getRoleMenu, type CommunityRoleOption } from "./services/community.js";
import { diagnoseChannelActionPermission, executeChannelManagementCommand, type ChannelManagementCommand } from "./services/channel-management.js";
import { addPersonalMemory, deletePersonalMemory, listPersonalMemories } from "./services/memory.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
const prefix = "c.";
const VIP_ADMIN_ID = config.vipAdminId;
const VIP_MIN_DURATION_SECONDS = 60;
const VIP_MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;
let reminderSweepInProgress = false;
let scheduledActionSweepInProgress = false;
const pendingAdminActions = new Map<string, { guildId: string; userId: string; command: ChannelManagementCommand; expiresAt: number }>();

function isPrefixCommand(content: string, name: string): boolean {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${name}(?:\\s|$)`, "i").test(content.trim());
}

function parseVipDuration(value: string): number | null {
  const normalized = value.trim().replace(/^\((.*)\)$/u, "$1").replace(/^(?:vip\s+)?(?:for\s+)?/i, "").trim();
  const match = /^(\d+)\s*(s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hr|hour(?:s)?|d|day(?:s)?|w|week(?:s)?)$/i.exec(normalized);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const secondsPerUnit = unit.startsWith("s") ? 1
    : unit.startsWith("m") ? 60
      : unit.startsWith("h") ? 3600
        : unit.startsWith("d") ? 86400
          : 604800;
  const duration = amount * secondsPerUnit;
  return duration >= VIP_MIN_DURATION_SECONDS && duration <= VIP_MAX_DURATION_SECONDS ? duration : null;
}

async function sendChannelMessage(channelId: string, payload: string | MessageCreateOptions) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel) || typeof channel.send !== "function") throw new Error("Channel is unavailable or cannot receive messages.");
  return (channel.send as (value: string | MessageCreateOptions) => Promise<Message>).call(channel, payload);
}

async function deliverDueScheduledActions() {
  if (scheduledActionSweepInProgress) return;
  scheduledActionSweepInProgress = true;
  try {
    for (const poll of await getDuePolls()) {
      try {
        const message = await sendChannelMessage(poll.channel_id, await buildPollPayload(poll));
        await publishPoll(poll.id, message.id);
      } catch (error) {
        await markPollDeliveryFailure(poll, error).catch(() => undefined);
        console.error(`Scheduled poll ${poll.id} could not be posted; it will be retried.`, error);
      }
    }
    for (const post of await getDueScheduledPosts()) {
      try {
        await sendChannelMessage(post.channel_id, { content: post.content, allowedMentions: { parse: [] } });
        await markScheduledPostSent(post.id);
      } catch (error) {
        await markScheduledPostDeliveryFailure(post, error).catch(() => undefined);
        console.error(`Scheduled message ${post.id} could not be posted; it will be retried.`, error);
      }
    }
    for (const timer of await getDueTimers()) {
      try {
        await sendChannelMessage(timer.channel_id, {
          content: `⏰ Timer finished: **${timer.label}** (set to end at <t:${Math.floor(timer.due_at / 1000)}:t>).`,
          allowedMentions: { parse: [] },
        });
        await deleteTimer(timer.id);
      } catch (error) {
        await markTimerDeliveryFailure(timer, error).catch(() => undefined);
        console.error(`Timer ${timer.id} could not be delivered; it will be retried.`, error);
      }
    }
    for (const dueGiveaway of await getDueGiveaways()) {
      try {
        const giveaway = await drawGiveaway(dueGiveaway.id);
        if (!giveaway) continue;
        const resultPayload = await buildGiveawayPayload(giveaway);
        let updated = false;
        if (giveaway.message_id) {
          try {
            const channel = await client.channels.fetch(giveaway.channel_id);
            if (channel && "messages" in channel) {
              const message = await channel.messages.fetch(giveaway.message_id);
              await message.edit(resultPayload);
              updated = true;
            }
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (code !== 10008) throw error;
            // A removed original post is replaced with a final announcement below.
          }
        }
        if (!updated) await sendChannelMessage(giveaway.channel_id, resultPayload);
        await markGiveawayEnded(giveaway.id);
      } catch (error) {
        console.error(`Giveaway ${dueGiveaway.id} could not be finalized; it will be retried.`, error);
      }
    }
  } catch (error) {
    console.error("Scheduled action sweep failed.", error);
  } finally {
    scheduledActionSweepInProgress = false;
  }
}

async function deliverDueReminders() {
  if (reminderSweepInProgress) return;
  reminderSweepInProgress = true;
  try {
    const dueReminders = await getDueReminders();
    for (const reminder of dueReminders) {
      try {
        const channel = await client.channels.fetch(reminder.channel_id);
        if (!channel || !("send" in channel) || typeof channel.send !== "function") {
          console.error(`Reminder ${reminder.id} could not find a sendable channel; it will be retried.`);
          continue;
        }
        await (channel.send as (payload: {
          content: string;
          allowedMentions: { users: string[] };
        }) => Promise<unknown>).call(channel, {
          content: `<@${reminder.user_id}> ⏰ Reminder: ${reminder.message}`,
          allowedMentions: { users: [reminder.user_id] },
        });
        await deleteReminder(reminder.id);
      } catch (error) {
        await markReminderDeliveryFailure(reminder, error).catch(() => undefined);
        console.error(`Reminder ${reminder.id} could not be delivered; it will be retried.`, error);
      }
    }
  } catch (error) {
    console.error("Reminder scheduler sweep failed.", error);
  } finally {
    reminderSweepInProgress = false;
  }
}

function startReminderScheduler() {
  void deliverDueReminders();
  setInterval(() => void deliverDueReminders(), 15_000);
  void deliverDueScheduledActions();
  setInterval(() => void deliverDueScheduledActions(), 15_000);
}

async function handlePollVote(interaction: StringSelectMenuInteraction) {
  if (await isUserBlacklisted(interaction.user.id)) {
    await interaction.reply({ content: "You are blacklisted and cannot use bot commands.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, , rawId] = interaction.customId.split(":");
  const pollId = Number(rawId);
  const optionIndex = Number(interaction.values[0]);
  if (!Number.isSafeInteger(pollId) || pollId <= 0) throw new Error("That poll could not be found.");
  const poll = await votePoll(pollId, interaction.user.id, optionIndex);
  await interaction.update(await buildPollPayload(poll));
}

async function handleGiveawayButton(interaction: ButtonInteraction) {
  if (await isUserBlacklisted(interaction.user.id)) {
    await interaction.reply({ content: "You are blacklisted and cannot use bot commands.", flags: MessageFlags.Ephemeral });
    return;
  }
  const controlMatch = /^giveaway:control:(end|cancel|reroll):(\d+)$/.exec(interaction.customId);
  if (controlMatch) {
    const controlPermissions = interaction.member && "permissions" in interaction.member ? new PermissionsBitField(typeof interaction.member.permissions === "string" ? BigInt(interaction.member.permissions) : interaction.member.permissions.bitfield) : null;
    if (!interaction.guild || !controlPermissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      await interaction.reply({ content: "You need Manage Channels to use giveaway control buttons.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await canManageGiveaways(interaction.guild.id, interaction.member as import("discord.js").GuildMember))) {
      await interaction.reply({ content: "Only the configured giveaway manager role or an administrator can control this giveaway.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = Number(controlMatch[2]);
    const targetGiveaway = await getGiveaway(id);
    if (!targetGiveaway || targetGiveaway.guild_id !== interaction.guild.id) {
      await interaction.reply({ content: "That giveaway was not found in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    let updated = false;
    if (controlMatch[1] === "end") {
      const drawn = await drawGiveaway(id);
      if (drawn) { await markGiveawayEnded(id); updated = true; }
    } else if (controlMatch[1] === "cancel") updated = await cancelGiveaway(id);
    else updated = Boolean(await rerollGiveaway(id));
    const giveaway = await getGiveaway(id);
    if (!updated || !giveaway || giveaway.guild_id !== interaction.guild.id) {
      await interaction.reply({ content: "That giveaway cannot be changed now.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update(await buildGiveawayPayload(giveaway));
    return;
  }
  const match = /^giveaway:(join|leave):(\d+)$/.exec(interaction.customId);
  const giveawayId = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(giveawayId) || giveawayId <= 0 || !interaction.guild) {
    await interaction.reply({ content: "That giveaway could not be found.", flags: MessageFlags.Ephemeral });
    return;
  }
  const giveaway = await getGiveaway(giveawayId);
  if (!giveaway || giveaway.guild_id !== interaction.guildId) {
    await interaction.reply({ content: "That giveaway could not be found in this server.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (match[1] === "join" && giveaway.required_role_id) {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member?.roles.cache.has(giveaway.required_role_id)) {
      await interaction.reply({ content: `You need the <@&${giveaway.required_role_id}> role to join this giveaway.`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  const result = match[1] === "join"
    ? await joinGiveaway(giveawayId, interaction.user.id)
    : await leaveGiveaway(giveawayId, interaction.user.id);
  if (result === "closed" || result === "missing") {
    await interaction.reply({ content: "This giveaway has ended or is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (result === "already_joined") {
    await interaction.reply({ content: "You’re already entered in this giveaway.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (result === "not_entered") {
    await interaction.reply({ content: "You haven’t joined this giveaway.", flags: MessageFlags.Ephemeral });
    return;
  }
  const currentGiveaway = await getGiveaway(giveawayId);
  if (!currentGiveaway) {
    await interaction.reply({ content: "This giveaway is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update(await buildGiveawayPayload(currentGiveaway));
}

function isAdmin(member: { permissions: PermissionsBitField } | null) {
  return Boolean(member?.permissions.has(PermissionsBitField.Flags.Administrator));
}

function hasAdminActionPermission(member: { permissions: PermissionsBitField } | null) {
  return Boolean(member?.permissions.has(PermissionsBitField.Flags.Administrator) || member?.permissions.has(PermissionsBitField.Flags.ManageChannels) || member?.permissions.has(PermissionsBitField.Flags.ManageRoles) || member?.permissions.has(PermissionsBitField.Flags.ManageGuild));
}

type CommandReplyPayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: unknown;
  ephemeral?: boolean;
  allowedMentions?: { repliedUser?: boolean; parse?: Array<"users" | "roles" | "everyone"> };
};

type CommandContext = {
  userId: string;
  guildId?: string;
  channelId: string;
  member: { permissions: PermissionsBitField } | null;
  ephemeral: boolean;
  recipient?: User;
  targetChannel?: { id: string; toString(): string };
  reply: (payload: CommandReplyPayload) => Promise<unknown>;
};

function messageCommandContext(message: Message, overrides: Partial<Pick<CommandContext, "recipient" | "targetChannel">> = {}): CommandContext {
  return {
    userId: message.author.id,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    member: message.member,
    ephemeral: false,
    ...overrides,
    reply: payload => {
      const { ephemeral: _ephemeral, ...messagePayload } = payload;
      return message.reply(messagePayload as Parameters<Message["reply"]>[0]);
    },
  };
}

function interactionCommandContext(interaction: ChatInputCommandInteraction, overrides: Partial<Pick<CommandContext, "recipient" | "targetChannel">> = {}): CommandContext {
  const member = interaction.member;
  const permissions = member && "permissions" in member ? member.permissions : null;
  const permissionBits = typeof permissions === "string"
    ? BigInt(permissions)
    : permissions?.bitfield;
  return {
    userId: interaction.user.id,
    guildId: interaction.guildId ?? undefined,
    channelId: interaction.channelId,
    member: permissionBits === undefined ? null : { permissions: new PermissionsBitField(permissionBits) },
    ephemeral: true,
    ...overrides,
    reply: payload => {
      const { ephemeral, ...messagePayload } = payload;
      return interaction.reply({ ...messagePayload, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
    },
  };
}

async function handleClearCommand(context: CommandContext, reset: boolean) {
  await clearHistory(context.userId, context.guildId, context.channelId);
  if (reset) await resetSettings(context.userId, context.guildId);
  await context.reply({
    content: reset ? "Your history was cleared and your AI settings were reset." : "Your history in this channel has been cleared.",
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

async function handleStatusCommand(context: CommandContext) {
  const settings = await getSettings(context.userId, context.guildId);
  const quota = await getPromptStatus(context.userId);
  const attachmentQuota = await getAttachmentUploadStatus(context.userId, Boolean(settings.vip));
  const averageResponseMs = await getAverageResponseTime(context.userId);
  const persona = settings.persona === "Custom" ? `Custom: ${settings.custom_persona || "not configured"}` : settings.persona;
  await context.reply({
    embeds: [new EmbedBuilder().setTitle("Your AI status").setColor(0x57F287).addFields(
      { name: "Provider / model", value: `${providerLabel(settings.provider)} • \`${settings.model}\`` },
      { name: "Persona", value: persona },
      { name: "Response length", value: settings.response_length, inline: true },
      { name: "History", value: `${settings.vip ? 50 : 5} messages${settings.vip ? " (VIP)" : ""}`, inline: true },
      { name: "Response style", value: settings.response_style, inline: true },
      { name: "VIP access", value: !settings.vip ? "Not active" : settings.vip_expires_at ? `Active until <t:${Math.floor(settings.vip_expires_at / 1000)}:R>` : "Active (no expiry)", inline: true },
      { name: "Attachment uploads", value: `${attachmentQuota.remaining}/${attachmentQuota.limit} left this hour${settings.vip ? " • VIP: 25 MB/file, 50 MB/message" : ""}${attachmentQuota.resetsInMs ? ` • next reset <t:${Math.floor((Date.now() + attachmentQuota.resetsInMs) / 1000)}:R>` : ""}`, inline: true },
      { name: "Average response", value: `${averageResponseMs} ms`, inline: true },
      { name: "Prompt quota", value: `${quota.remaining}/8 remaining this minute${quota.cooldownSeconds ? ` • cooldown: ${quota.cooldownSeconds}s` : ""}` },
      { name: "Quota violations", value: `${quota.violations} in the last ${Math.round(quota.windowMs / 1000)}s`, inline: true },
    )],
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

async function handlePersonaCommand(context: CommandContext) {
  const settings = await getSettings(context.userId, context.guildId);
  await context.reply({
    content: settings.vip
      ? "Choose a preset, or use Custom to write a personalized persona for VIP access."
      : "Choose a preset or select Custom to describe how the AI should act. Custom personas are VIP-only.",
    components: await personaMenu(context.userId, context.guildId),
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

async function handleDeleteMyDataCommand(context: CommandContext) {
  await deleteUserDataExceptVip(context.userId);
  await context.reply({
    content: "Your saved conversations and chat slots, prompts, attachment upload history, reminders, timers, polls, scheduled messages, response metrics, quota violations, and personal settings were deleted. Your VIP status was kept.",
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

async function handleVipCommand(context: CommandContext, grant: boolean, durationSeconds?: number) {
  if (context.userId !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
  if (!context.recipient) throw new Error("Mention a user to give or remove VIP access.");
  if (grant) {
    if (!durationSeconds || durationSeconds < VIP_MIN_DURATION_SECONDS || durationSeconds > VIP_MAX_DURATION_SECONDS) {
      throw new Error("Usage: `c.givevip @user 7d` (or `c.givevip @user vip for 7d`). Choose a duration from 1 minute to 365 days.");
    }
    const expiresAt = Date.now() + durationSeconds * 1000;
    await setVip(context.recipient.id, true, expiresAt);
    const savedSettings = await getSettings(context.recipient.id);
    if (!savedSettings.vip) throw new Error("VIP was not saved. Please try again and check the bot database.");
    await context.reply({
      content: `✅ VIP granted to **${context.recipient.username}** until <t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>).`,
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }
  await setVip(context.recipient.id, false);
  const savedSettings = await getSettings(context.recipient.id);
  if (savedSettings.vip) throw new Error("VIP could not be removed. Please try again and check the bot database.");
  await context.reply({
    content: `✅ VIP removed from **${context.recipient.username}**.`,
    ephemeral: context.ephemeral,
    allowedMentions: { parse: [], repliedUser: false },
  });
}

async function handleBlacklistCommand(context: CommandContext, blacklist: boolean) {
  if (context.userId !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
  if (!context.recipient) throw new Error("Mention a user to blacklist or unblacklist.");
  await setUserBlacklist(context.recipient.id, blacklist);
  await context.reply({
    content: blacklist
      ? `${context.recipient} has been blacklisted and cannot be used with the bot.`
      : `${context.recipient} has been removed from the blacklist.`,
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

async function handleChannelRuleCommand(context: CommandContext, rule: "listen" | "ignore") {
  if (!context.guildId || (!isAdmin(context.member) && !context.member?.permissions.has(PermissionsBitField.Flags.ManageChannels))) throw new Error("You need Manage Channels permission to change channel rules.");
  if (!context.targetChannel) throw new Error("Choose a text channel.");
  await setChannelRule(context.guildId, context.targetChannel.id, rule);
  await context.reply({
    content: `${rule === "listen" ? "Enabled" : "Disabled"} the bot in ${context.targetChannel}.`,
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

type SettingsStep = "persona" | "length" | "style" | "provider" | "model" | "safety" | "prompt";
const ROLEPLAY_RELATIONSHIPS: Array<{ label: string; value: RoleplayRelationship }> = [
  { label: "No fixed relationship", value: "none" },
  { label: "Friend", value: "friend" },
  { label: "Enemy (playful rival)", value: "enemy" },
  { label: "Classmate", value: "classmate" },
  { label: "Little brother", value: "little_brother" },
  { label: "Big brother", value: "big_brother" },
  { label: "Little sister", value: "little_sister" },
  { label: "Big sister", value: "big_sister" },
  { label: "Husband", value: "husband" },
  { label: "Wife", value: "wife" },
];
const ROLEPLAY_INTENSITIES: Array<{ label: string; value: RoleplayIntensity; description: string }> = [
  { label: "Light", value: "light", description: "A little character flavor, mostly normal chat." },
  { label: "Balanced", value: "balanced", description: "Natural roleplay mixed with direct conversation." },
  { label: "Immersive", value: "immersive", description: "Stay in character more often, without long narration." },
];

function parseRoleplayTraits(value: string): RoleplayTrait[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((trait): trait is RoleplayTrait => typeof trait === "string" && (ROLEPLAY_TRAITS as readonly string[]).includes(trait)).slice(0, 3)
      : [];
  } catch { return []; }
}

const SETTINGS_EXPLANATION = [
  "Use these settings to control how Chromix chats in this server.",
  "Choose a value or keep the default, then press Continue.",
].join("\n");

function providerLabel(provider: Provider) {
  return provider === "gemini" ? "Gemini" : provider === "xkiro" ? "Xkiro" : "OpenRouter";
}

function settingsEmbed(step: SettingsStep) {
  const labels: Record<SettingsStep, string> = {
    persona: "Persona",
    length: "chat length",
    style: "response style (VIP)",
    provider: "Provider",
    model: "Model",
    safety: "Safety",
    prompt: "custom instructions",
  };
  return new EmbedBuilder()
    .setTitle("Chromix Settings")
    .setColor(0x5865F2)
    .setDescription(`${SETTINGS_EXPLANATION}\n\nSelect ${labels[step]}.`);
}

function settingsDoneEmbed() {
  return new EmbedBuilder()
    .setTitle("Chromix Settings")
    .setColor(0x57F287)
    .setDescription(`${SETTINGS_EXPLANATION}\n\nSettings saved.`);
}

async function settingsComponents(step: SettingsStep, userId: string, guildId?: string) {
  const settings = await getSettings(userId, guildId);
  const withContinue = (menu: StringSelectMenuBuilder) => [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`settings:continue:${step}`).setLabel("Continue").setStyle(ButtonStyle.Primary),
    ),
  ];
  if (step === "persona") {
    const availablePersonas = settings.vip ? PERSONAS : PERSONAS.filter(value => value !== "Custom");
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:persona").setPlaceholder(`Persona: ${settings.persona}`)
        .addOptions(availablePersonas.map(value => ({ label: value, value, default: value === settings.persona }))),
    );
  }
  if (step === "length") {
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:length").setPlaceholder(`Length: ${settings.response_length}`)
        .addOptions(["Short", "Medium", "Detailed"].map(value => ({ label: value, value, default: value === settings.response_length }))),
    );
  }
  if (step === "style") {
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:style").setPlaceholder(`Style: ${settings.response_style}`)
        .addOptions(RESPONSE_STYLES.map(value => ({ label: value, value, default: value === settings.response_style, description: value === "Natural" ? "Available to everyone" : "VIP response style" }))),
    );
  }
  if (step === "provider") {
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:provider").setPlaceholder(`Provider: ${providerLabel(settings.provider)}`)
        .addOptions([
          { label: "Gemini (default)", value: "gemini", default: settings.provider === "gemini" },
          { label: "Xkiro", value: "xkiro", default: settings.provider === "xkiro" },
          { label: "OpenRouter", value: "openrouter", default: settings.provider === "openrouter" },
        ]),
    );
  }
  if (step === "model") {
    const models = MODELS[settings.provider];
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:model").setPlaceholder(`Model: ${settings.model}`)
        .addOptions(models.map(value => ({ label: value, value, default: value === settings.model }))),
    );
  }
  if (step === "safety") {
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:safety").setPlaceholder(`Safety: ${settings.safety_level}`)
        .addOptions(["Strict", "Balanced", "Relaxed"].map(value => ({ label: value, value, default: value === settings.safety_level }))),
    );
  }
  return withContinue(
    new StringSelectMenuBuilder().setCustomId("settings:prompt").setPlaceholder("Custom instructions")
      .addOptions({ label: "Edit custom instructions", value: "edit" }),
  );
}

async function showSettings(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    embeds: [settingsEmbed("persona")],
    components: await settingsComponents("persona", interaction.user.id, interaction.guildId ?? undefined),
    flags: MessageFlags.Ephemeral,
  });
}

function roleplaySettingsEmbed(settings: Awaited<ReturnType<typeof getSettings>>) {
  const relationship = ROLEPLAY_RELATIONSHIPS.find(item => item.value === settings.rp_relationship)?.label ?? "No fixed relationship";
  const intensity = ROLEPLAY_INTENSITIES.find(item => item.value === settings.rp_intensity)?.label ?? "Balanced";
  const traits = parseRoleplayTraits(settings.rp_traits);
  return new EmbedBuilder()
    .setTitle("Chromix Roleplay Settings")
    .setColor(settings.rp_enabled ? 0x9B59B6 : 0x5865F2)
    .setDescription(`Roleplay is **${settings.rp_enabled ? "enabled" : "disabled"}**. These preferences are private to you and apply across servers and DMs.\n\nChoose a relationship and up to three traits. Roleplay stays SFW and concise.`)
    .addFields(
      { name: "Character name", value: settings.rp_name || "Chromix", inline: true },
      { name: "Relationship", value: relationship, inline: true },
      { name: "Intensity", value: intensity, inline: true },
      { name: "Traits", value: traits.length ? traits.join(", ") : "None selected", inline: false },
    );
}

async function roleplaySettingsComponents(userId: string) {
  const settings = await getSettings(userId);
  const relationshipMenu = new StringSelectMenuBuilder()
    .setCustomId(`rp:${userId}:relationship`).setPlaceholder("Choose relationship")
    .addOptions(ROLEPLAY_RELATIONSHIPS.map(item => ({ label: item.label, value: item.value, default: item.value === settings.rp_relationship })));
  const selectedTraits = parseRoleplayTraits(settings.rp_traits);
  const traitMenu = new StringSelectMenuBuilder()
    .setCustomId(`rp:${userId}:traits`).setPlaceholder("Choose up to 3 traits")
    .setMinValues(0).setMaxValues(3)
    .addOptions(ROLEPLAY_TRAITS.map(value => ({ label: value, value, default: selectedTraits.includes(value) })));
  const intensityMenu = new StringSelectMenuBuilder()
    .setCustomId(`rp:${userId}:intensity`).setPlaceholder(`Intensity: ${settings.rp_intensity}`)
    .addOptions(ROLEPLAY_INTENSITIES.map(item => ({ label: item.label, description: item.description, value: item.value, default: item.value === settings.rp_intensity })));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rp:${userId}:toggle`).setLabel(settings.rp_enabled ? "Turn roleplay off" : "Turn roleplay on").setStyle(settings.rp_enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rp:${userId}:name`).setLabel("Set character name").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rp:${userId}:reset`).setLabel("Reset settings").setStyle(ButtonStyle.Danger),
  );
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(relationshipMenu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(traitMenu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(intensityMenu),
    buttons,
  ];
}

async function showRoleplaySettings(userId: string) {
  const settings = await getSettings(userId);
  const payload = { embeds: [roleplaySettingsEmbed(settings)], components: await roleplaySettingsComponents(userId) };
  const user = await client.users.fetch(userId);
  await user.send(payload);
}

async function handleRoleplaySettingsSelect(interaction: StringSelectMenuInteraction) {
  const [, ownerId, setting] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) throw new Error("Only the person who opened these roleplay settings can change them.");
  const selected = interaction.values;
  if (setting === "relationship") {
    const relationship = selected[0] as RoleplayRelationship;
    if (!ROLEPLAY_RELATIONSHIPS.some(item => item.value === relationship)) throw new Error("That relationship option is not available.");
    await updateRoleplaySettings(ownerId, { rp_relationship: relationship });
  } else if (setting === "traits") {
    if (selected.length > 3 || selected.some(value => !(ROLEPLAY_TRAITS as readonly string[]).includes(value))) throw new Error("Choose up to three available traits.");
    await updateRoleplaySettings(ownerId, { rp_traits: JSON.stringify(selected) });
  } else if (setting === "intensity") {
    const intensity = selected[0] as RoleplayIntensity;
    if (!ROLEPLAY_INTENSITIES.some(item => item.value === intensity)) throw new Error("That intensity option is not available.");
    await updateRoleplaySettings(ownerId, { rp_intensity: intensity });
  } else return;
  const settings = await getSettings(ownerId);
  await interaction.update({ embeds: [roleplaySettingsEmbed(settings)], components: await roleplaySettingsComponents(ownerId) });
}

async function handleRoleplaySettingsButton(interaction: ButtonInteraction) {
  const [, ownerId, action] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) throw new Error("Only the person who opened these roleplay settings can change them.");
  const settings = await getSettings(ownerId);
  if (action === "name") {
    const modal = new ModalBuilder().setCustomId(`rp:${ownerId}:name-modal`).setTitle("Set roleplay character name");
    const input = new TextInputBuilder().setCustomId("rp-name").setLabel("Name Chromix should use").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32).setValue(settings.rp_name).setPlaceholder("Leave blank to use Chromix");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  } else if (action === "toggle") {
    await updateRoleplaySettings(ownerId, { rp_enabled: settings.rp_enabled ? 0 : 1 });
  } else if (action === "reset") {
    await updateRoleplaySettings(ownerId, { rp_enabled: 0, rp_relationship: "none", rp_traits: "[]", rp_intensity: "balanced", rp_name: "" });
  } else return;
  const updated = await getSettings(ownerId);
  await interaction.update({ embeds: [roleplaySettingsEmbed(updated)], components: await roleplaySettingsComponents(ownerId) });
}

async function personaMenu(userId: string, guildId?: string) {
  const settings = await getSettings(userId, guildId);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("settings:persona").setPlaceholder(`Persona: ${settings.persona}`)
      .addOptions((settings.vip ? PERSONAS : PERSONAS.filter(value => value !== "Custom")).map(value => ({ label: value, value, default: value === settings.persona }))),
  )];
}

function helpEmbed() {
  return new EmbedBuilder().setTitle("AI Bot Help").setColor(0x5865F2).setDescription("Chat using `/chat`, `c.chat <message>`, mentioning me, or replying to one of my messages.")
    .addFields(
      { name: "Settings", value: "`/settings` or `c.settings` — configure provider, model, response length, safety, instructions, and persona. `c.rpsettings` opens private SFW roleplay controls, including a custom character name.\n`/persona` — quickly choose or write a custom persona." },
      { name: "History", value: "`/clear` removes history in this channel. When you refer to recent channel context, Chromix can look up up to 20 earlier messages. Thread chats get their own persistent conversation history. `/reset` also resets your settings. `/delete-my-data` removes stored data but keeps VIP." },
      { name: "Limits", value: "8 prompts per minute, with a 5-second cooldown. Attachment analysis allows 3 uploads per rolling hour for free users and 20 for VIP; VIP files can be 25 MB each and 50 MB per message. VIP users receive 50 history messages; others receive 5." },
      { name: "Image generation", value: "Ask me to create an image in a server chat. Each server can generate 3 images every 15 minutes and 50 per UTC day. Image generation is unavailable in DMs." },
      { name: "Games", value: "Ask me to play Rock, Paper, Scissors or Tic-Tac-Toe. In Tic-Tac-Toe, you are X and Chromix is O; choose a square to make a move." },
      { name: "Polls and timers", value: "Ask me to create a poll now or later, or start a countdown timer. Timers show a live Discord relative timestamp and post a notice when they finish." },
      { name: "Scheduled actions", value: "Ask for reminders, timers, polls, or scheduled messages. Use `c.reminders`, `c.timers`, or `c.scheduled` to list your pending actions and `c.cancel reminder|timer|scheduled|poll <id>` to cancel one." },
      { name: "Chat slots", value: "`c.chats` opens separate chat histories. Use its menu to create, switch, rename, or delete chats. Free users get 3 chats per channel; VIP users get 10. `c.summarise` summarizes the current chat and `c.compact` replaces it with a compact summary." },
      { name: "VIP personal features", value: "VIP users can choose response styles in `/settings` or `c.settings`, save cross-server memories with `c.remember`, view them with `c.memories`, delete them with `c.forget <id>`, export chats with `c.export`, and regenerate the previous answer with `c.regenerate`." },
      { name: "Server details", value: "Ask about member and channel counts, the highest role, or the server owner. I use Discord's cached server data; counts can lag until Discord updates the bot." },
      { name: "Server admins", value: "`c.admin <request>` or `c.adminchat <request>` manages channels/categories/roles. Destructive channel actions require confirmation. `c.gw add @role` sets the specific role allowed to create/edit giveaways; `c.gw remove` clears it; `c.gw end <id>`, `c.gw cancel <id>`, `c.gw reroll <id>`, and `c.gw edit (id) (duration) (winners) (prize)` manage giveaways. `c.serverconfig` manages welcome/goodbye messages, verification, selectable role menus, and history retention. `c.listen` and `c.ignore` control bot channels." },
      { name: "All prefix commands", value: "`c.chat`, `c.settings`, `c.rpsettings`, `c.help`, `c.status`, `c.persona`, `c.clear`, `c.reset`, `c.delete-my-data`, `c.chats`, `c.newchat`, `c.summarise`, `c.compact`, `c.regenerate`, `c.remember`, `c.memories`, `c.forget`, `c.export`, `c.reminders`, `c.timers`, `c.scheduled`, `c.cancel`, `c.serverconfig`, `c.privacy`, `c.gw`, `c.listen`, `c.ignore`, `c.admin`, `c.adminchat`, `c.givevip`, `c.remove-vip`, `c.blacklist`, and `c.unblacklist`. Prefix commands are case-insensitive." },
    );
}

function chatMenuEmbed(chats: Awaited<ReturnType<typeof listChats>>["chats"], limit: number) {
  const current = chats[0];
  return new EmbedBuilder().setTitle("Your Chromix chats").setColor(0x5865F2)
    .setDescription(`Current chat: **${current?.name ?? "Main chat"}**\nChoose a chat below. Chats are separate histories and are limited to ${limit}.`)
    .addFields(chats.map(chat => ({ name: `${chat.chat_id === current?.chat_id ? "● " : "○ "}${chat.name}`, value: `Messages stay separate in this chat.`, inline: true })));
}

async function chatMenuComponents(userId: string, guildId: string | undefined, channelId: string) {
  const settings = await getSettings(userId, guildId);
  const { chats, limit } = await listChats(userId, guildId, channelId, Boolean(settings.vip));
  const menu = new StringSelectMenuBuilder().setCustomId(`chats:select:${userId}`).setPlaceholder("Switch chat").addOptions(chats.map(chat => ({ label: chat.name, value: chat.chat_id, default: chat.chat_id === chats[0]?.chat_id })));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`chats:new:${userId}`).setLabel("New chat").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`chats:rename:${userId}`).setLabel("Rename current").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`chats:delete:${userId}`).setLabel("Delete current").setStyle(ButtonStyle.Danger).setDisabled(chats.length <= 1),
  );
  return { chats, limit, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), buttons] };
}

async function showChats(context: CommandContext) {
  const menu = await chatMenuComponents(context.userId, context.guildId, context.channelId);
  await context.reply({ embeds: [chatMenuEmbed(menu.chats, menu.limit)], components: menu.components, ephemeral: context.ephemeral, allowedMentions: { repliedUser: false } });
}

function serverConfigEmbed(configValue: Awaited<ReturnType<typeof getGuildConfig>>) {
  const role = configValue.giveaway_manager_role_name ? `${configValue.giveaway_manager_role_name} (${configValue.giveaway_manager_role_id})` : "Not configured";
  return new EmbedBuilder().setTitle("Chromix server configuration").setColor(0x5865F2)
    .setDescription("Server managers can configure community messages, verification, role menus, giveaway access, and privacy retention here.")
    .addFields(
      { name: "Welcome", value: configValue.welcome_enabled ? `Enabled in <#${configValue.welcome_channel_id}>\n${configValue.welcome_message}` : "Disabled", inline: true },
      { name: "Goodbye", value: configValue.goodbye_enabled ? `Enabled in <#${configValue.goodbye_channel_id}>\n${configValue.goodbye_message}` : "Disabled", inline: true },
      { name: "Verification", value: configValue.verification_enabled ? `Enabled\nRole: <@&${configValue.verification_role_id}>` : "Disabled", inline: true },
      { name: "Giveaway manager role", value: role, inline: false },
      { name: "History retention", value: configValue.retention_days ? `${configValue.retention_days} days` : "Unlimited", inline: true },
    );
}

function serverConfigComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("servercfg:welcome").setLabel("Toggle welcome").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("servercfg:goodbye").setLabel("Toggle goodbye").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("servercfg:verification").setLabel("Toggle verification").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("servercfg:messages").setLabel("Edit messages").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("servercfg:retention").setPlaceholder("Set history retention").addOptions([
      { label: "Unlimited", value: "0" }, { label: "7 days", value: "7" }, { label: "30 days", value: "30" }, { label: "90 days", value: "90" },
    ])),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("servercfg:setverifyrole").setLabel("Choose verification role").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("servercfg:postroles").setLabel("Post role menu").setStyle(ButtonStyle.Success),
    ),
  ];
}

async function showServerConfig(context: CommandContext) {
  if (!context.guildId || (!context.member?.permissions.has(PermissionsBitField.Flags.Administrator) && !context.member?.permissions.has(PermissionsBitField.Flags.ManageGuild))) throw new Error("Only members with Manage Server can open the server configuration panel.");
  const configValue = await getGuildConfig(context.guildId);
  await context.reply({ embeds: [serverConfigEmbed(configValue)], components: serverConfigComponents(), ephemeral: context.ephemeral, allowedMentions: { repliedUser: false } });
}

function afkSetEmbed(reason: string) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("AFK status set")
    .setDescription("✅ I have set your AFK status.")
    .addFields({ name: "Reason", value: reason || "None" })
    .setTimestamp();
}

function reminderSetEmbed(seconds: number, message: string) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Reminder set")
    .setDescription(`⏰ I’ll remind you in **${formatReminderDuration(seconds)}**.`)
    .addFields({ name: "Message", value: message })
    .setTimestamp();
}

function welcomeBackEmbed(displayName: string, status: AfkStatus) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("Welcome back!")
    .setDescription(`👋 Welcome back, **${displayName}**.`)
    .addFields(
      { name: "You were AFK for", value: formatAfkDuration(status.created_at), inline: true },
      { name: "Reason", value: status.reason || "None", inline: true },
    )
    .setTimestamp();
}

function avatarEmbed(user: User): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`${user.displayName}'s avatar`)
    .setImage(user.displayAvatarURL({ size: 1024 }))
    .setTimestamp();
}

async function findUserById(id: string): Promise<User | null> {
  try {
    return await client.users.fetch(id);
  } catch {
    return null;
  }
}

/**
 * Resolves which user's avatar the AI asked for. The target is either a
 * mention tag (<@123>/<@!123>) naming another user, or "me"/"self" for the
 * requester's own avatar. Falls back to the requester when the mention cannot
 * be resolved.
 */
async function resolveAvatarUser(target: string, requester: User): Promise<User> {
  const mentionId = extractMentionId(target);
  if (mentionId) {
    const resolved = await findUserById(mentionId);
    if (resolved) return resolved;
  }
  return requester;
}

async function refreshChatPanel(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const menu = await chatMenuComponents(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId);
  await interaction.update({ embeds: [chatMenuEmbed(menu.chats, menu.limit)], components: menu.components });
}

async function handleChatPanelInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const parts = interaction.customId.split(":");
  const ownerId = parts[2];
  if (ownerId !== interaction.user.id) throw new Error("Only the person who opened this chat panel can use it.");
  if (interaction.isStringSelectMenu()) {
    await selectChat(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId, interaction.values[0]);
    await refreshChatPanel(interaction);
    return;
  }
  const action = parts[1];
  const current = await getCurrentChat(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId);
  if (action === "new") {
    const modal = new ModalBuilder().setCustomId(`chats:new-modal:${ownerId}`).setTitle("New Chromix chat");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("chat-name").setLabel("Chat name").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40).setPlaceholder("Example: Project ideas")));
    await interaction.showModal(modal);
  } else if (action === "rename") {
    const modal = new ModalBuilder().setCustomId(`chats:rename-modal:${ownerId}:${current.chat_id}`).setTitle("Rename Chromix chat");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("chat-name").setLabel("Chat name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40).setValue(current.name)));
    await interaction.showModal(modal);
  } else if (action === "delete") {
    await deleteChat(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId, current.chat_id);
    await refreshChatPanel(interaction);
  }
}

async function handleServerConfigInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const serverPermissions = interaction.member && "permissions" in interaction.member ? new PermissionsBitField(typeof interaction.member.permissions === "string" ? BigInt(interaction.member.permissions) : interaction.member.permissions.bitfield) : null;
  if (!interaction.guildId || (!serverPermissions?.has(PermissionsBitField.Flags.Administrator) && !serverPermissions?.has(PermissionsBitField.Flags.ManageGuild))) {
    throw new Error("Only members with Manage Server can use this panel.");
  }
  const current = await getGuildConfig(interaction.guildId);
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "servercfg:retention") await updateGuildConfig(interaction.guildId, { retention_days: Number(interaction.values[0]) });
    await interaction.update({ embeds: [serverConfigEmbed(await getGuildConfig(interaction.guildId))], components: serverConfigComponents() });
    return;
  }
  const action = interaction.customId.split(":")[1];
  if (action === "setverifyrole") {
    await interaction.showModal(new ModalBuilder().setCustomId("servercfg:verifyrole-modal").setTitle("Verification role").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("role").setLabel("Role mention or role ID").setStyle(TextInputStyle.Short).setRequired(true))));
  } else if (action === "messages") {
    const modal = new ModalBuilder().setCustomId("servercfg:messages-modal").setTitle("Community messages");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("welcome").setLabel("Welcome message ({user}, {mention}, {server})").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1800).setValue(current.welcome_message)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("goodbye").setLabel("Goodbye message ({user}, {mention}, {server})").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1800).setValue(current.goodbye_message)),
    );
    await interaction.showModal(modal);
  } else if (action === "postroles") {
    const modal = new ModalBuilder().setCustomId("servercfg:postroles-modal").setTitle("Post a role menu");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("roles").setLabel("Role ID or mention = label | ...").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800).setPlaceholder("123456789012345678 = Gamer | 234567890123456789 = Artist")));
    await interaction.showModal(modal);
  } else if (["welcome", "goodbye", "verification"].includes(action)) {
    if (action === "verification" && !current.verification_role_id) throw new Error("Choose a verification role first.");
    const key = action === "welcome" ? "welcome" : action === "goodbye" ? "goodbye" : "verification";
    const enabledKey = `${key}_enabled` as "welcome_enabled" | "goodbye_enabled" | "verification_enabled";
    const channelKey = `${key}_channel_id` as "welcome_channel_id" | "goodbye_channel_id" | "verification_channel_id";
    await updateGuildConfig(interaction.guildId, { [enabledKey]: current[enabledKey] ? 0 : 1, [channelKey]: interaction.channelId });
    await interaction.update({ embeds: [serverConfigEmbed(await getGuildConfig(interaction.guildId))], components: serverConfigComponents() });
  }
}

function parseRoleId(value: string) {
  return /^(?:<@&)?(\d{15,22})>?$/u.exec(value.trim())?.[1] ?? null;
}

async function handleGiveawayCommand(message: Message, args: string[]) {
  if (!message.guildId || !message.guild) throw new Error("Giveaway management only works in a server.");
  const subcommand = args[0]?.toLowerCase() ?? "help";
  const administrator = isAdmin(message.member);
  if (subcommand === "add") {
    if (!administrator && !message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) throw new Error("You need Manage Server to choose the giveaway manager role.");
    const roleInput = args.slice(1).join(" ").replace(/^\((.*)\)$/u, "$1").trim();
    const roleId = parseRoleId(roleInput);
    const role = roleId
      ? await message.guild.roles.fetch(roleId).catch(() => null)
      : message.guild.roles.cache.find(candidate => candidate.name.toLowerCase() === roleInput.toLowerCase()) ?? null;
    if (!role) throw new Error("Usage: `c.gw add @role` — mention the specific role allowed to create and edit giveaways.");
    await setGiveawayManagerRole(message.guildId, role);
    await message.reply({ content: `Giveaway creation and editing now require the **${role.name}** role.`, allowedMentions: { parse: [] } });
    return;
  }
  if (subcommand === "remove") {
    if (!administrator && !message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) throw new Error("You need Manage Server to remove the giveaway manager role.");
    await setGiveawayManagerRole(message.guildId, null);
    await message.reply({ content: "The required giveaway manager role was removed. Configure one with `c.gw add @role`.", allowedMentions: { parse: [] } });
    return;
  }
  const manager = await canManageGiveaways(message.guildId, message.member);
  if (!manager) throw new Error("Only the configured giveaway manager role or an administrator can create or edit giveaways. Configure it with `c.gw add @role`.");
  const editMatch = subcommand === "edit" ? /^edit\s+\((\d+)\)\s+\(([^)]+)\)\s+\((\d+)\)\s+\(([^)]+)\)$/i.exec(args.join(" ")) : null;
  const id = editMatch ? Number(editMatch[1]) : Number(args[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Usage: `c.gw end <id>`, `c.gw cancel <id>`, `c.gw reroll <id>`, or `c.gw edit (id) (duration) (winners) (prize)`.");
  const giveaway = await getGiveaway(id);
  if (!giveaway || giveaway.guild_id !== message.guildId) throw new Error("That giveaway was not found in this server.");
  if (subcommand === "cancel") {
    if (!(await cancelGiveaway(id))) throw new Error("That giveaway cannot be cancelled now.");
  } else if (subcommand === "end") {
    const drawn = await drawGiveaway(id);
    if (!drawn) throw new Error("That giveaway cannot be ended now.");
    await markGiveawayEnded(id);
  } else if (subcommand === "reroll") {
    if (!(await rerollGiveaway(id))) throw new Error("Only ended giveaways can be rerolled.");
  } else if (subcommand === "edit") {
    const seconds = editMatch ? parseScheduleDuration(editMatch[2]) : null;
    if (!editMatch || seconds === null) throw new Error("Usage: `c.gw edit (id) (2h) (2) (new prize)`.");
    await editGiveaway(id, { endsAt: Date.now() + seconds, winnerCount: Number(editMatch[3]), prize: editMatch[4] });
  } else throw new Error("Use `c.gw add @role`, `c.gw remove`, `c.gw end <id>`, `c.gw cancel <id>`, `c.gw reroll <id>`, or `c.gw edit (id) (duration) (winners) (prize)`.");
  const updated = await getGiveaway(id);
  if (updated?.message_id) {
    const channel = await client.channels.fetch(updated.channel_id).catch(() => null);
    if (channel && "messages" in channel) {
      const post = await channel.messages.fetch(updated.message_id).catch(() => null);
      if (post) await post.edit(await buildGiveawayPayload(updated)).catch(() => undefined);
    }
  }
  await message.reply({ content: `Giveaway #${id} updated.`, allowedMentions: { parse: [] } });
}

async function handleScheduledManagementCommand(message: Message, command: "reminders" | "timers" | "scheduled" | "cancel", args: string[]) {
  if (command === "cancel") {
    const kind = args[0]?.toLowerCase();
    const id = Number(args[1]);
    if (!Number.isSafeInteger(id) || id <= 0 || !["reminder", "timer", "scheduled", "poll"].includes(kind)) throw new Error("Usage: `c.cancel reminder|timer|scheduled|poll <id>`.");
    const cancelled = kind === "reminder" ? await deleteUserReminder(id, message.author.id)
      : kind === "timer" ? await deleteUserTimer(id, message.author.id)
        : kind === "scheduled" ? await deleteScheduledPost(id, message.author.id)
          : await cancelPoll(id, message.author.id);
    await message.reply({ content: cancelled ? `Cancelled ${kind} #${id}.` : "That scheduled action was not found or does not belong to you.", allowedMentions: { parse: [] } });
    return;
  }
  const lines: string[] = [];
  if (command === "reminders") {
    const items = await getUserReminders(message.author.id, message.guildId ?? undefined);
    lines.push(...items.map(item => `⏰ Reminder #${item.id} — <t:${Math.floor(item.remind_at / 1000)}:R> — ${item.message}`));
  } else if (command === "timers") {
    const items = await getUserTimers(message.author.id);
    lines.push(...items.map(item => `⏱️ Timer #${item.id} — <t:${Math.floor(item.due_at / 1000)}:R> — ${item.label}`));
  } else {
    const [posts, polls] = await Promise.all([getUserScheduledPosts(message.author.id), getUserPolls(message.author.id)]);
    lines.push(...posts.map(item => `🗓️ Message #${item.id} — <t:${Math.floor(item.scheduled_at / 1000)}:R> — ${item.content}`));
    lines.push(...polls.filter(item => item.status === "scheduled").map(item => `📊 Poll #${item.id} — <t:${Math.floor(item.scheduled_at / 1000)}:R> — ${item.question}`));
  }
  await message.reply({ content: lines.length ? `${command === "reminders" ? "Your reminders" : command === "timers" ? "Your timers" : "Your scheduled actions"}:\n${lines.join("\n")}` : "You have no pending scheduled actions.", allowedMentions: { parse: [] } });
}

async function handlePersonalMemoryCommand(message: Message, command: "remember" | "memories" | "forget", value: string) {
  const settings = await getSettings(message.author.id, message.guildId ?? undefined);
  if (!settings.vip) throw new Error("Personal cross-server memory is a VIP feature.");
  if (command === "remember") {
    const id = await addPersonalMemory(message.author.id, value);
    await message.reply({ content: `✅ Saved personal memory #${id}. It will be available to you across servers and DMs.`, allowedMentions: { parse: [] } });
    return;
  }
  if (command === "forget") {
    const id = Number(value.trim());
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Usage: `c.forget <memory-id>`.");
    const deleted = await deletePersonalMemory(message.author.id, id);
    await message.reply({ content: deleted ? `✅ Deleted personal memory #${id}.` : "That personal memory was not found.", allowedMentions: { parse: [] } });
    return;
  }
  const memories = await listPersonalMemories(message.author.id);
  await message.reply({ content: memories.length ? `Your personal memories:\n${memories.map(item => `**#${item.id}** — ${item.memory}`).join("\n")}` : "You have no saved personal memories. Use `c.remember <fact>` to save one.", allowedMentions: { parse: [] } });
}

async function exportCurrentChat(message: Message) {
  const settings = await getSettings(message.author.id, message.guildId ?? undefined);
  if (!settings.vip) throw new Error("Conversation export is a VIP feature.");
  const baseChannelId = "isThread" in message.channel && message.channel.isThread() ? message.channel.id : message.channelId;
  const currentChat = await getCurrentChat(message.author.id, message.guildId ?? undefined, baseChannelId);
  const history = await getHistory(message.author.id, message.guildId ?? undefined, conversationChannelId(baseChannelId, currentChat.chat_id), 50);
  if (!history.length) throw new Error("This chat has no messages to export.");
  const lines = [`Chromix chat export: ${currentChat.name}`, `Exported: ${new Date().toISOString()}`, "", ...history.map(item => `${item.role === "user" ? "User" : "Chromix"}: ${item.content}`)];
  await message.reply({ content: `✅ Exported **${currentChat.name}** with ${history.length} messages.`, files: [{ attachment: Buffer.from(lines.join("\n"), "utf8"), name: `${currentChat.name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "chromix-chat"}.txt` }], allowedMentions: { parse: [] } });
}

async function sendChatFromMessage(message: Message, prompt: string, referenceId?: string, adminChat = false, compactHistory = false, regenerate = false) {
  await runChat({
    prompt, adminChat, user: message.author, member: message.member, guildId: message.guildId ?? undefined,
    guildName: message.guild?.name, channel: message.channel, channelId: message.channelId,
    attachments: message.attachments.map(attachment => ({
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType ?? null,
      size: attachment.size,
    })),
    messageTimestamp: message.createdTimestamp,
    sourceMessageId: message.id, referencedMessageId: referenceId,
    compactHistory,
    regenerate,
    reply: content => message.reply({ content, allowedMentions: { repliedUser: false } }),
    onAfkSet: (reason, placeholder) => placeholder.edit({
      embeds: [afkSetEmbed(reason)],
      allowedMentions: { parse: [], repliedUser: false },
    }).then(() => undefined),
    onReminderSet: (seconds, reminderMessage, placeholder) => placeholder.edit({
      embeds: [reminderSetEmbed(seconds, reminderMessage)],
      allowedMentions: { parse: [], repliedUser: false },
    }).then(() => undefined),
    onAvatar: async (target, placeholder) => {
      const avatarUser = await resolveAvatarUser(target, message.author);
      await placeholder.edit({
        embeds: [avatarEmbed(avatarUser)],
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
    onRockPaperScissors: placeholder => startRockPaperScissorsGame(placeholder, message.author.id),
    onTicTacToe: placeholder => startTicTacToeGame(placeholder, message.author.id),
    onAdminConfirmation: async (command, placeholder) => {
      if (!message.guildId) return;
      pendingAdminActions.set(placeholder.id, { guildId: message.guildId, userId: message.author.id, command, expiresAt: Date.now() + 60_000 });
      await placeholder.edit({
        content: "⚠️ This will permanently delete a Discord channel or category. Confirm the exact action below.",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`adminconfirm:yes:${placeholder.id}`).setLabel("Confirm deletion").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`adminconfirm:no:${placeholder.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
    onWelcomeBack: status => message.reply({
      embeds: [welcomeBackEmbed(message.author.globalName ?? message.author.username, status)],
      allowedMentions: { parse: [], repliedUser: false },
    }).then(() => undefined),
  });
}

client.once(Events.ClientReady, ready => {
  console.log(`Ready as ${ready.user.tag}`);
  startReminderScheduler();
});

client.on(Events.GuildMemberAdd, async member => {
  const configValue = await getGuildConfig(member.guild.id).catch(() => null);
  if (!configValue) return;
  if (configValue.welcome_enabled && configValue.welcome_channel_id) {
    await sendChannelMessage(configValue.welcome_channel_id, {
      content: renderCommunityMessage(configValue.welcome_message, member.user, member.guild.name),
      allowedMentions: { users: [member.id] },
    }).catch(error => console.error("Welcome message failed.", error));
  }
  if (configValue.verification_enabled && configValue.verification_channel_id && configValue.verification_role_id) {
    await sendChannelMessage(configValue.verification_channel_id, {
      content: `Welcome ${member.user.username}. Click Verify to receive access.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`verify:${member.guild.id}`).setLabel("Verify").setStyle(ButtonStyle.Success))],
      allowedMentions: { parse: [] },
    }).catch(error => console.error("Verification message failed.", error));
  }
});

client.on(Events.GuildMemberRemove, async member => {
  const configValue = await getGuildConfig(member.guild.id).catch(() => null);
  if (!configValue?.goodbye_enabled || !configValue.goodbye_channel_id) return;
  await sendChannelMessage(configValue.goodbye_channel_id, {
    content: renderCommunityMessage(configValue.goodbye_message, member.user, member.guild.name),
    allowedMentions: { parse: [] },
  }).catch(error => console.error("Goodbye message failed.", error));
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (await isUserBlacklisted(message.author.id)) {
    await message.reply({ content: "You are blacklisted and cannot use bot commands.", allowedMentions: { repliedUser: false } }).catch(() => undefined);
    return;
  }
  const content = message.content.trim();
  const command = content.toLowerCase();
  try {
    const previousAfk = await getAfkStatus(message.author.id, message.guildId ?? undefined);
    if (previousAfk) {
      await clearAfkStatus(message.author.id, message.guildId ?? undefined);
      await message.reply({
        embeds: [welcomeBackEmbed(message.author.globalName ?? message.author.username, previousAfk)],
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
    const firstCommand = command.split(/\s+/, 1)[0];
    const adminCommand = [`${prefix}admin`, `${prefix}adminchat`].find(candidate => candidate === firstCommand);
    if (adminCommand) {
      if (!hasAdminActionPermission(message.member)) {
        await message.reply({
          content: "You need Manage Channels, Manage Roles, Manage Server, or Administrator permission for admin actions.",
          allowedMentions: { repliedUser: false },
        });
        return;
      }
      const request = content.slice(adminCommand.length).trim();
      if (!message.guild) {
        await message.reply({
          content: "Admin chat only works in a Discord server.",
          allowedMentions: { repliedUser: false },
        });
        return;
      }
      if (!request) {
        await message.reply({
          content: "Usage: `c.admin <request>` (or `c.adminchat <request>`)",
          allowedMentions: { repliedUser: false },
        });
        return;
      }
      await sendChatFromMessage(message, request, message.reference?.messageId, true);
      return;
    }
    if (isPrefixCommand(content, "chats")) {
      await showChats(messageCommandContext(message));
      return;
    }
    if (isPrefixCommand(content, "newchat")) {
      const settings = await getSettings(message.author.id, message.guildId ?? undefined);
      const name = content.trim().slice(`${prefix}newchat`.length).trim() || "New chat";
      await createChat(message.author.id, message.guildId ?? undefined, message.channelId, Boolean(settings.vip), name);
      await showChats(messageCommandContext(message));
      return;
    }
    if (isPrefixCommand(content, "serverconfig") || isPrefixCommand(content, "privacy")) {
      await showServerConfig(messageCommandContext(message));
      return;
    }
    if (isPrefixCommand(content, "gw")) {
      const args = content.trim().slice(`${prefix}gw`.length).trim().split(/\s+/u).filter(Boolean);
      await handleGiveawayCommand(message, args);
      return;
    }
    if (isPrefixCommand(content, "summarise")) {
      await sendChatFromMessage(message, "Summarise our current chat clearly and briefly, preserving decisions, facts, and open tasks.", message.reference?.messageId);
      return;
    }
    if (isPrefixCommand(content, "compact")) {
      await sendChatFromMessage(message, "Create a compact reference summary of our current chat. Include only useful facts, decisions, preferences, and unresolved tasks.", message.reference?.messageId, false, true);
      return;
    }
    if (isPrefixCommand(content, "regenerate")) {
      await sendChatFromMessage(message, "Regenerate the previous answer with a different helpful response.", message.reference?.messageId, false, false, true);
      return;
    }
    if (isPrefixCommand(content, "export")) { await exportCurrentChat(message); return; }
    if (isPrefixCommand(content, "remember")) {
      await handlePersonalMemoryCommand(message, "remember", content.trim().slice(`${prefix}remember`.length).trim());
      return;
    }
    if (isPrefixCommand(content, "memories")) { await handlePersonalMemoryCommand(message, "memories", ""); return; }
    if (isPrefixCommand(content, "forget")) {
      await handlePersonalMemoryCommand(message, "forget", content.trim().slice(`${prefix}forget`.length).trim());
      return;
    }
    if (isPrefixCommand(content, "reminders")) { await handleScheduledManagementCommand(message, "reminders", []); return; }
    if (isPrefixCommand(content, "timers")) { await handleScheduledManagementCommand(message, "timers", []); return; }
    if (isPrefixCommand(content, "scheduled")) { await handleScheduledManagementCommand(message, "scheduled", []); return; }
    if (isPrefixCommand(content, "cancel")) {
      await handleScheduledManagementCommand(message, "cancel", content.trim().slice(`${prefix}cancel`.length).trim().split(/\s+/u).filter(Boolean));
      return;
    }
    if (isPrefixCommand(content, "chat")) return await sendChatFromMessage(message, content.trim().slice(`${prefix}chat`.length).trim());
    if (command === `${prefix}clear`) {
      await handleClearCommand(messageCommandContext(message), false);
      return;
    }
    if (command === `${prefix}reset`) {
      await handleClearCommand(messageCommandContext(message), true);
      return;
    }
    if (command === `${prefix}help`) {
      await message.reply({ embeds: [helpEmbed()], allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}status`) {
      await handleStatusCommand(messageCommandContext(message));
      return;
    }
    if (command === `${prefix}persona`) {
      await handlePersonaCommand(messageCommandContext(message));
      return;
    }
    if (command === `${prefix}delete-my-data`) {
      await handleDeleteMyDataCommand(messageCommandContext(message));
      return;
    }
    if (isPrefixCommand(content, "givevip")) {
      const durationText = content.slice(firstCommand.length).replace(/<@!?\d+>/gu, " ").trim();
      const durationSeconds = parseVipDuration(durationText);
      await handleVipCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), true, durationSeconds ?? undefined);
      return;
    }
    if (isPrefixCommand(content, "remove-vip")) {
      await handleVipCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), false);
      return;
    }
    if (isPrefixCommand(content, "blacklist")) {
      await handleBlacklistCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), true);
      return;
    }
    if (isPrefixCommand(content, "unblacklist")) {
      await handleBlacklistCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), false);
      return;
    }
    if (command === `${prefix}settings`) {
      await message.reply({
        embeds: [settingsEmbed("persona")],
        components: await settingsComponents("persona", message.author.id, message.guildId ?? undefined),
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    if (command === `${prefix}rpsettings`) {
      const settings = await getSettings(message.author.id);
      const payload = { embeds: [roleplaySettingsEmbed(settings)], components: await roleplaySettingsComponents(message.author.id) };
      if (message.guildId) {
        try {
          await showRoleplaySettings(message.author.id);
          await message.reply({ content: "I sent your roleplay settings in a DM.", allowedMentions: { repliedUser: false } });
        } catch {
          await message.reply({ content: "I couldn't DM you. Enable direct messages from server members, then try `c.rpsettings` again.", allowedMentions: { repliedUser: false } });
        }
      } else {
        await message.reply(payload);
      }
      return;
    }
    if ([`${prefix}listen`, `${prefix}ignore`].includes(command.split(/\s+/)[0])) {
      const rule = command.startsWith(`${prefix}listen`) ? "listen" : "ignore";
      const channel = message.mentions.channels.first() ?? message.channel;
      await handleChannelRuleCommand(messageCommandContext(message, { targetChannel: channel }), rule);
      return;
    }
    if (message.guildId) {
      for (const [userId, user] of message.mentions.users) {
        const afkStatus = await getAfkStatus(userId, message.guildId);
        if (!afkStatus) continue;
        const displayName = user.globalName ?? user.username;
        await message.reply({
          content: formatAfkMention(displayName, afkStatus.reason, afkStatus.created_at),
          allowedMentions: { repliedUser: false },
        });
        return;
      }
    }
    const mentioned = message.mentions.users.has(client.user!.id);
    const replyToBot = message.reference?.messageId
      ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author.id === client.user!.id
      : false;
    if (mentioned || replyToBot) {
      const prompt = mentioned ? content.replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim() : content;
      await sendChatFromMessage(message, prompt, message.reference?.messageId);
    }
  } catch (error) {
    const text = error instanceof Error && /AI provider|rate.?limit|timeout|unavailable|api key|request failed/i.test(error.message)
      ? userFacingProviderError(error)
      : error instanceof Error ? error.message : "Something went wrong while handling that request.";
    await message.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => undefined);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (await isUserBlacklisted(interaction.user.id)) {
        await interaction.reply({ content: "You are blacklisted and cannot use bot commands.", flags: MessageFlags.Ephemeral });
        return;
      }
      const command = interaction.commandName;
      if (command === "settings") return await showSettings(interaction);
      if (command === "help") {
        await interaction.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
        return;
      }
      if (command === "status") {
        await handleStatusCommand(interactionCommandContext(interaction));
        return;
      }
      if (command === "persona") {
        await handlePersonaCommand(interactionCommandContext(interaction));
        return;
      }
      if (command === "delete-my-data") {
        await handleDeleteMyDataCommand(interactionCommandContext(interaction));
        return;
      }
      if (command === "remove-vip") {
        const recipient = interaction.options.getUser("user", true);
        await handleVipCommand(interactionCommandContext(interaction, { recipient }), false);
        return;
      }
      if (command === "blacklist") {
        const recipient = interaction.options.getUser("user", true);
        await handleBlacklistCommand(interactionCommandContext(interaction, { recipient }), true);
        return;
      }
      if (command === "unblacklist") {
        const recipient = interaction.options.getUser("user", true);
        await handleBlacklistCommand(interactionCommandContext(interaction, { recipient }), false);
        return;
      }
      if (command === "clear" || command === "reset") {
        await handleClearCommand(interactionCommandContext(interaction), command === "reset");
        return;
      }
      if (command === "listen" || command === "ignore") {
        const channel = interaction.options.getChannel("channel") ?? interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Choose a text channel.");
        await handleChannelRuleCommand(interactionCommandContext(interaction, { targetChannel: channel }), command);
        return;
      }
      if (command === "chat") {
        const prompt = interaction.options.getString("message", true);
        await interaction.deferReply();
        if (!interaction.channel?.isTextBased()) throw new Error("This channel does not support messages.");
        await runChat({
          prompt,
          user: interaction.user,
          member: interaction.member instanceof Object && "displayName" in interaction.member ? interaction.member : null,
          guildId: interaction.guildId ?? undefined,
          guildName: interaction.guild?.name,
          channel: interaction.channel,
          channelId: interaction.channelId,
          messageTimestamp: interaction.createdTimestamp,
          reply: content => interaction.editReply(content) as Promise<Message>,
          edit: content => interaction.editReply(content),
          onAfkSet: async reason => {
            await interaction.editReply({
              embeds: [afkSetEmbed(reason)],
              allowedMentions: { parse: [], repliedUser: false },
            });
          },
          onReminderSet: async (seconds, reminderMessage) => {
            await interaction.editReply({
              embeds: [reminderSetEmbed(seconds, reminderMessage)],
              allowedMentions: { parse: [], repliedUser: false },
            });
          },
          onAvatar: async target => {
            const avatarUser = await resolveAvatarUser(target, interaction.user);
            await interaction.editReply({
              embeds: [avatarEmbed(avatarUser)],
              allowedMentions: { parse: [], repliedUser: false },
            });
          },
          onRockPaperScissors: placeholder => startRockPaperScissorsGame(placeholder, interaction.user.id),
          onTicTacToe: placeholder => startTicTacToeGame(placeholder, interaction.user.id),
          onWelcomeBack: async status => {
            await interaction.followUp({
              embeds: [welcomeBackEmbed(interaction.user.globalName ?? interaction.user.username, status)],
              allowedMentions: { parse: [], repliedUser: false },
            });
          },
        });
      }
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("chats:select:")) await handleChatPanelInteraction(interaction);
      else if (interaction.customId.startsWith("servercfg:")) await handleServerConfigInteraction(interaction);
      else if (interaction.customId.startsWith("community:roles:")) {
        const menu = await getRoleMenu(Number(interaction.customId.split(":")[2]));
        if (!menu || menu.guild_id !== interaction.guildId || !interaction.guild) throw new Error("That role menu is no longer available.");
        const member = await interaction.guild.members.fetch(interaction.user.id);
        await applyRoleMenuSelection(member, menu.options, interaction.values);
        await interaction.reply({ content: "Your community roles were updated.", flags: MessageFlags.Ephemeral });
      } else if (interaction.customId.startsWith("poll:vote:")) await handlePollVote(interaction);
      else if (interaction.customId.startsWith("rp:")) await handleRoleplaySettingsSelect(interaction);
      else await handleSettingSelect(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("chats:")) {
        await handleChatPanelInteraction(interaction);
        return;
      }
      if (interaction.customId.startsWith("servercfg:")) {
        await handleServerConfigInteraction(interaction);
        return;
      }
      if (interaction.customId.startsWith("adminconfirm:")) {
        const [, decision, messageId] = interaction.customId.split(":");
        const pending = pendingAdminActions.get(messageId);
        pendingAdminActions.delete(messageId);
        if (!pending || pending.expiresAt <= Date.now()) throw new Error("That confirmation expired. Ask Chromix to repeat the destructive action.");
        if (pending.userId !== interaction.user.id || pending.guildId !== interaction.guildId) throw new Error("Only the person who requested this action can confirm it.");
        if (decision === "no") { await interaction.update({ content: "Deletion cancelled.", components: [] }); return; }
        const permissionError = diagnoseChannelActionPermission(pending.command, interaction.member && "permissions" in interaction.member ? new PermissionsBitField(typeof interaction.member.permissions === "string" ? BigInt(interaction.member.permissions) : interaction.member.permissions.bitfield) : null);
        if (permissionError) throw new Error(permissionError);
        if (!interaction.guild) throw new Error("That server is unavailable.");
        const result = await executeChannelManagementCommand(interaction.guild, pending.command);
        await interaction.update({ content: result.message, components: [] });
        return;
      }
      if (interaction.customId.startsWith("verify:")) {
        if (!interaction.guild || interaction.customId !== `verify:${interaction.guild.id}`) throw new Error("That verification button is invalid.");
        const configValue = await getGuildConfig(interaction.guild.id);
        if (!configValue.verification_enabled || !configValue.verification_role_id) throw new Error("Verification is not currently enabled.");
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const role = await interaction.guild.roles.fetch(configValue.verification_role_id);
        if (!role) throw new Error("The verification role no longer exists.");
        await member.roles.add(role, "Chromix verification");
        await interaction.reply({ content: "You are verified.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.customId.startsWith("rp:")) {
        await handleRoleplaySettingsButton(interaction);
        return;
      }
      if (interaction.customId.startsWith("giveaway:")) {
        await handleGiveawayButton(interaction);
        return;
      }
      if (interaction.customId.startsWith("rps:") || interaction.customId.startsWith("ttt:")) {
        if (await isUserBlacklisted(interaction.user.id)) {
          await interaction.reply({ content: "You are blacklisted and cannot use bot commands.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.customId.startsWith("rps:")) await handleRockPaperScissorsButton(interaction);
        else await handleTicTacToeButton(interaction);
        return;
      }
      await handleSettingsContinue(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("chats:new-modal:")) {
      const settings = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
      await createChat(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId ?? "", Boolean(settings.vip), interaction.fields.getTextInputValue("chat-name"));
      const menu = await chatMenuComponents(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId ?? "");
      await interaction.reply({ embeds: [chatMenuEmbed(menu.chats, menu.limit)], components: menu.components, flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("chats:rename-modal:")) {
      const [, , ownerId, chatId] = interaction.customId.split(":");
      if (ownerId !== interaction.user.id) throw new Error("Only the person who opened this chat panel can rename it.");
      await renameChat(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId ?? "", chatId, interaction.fields.getTextInputValue("chat-name"));
      const menu = await chatMenuComponents(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId ?? "");
      await interaction.reply({ embeds: [chatMenuEmbed(menu.chats, menu.limit)], components: menu.components, flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId === "servercfg:messages-modal") {
      if (!interaction.guildId) throw new Error("This panel only works in a server.");
      await updateGuildConfig(interaction.guildId, { welcome_message: interaction.fields.getTextInputValue("welcome").trim() || "Welcome {user}!", goodbye_message: interaction.fields.getTextInputValue("goodbye").trim() || "Goodbye {user}." });
      await interaction.reply({ content: "Community messages saved. Use the panel toggles to enable them.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId === "servercfg:verifyrole-modal") {
      if (!interaction.guildId || !interaction.guild) throw new Error("This panel only works in a server.");
      const roleId = parseRoleId(interaction.fields.getTextInputValue("role"));
      const role = roleId ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
      if (!role) throw new Error("That verification role was not found.");
      if (role.managed || role.position >= (interaction.guild.members.me?.roles.highest.position ?? -1)) throw new Error("Chromix cannot manage that role. Choose a role below the bot's highest role.");
      await updateGuildConfig(interaction.guildId, { verification_role_id: role.id });
      await interaction.reply({ content: `Verification will grant the ${role.name} role.`, flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId === "servercfg:postroles-modal") {
      if (!interaction.guildId || !interaction.guild || !interaction.channel || !("send" in interaction.channel)) throw new Error("This panel only works in a server text channel.");
      const options: CommunityRoleOption[] = interaction.fields.getTextInputValue("roles").split("|").map(value => {
        const [rawId, ...label] = value.split("=");
        return { roleId: parseRoleId(rawId ?? "") ?? "", label: label.join("=").trim() };
      });
      const botHighest = interaction.guild.members.me?.roles.highest.position ?? -1;
      for (const option of options) {
        const role = await interaction.guild.roles.fetch(option.roleId).catch(() => null);
        if (!role || role.managed || role.position >= botHighest) throw new Error("Every role in a role menu must exist and be below the bot's highest role.");
      }
      const menuId = await createRoleMenu({ guildId: interaction.guildId, channelId: interaction.channelId ?? "", options });
      const menu = await getRoleMenu(menuId);
      if (!menu) throw new Error("The role menu could not be created.");
      const post = await interaction.channel.send(buildRoleMenuPayload(menuId, menu.options));
      await attachRoleMenuMessage(menuId, post.id);
      await interaction.reply({ content: "Role menu posted.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId === "settings:prompt-modal") {
      updateSettings(interaction.user.id, interaction.guildId ?? undefined, { custom_system_prompt: interaction.fields.getTextInputValue("custom-prompt").trim() });
      await interaction.reply({ content: "Custom instructions saved.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId === "settings:persona-modal") {
      const customPersona = interaction.fields.getTextInputValue("custom-persona").trim();
      const settings = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
      if (!settings.vip) throw new Error("Custom personas require VIP access.");
      await updateSettings(interaction.user.id, interaction.guildId ?? undefined, customPersona
        ? { persona: "Custom", custom_persona: customPersona }
        : { persona: "Default", custom_persona: "" });
      await interaction.reply({ content: customPersona ? "Custom persona saved." : "Custom persona cleared; using Default.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("rp:") && interaction.customId.endsWith(":name-modal")) {
      const [, ownerId] = interaction.customId.split(":");
      if (interaction.user.id !== ownerId) throw new Error("Only the person who opened these roleplay settings can change them.");
      const name = interaction.fields.getTextInputValue("rp-name")
        .replace(/<[@#][!&]?\d+>/gu, "")
        .replace(/@(everyone|here)/giu, "")
        .replace(/[\u0000-\u001f\u007f]/gu, "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 32);
      await updateRoleplaySettings(ownerId, { rp_name: name });
      await interaction.reply({ content: name ? `Your roleplay character name is now ${name}.` : "Your roleplay character name was reset to Chromix.", flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : "Something went wrong.";
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
  }
});

async function handleSettingSelect(interaction: StringSelectMenuInteraction) {
  const [scope, option] = interaction.customId.split(":");
  if (scope !== "settings") return;
  if (option === "prompt") {
    const current = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
    const modal = new ModalBuilder().setCustomId("settings:prompt-modal").setTitle("Custom AI instructions");
    const input = new TextInputBuilder().setCustomId("custom-prompt").setLabel("How should the AI behave?").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(current.custom_system_prompt).setPlaceholder("Example: Act like a sarcastic space captain.");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return interaction.showModal(modal);
  }
  const selected = interaction.values[0];
  if (option === "persona" && selected === "Custom") {
    const current = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
    if (!current.vip) throw new Error("Custom personas require VIP access.");
    const modal = new ModalBuilder().setCustomId("settings:persona-modal").setTitle("Custom AI persona");
    const input = new TextInputBuilder().setCustomId("custom-persona").setLabel("How should the AI act?").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setValue(current.custom_persona).setPlaceholder("Example: A witty, encouraging space captain.");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return interaction.showModal(modal);
  }

  const settings = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
  if (option === "model" && !(MODELS[settings.provider] as readonly string[]).includes(selected)) {
    throw new Error("That model is not available for the selected provider.");
  }

  let changes: Parameters<typeof updateSettings>[2];
  if (option === "persona") {
    changes = { persona: selected as Persona };
  } else if (option === "length") {
    changes = { response_length: selected as ResponseLength };
  } else if (option === "style") {
    if (!settings.vip) throw new Error("Custom response styles require VIP access.");
    changes = { response_style: selected as ResponseStyle };
  } else if (option === "provider") {
    const provider = selected as Provider;
    changes = { provider, model: MODELS[provider][0] };
  } else if (option === "model") {
    changes = { model: selected };
  } else if (option === "safety") {
    changes = { safety_level: selected as SafetyLevel };
  } else {
    return;
  }

  await updateSettings(interaction.user.id, interaction.guildId ?? undefined, changes);
  await interaction.deferUpdate();
}

async function handleSettingsContinue(interaction: ButtonInteraction) {
  const [scope, action, step] = interaction.customId.split(":");
  if (scope !== "settings" || action !== "continue") return;

  const nextSteps: Record<SettingsStep, SettingsStep | null> = {
    persona: "length",
    length: "style",
    style: "provider",
    provider: "model",
    model: "safety",
    safety: "prompt",
    prompt: null,
  };
  const currentStep = step as SettingsStep;
  if (!Object.prototype.hasOwnProperty.call(nextSteps, currentStep)) return;

  const nextStep = nextSteps[currentStep];
  if (!nextStep) {
    await interaction.update({ embeds: [settingsDoneEmbed()], components: [] });
    return;
  }
  await interaction.update({
    embeds: [settingsEmbed(nextStep)],
    components: await settingsComponents(nextStep, interaction.user.id, interaction.guildId ?? undefined),
  });
}

async function loginWithRetry() {
  let retryDelayMs = 5_000;
  while (true) {
    try {
      await client.login(config.discordToken);
      return;
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        console.error("Discord login failed permanently.", error);
        process.exitCode = 1;
        return;
      }
      const details = error instanceof Error ? error.message : String(error);
      console.error(`Discord connection failed (${details}). Retrying in ${Math.round(retryDelayMs / 1000)}s.`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
    }
  }
}

void loginWithRetry();
