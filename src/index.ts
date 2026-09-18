import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, ModalBuilder,
  PermissionsBitField, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Message, type StringSelectMenuInteraction, type User,
} from "discord.js";
import { config } from "./config.js";
import { runChat } from "./services/chat.js";
import { clearHistory } from "./services/history.js";
import { deleteUserDataExceptVip, getSettings, isUserBlacklisted, PERSONAS, resetSettings, setUserBlacklist, setVip, updateSettings, type Persona, type Provider, type ResponseLength, type SafetyLevel } from "./services/settings.js";
import { getPromptStatus, setChannelRule } from "./services/access.js";
import { getAverageResponseTime } from "./services/metrics.js";
import { clearAfkStatus, formatAfkDuration, formatAfkMention, getAfkStatus, type AfkStatus } from "./services/afk.js";
import { formatReminderDuration, isTransientNetworkError, MODELS, userFacingProviderError } from "./logic.js";
import { deleteReminder, getDueReminders } from "./services/reminders.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
const prefix = "c.";
const VIP_ADMIN_ID = "1347611715826876496";
let reminderSweepInProgress = false;

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
}

function isAdmin(member: { permissions: PermissionsBitField } | null) {
  return Boolean(member?.permissions.has(PermissionsBitField.Flags.Administrator));
}

type CommandReplyPayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: unknown;
  ephemeral?: boolean;
  allowedMentions?: { repliedUser?: boolean };
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
    reply: payload => interaction.reply(payload as Parameters<ChatInputCommandInteraction["reply"]>[0]),
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
  const averageResponseMs = await getAverageResponseTime(context.userId);
  const persona = settings.persona === "Custom" ? `Custom: ${settings.custom_persona || "not configured"}` : settings.persona;
  await context.reply({
    embeds: [new EmbedBuilder().setTitle("Your AI status").setColor(0x57F287).addFields(
      { name: "Provider / model", value: `${providerLabel(settings.provider)} • \`${settings.model}\`` },
      { name: "Persona", value: persona },
      { name: "Response length", value: settings.response_length, inline: true },
      { name: "History", value: `${settings.vip ? 12 : 5} messages${settings.vip ? " (VIP)" : ""}`, inline: true },
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
    content: "Your saved conversations, prompt records, response metrics, quota violations, and personal settings were deleted. Your VIP status was kept.",
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

async function handleVipCommand(context: CommandContext, grant: boolean) {
  if (context.userId !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
  if (!context.recipient) throw new Error("Mention a user to give or remove VIP access.");
  await setVip(context.recipient.id, grant);
  await context.reply({
    content: grant
      ? `${context.recipient} now has VIP access. Their history limit is 12 messages.`
      : `${context.recipient} no longer has VIP access.`,
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
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
  if (!context.guildId || !isAdmin(context.member)) throw new Error("Only server administrators can change channel rules.");
  if (!context.targetChannel) throw new Error("Choose a text channel.");
  await setChannelRule(context.guildId, context.targetChannel.id, rule);
  await context.reply({
    content: `${rule === "listen" ? "Enabled" : "Disabled"} the bot in ${context.targetChannel}.`,
    ephemeral: context.ephemeral,
    allowedMentions: { repliedUser: false },
  });
}

type SettingsStep = "persona" | "length" | "provider" | "model" | "safety" | "prompt";

const SETTINGS_EXPLANATION = [
  "Use these settings to control how Chromix chats in this server.",
  "Choose a value or keep the default, then press Continue.",
].join("\n");

function providerLabel(provider: Provider) {
  return provider === "gemini" ? "Gemini" : provider === "groq" ? "Groq" : "OpenRouter";
}

function settingsEmbed(step: SettingsStep) {
  const labels: Record<SettingsStep, string> = {
    persona: "Persona",
    length: "chat length",
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
  if (step === "provider") {
    return withContinue(
      new StringSelectMenuBuilder().setCustomId("settings:provider").setPlaceholder(`Provider: ${providerLabel(settings.provider)}`)
        .addOptions([
          { label: "Gemini (default)", value: "gemini", default: settings.provider === "gemini" },
          { label: "Groq", value: "groq", default: settings.provider === "groq" },
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
    ephemeral: true,
  });
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
      { name: "Settings", value: "`/settings` or `c.settings` — configure provider, model, response length, safety, instructions, and persona.\n`/persona` — quickly choose or write a custom persona." },
      { name: "History", value: "`/clear` removes history in this channel. Thread chats get their own persistent conversation history. `/reset` also resets your settings. `/delete-my-data` removes stored data but keeps VIP." },
      { name: "Limits", value: "8 prompts per minute, with a 5-second cooldown. VIP users receive 12 history messages; others receive 5." },
      { name: "Server admins", value: "`/listen` and `/ignore` control which channels allow the bot." },
    );
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

async function sendChatFromMessage(message: Message, prompt: string, referenceId?: string) {
  await runChat({
    prompt, user: message.author, member: message.member, guildId: message.guildId ?? undefined,
    guildName: message.guild?.name, channel: message.channel, channelId: message.channelId,
    messageTimestamp: message.createdTimestamp,
    sourceMessageId: message.id, referencedMessageId: referenceId,
    reply: content => message.reply({ content, allowedMentions: { repliedUser: false } }),
    onAfkSet: (reason, placeholder) => placeholder.edit({
      embeds: [afkSetEmbed(reason)],
      allowedMentions: { parse: [], repliedUser: false },
    }).then(() => undefined),
    onReminderSet: (seconds, reminderMessage, placeholder) => placeholder.edit({
      embeds: [reminderSetEmbed(seconds, reminderMessage)],
      allowedMentions: { parse: [], repliedUser: false },
    }).then(() => undefined),
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
    if (command.startsWith(`${prefix}chat`)) return await sendChatFromMessage(message, content.slice(`${prefix}chat`.length));
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
    if (command === `${prefix}give-vip`) {
      await handleVipCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), true);
      return;
    }
    if (command === `${prefix}remove-vip`) {
      await handleVipCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), false);
      return;
    }
    if (command === `${prefix}blacklist`) {
      await handleBlacklistCommand(messageCommandContext(message, { recipient: message.mentions.users.first() ?? undefined }), true);
      return;
    }
    if (command === `${prefix}unblacklist`) {
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
        await interaction.reply({ content: "You are blacklisted and cannot use bot commands.", ephemeral: true });
        return;
      }
      const command = interaction.commandName;
      if (command === "settings") return await showSettings(interaction);
      if (command === "help") {
        await interaction.reply({ embeds: [helpEmbed()], ephemeral: true });
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
      if (command === "give-vip") {
        const recipient = interaction.options.getUser("user", true);
        await handleVipCommand(interactionCommandContext(interaction, { recipient }), true);
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
          onWelcomeBack: async status => {
            await interaction.followUp({
              embeds: [welcomeBackEmbed(interaction.user.globalName ?? interaction.user.username, status)],
              allowedMentions: { parse: [], repliedUser: false },
            });
          },
        });
      }
    }
    if (interaction.isStringSelectMenu()) await handleSettingSelect(interaction);
    if (interaction.isButton()) await handleSettingsContinue(interaction);
    if (interaction.isModalSubmit() && interaction.customId === "settings:prompt-modal") {
      updateSettings(interaction.user.id, interaction.guildId ?? undefined, { custom_system_prompt: interaction.fields.getTextInputValue("custom-prompt").trim() });
      await interaction.reply({ content: "Custom instructions saved.", ephemeral: true });
    }
    if (interaction.isModalSubmit() && interaction.customId === "settings:persona-modal") {
      const customPersona = interaction.fields.getTextInputValue("custom-persona").trim();
      const settings = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
      if (!settings.vip) throw new Error("Custom personas require VIP access.");
      await updateSettings(interaction.user.id, interaction.guildId ?? undefined, customPersona
        ? { persona: "Custom", custom_persona: customPersona }
        : { persona: "Default", custom_persona: "" });
      await interaction.reply({ content: customPersona ? "Custom persona saved." : "Custom persona cleared; using Default.", ephemeral: true });
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : "Something went wrong.";
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: text, ephemeral: true });
      else await interaction.reply({ content: text, ephemeral: true });
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
    length: "provider",
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
