import {
  ActionRowBuilder, ChannelType, Client, Events, GatewayIntentBits, ModalBuilder,
  PermissionsBitField, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  type ChatInputCommandInteraction, type Message, type StringSelectMenuInteraction,
} from "discord.js";
import { config } from "./config.js";
import { runChat } from "./services/chat.js";
import { clearHistory } from "./services/history.js";
import { deleteUserDataExceptVip, getSettings, isUserBlacklisted, PERSONAS, resetSettings, setUserBlacklist, setVip, updateSettings, type Persona, type Provider, type ResponseLength, type SafetyLevel } from "./services/settings.js";
import { getPromptStatus, setChannelRule } from "./services/access.js";
import { getAverageResponseTime } from "./services/metrics.js";
import { userFacingProviderError } from "./logic.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
const prefix = "c.";
const VIP_ADMIN_ID = "1347611715826876496";
const MODELS = {
  gemini: ["gemini-3.6-flash"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
} as const;

function isAdmin(member: { permissions: PermissionsBitField } | null) {
  return Boolean(member?.permissions.has(PermissionsBitField.Flags.Administrator));
}

type SettingsStep = "persona" | "length" | "provider" | "model" | "safety" | "prompt";

const SETTINGS_EXPLANATION = [
  "Choose how the AI responds in this server.",
  "Set its persona, chat length, provider, model, safety, and custom instructions.",
].join("\n");

function settingsStepContent(step: SettingsStep) {
  const labels: Record<SettingsStep, string> = {
    persona: "Persona",
    length: "chat length",
    provider: "Provider",
    model: "Model",
    safety: "Safety",
    prompt: "custom instructions",
  };
  return `${SETTINGS_EXPLANATION}\n\nSelect ${labels[step]}`;
}

async function settingsComponents(step: SettingsStep, userId: string, guildId?: string) {
  const settings = await getSettings(userId, guildId);
  if (step === "persona") {
    const availablePersonas = settings.vip ? PERSONAS : PERSONAS.filter(value => value !== "Custom");
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("settings:persona").setPlaceholder(`Persona: ${settings.persona}`)
        .addOptions(availablePersonas.map(value => ({ label: value, value, default: value === settings.persona }))),
    )];
  }
  if (step === "length") {
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("settings:length").setPlaceholder(`Length: ${settings.response_length}`)
        .addOptions(["Short", "Medium", "Detailed"].map(value => ({ label: value, value, default: value === settings.response_length }))),
    )];
  }
  if (step === "provider") {
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("settings:provider").setPlaceholder(`Provider: ${settings.provider === "gemini" ? "Gemini" : "Groq"}`)
        .addOptions([
          { label: "Gemini (default)", value: "gemini", default: settings.provider === "gemini" },
          { label: "Groq", value: "groq", default: settings.provider === "groq" },
        ]),
    )];
  }
  if (step === "model") {
    const models = MODELS[settings.provider];
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("settings:model").setPlaceholder(`Model: ${settings.model}`)
        .addOptions(models.map(value => ({ label: value, value, default: value === settings.model }))),
    )];
  }
  if (step === "safety") {
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("settings:safety").setPlaceholder(`Safety: ${settings.safety_level}`)
        .addOptions(["Strict", "Balanced", "Relaxed"].map(value => ({ label: value, value, default: value === settings.safety_level }))),
    )];
  }
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("settings:prompt").setPlaceholder("Custom instructions")
      .addOptions({ label: "Edit custom instructions", value: "edit" }),
  )];
}

async function showSettings(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: settingsStepContent("persona"),
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

async function sendChatFromMessage(message: Message, prompt: string, referenceId?: string) {
  await runChat({
    prompt, user: message.author, member: message.member, guildId: message.guildId ?? undefined,
    guildName: message.guild?.name, channel: message.channel, channelId: message.channelId,
    sourceMessageId: message.id, referencedMessageId: referenceId,
    reply: content => message.reply({ content, allowedMentions: { repliedUser: false } }),
  });
}

client.once(Events.ClientReady, ready => console.log(`Ready as ${ready.user.tag}`));

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (await isUserBlacklisted(message.author.id)) {
    await message.reply({ content: "You are blacklisted and cannot use bot commands.", allowedMentions: { repliedUser: false } }).catch(() => undefined);
    return;
  }
  const content = message.content.trim();
  const command = content.toLowerCase();
  try {
    if (command.startsWith(`${prefix}chat`)) return await sendChatFromMessage(message, content.slice(`${prefix}chat`.length));
    if (command === `${prefix}clear`) {
      clearHistory(message.author.id, message.guildId ?? undefined, message.channelId);
      await message.reply({ content: "Your history in this channel has been cleared.", allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}reset`) {
      clearHistory(message.author.id, message.guildId ?? undefined, message.channelId);
      resetSettings(message.author.id, message.guildId ?? undefined);
      await message.reply({ content: "Your history was cleared and your AI settings were reset.", allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}help`) {
      await message.reply({ embeds: [helpEmbed()], allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}status`) {
      const settings = await getSettings(message.author.id, message.guildId ?? undefined);
      const quota = await getPromptStatus(message.author.id);
      const averageResponseMs = await getAverageResponseTime(message.author.id);
      const persona = settings.persona === "Custom" ? `Custom: ${settings.custom_persona || "not configured"}` : settings.persona;
      await message.reply({ embeds: [new EmbedBuilder().setTitle("Your AI status").setColor(0x57F287).addFields(
        { name: "Provider / model", value: `${settings.provider === "gemini" ? "Gemini" : "Groq"} • \`${settings.model}\`` },
        { name: "Persona", value: persona },
        { name: "Response length", value: settings.response_length, inline: true },
        { name: "History", value: `${settings.vip ? 12 : 5} messages${settings.vip ? " (VIP)" : ""}`, inline: true },
        { name: "Average response", value: `${averageResponseMs} ms`, inline: true },
        { name: "Prompt quota", value: `${quota.remaining}/8 remaining this minute${quota.cooldownSeconds ? ` • cooldown: ${quota.cooldownSeconds}s` : ""}` },
        { name: "Quota violations", value: `${quota.violations} in the last ${Math.round(quota.windowMs / 1000)}s`, inline: true },
      )], allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}persona`) {
      const settings = await getSettings(message.author.id, message.guildId ?? undefined);
      await message.reply({ content: settings.vip ? "Choose a preset, or use Custom to write a personalized persona for VIP access." : "Choose a preset or select Custom to describe how the AI should act. Custom personas are VIP-only.", components: await personaMenu(message.author.id, message.guildId ?? undefined), allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}delete-my-data`) {
      deleteUserDataExceptVip(message.author.id);
      await message.reply({ content: "Your saved conversations, prompt records, and personal settings were deleted. Your VIP status was kept.", allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}give-vip`) {
      if (message.author.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
      const recipient = message.mentions.users.first();
      if (!recipient) throw new Error("Mention a user to give VIP access.");
      await setVip(recipient.id, true);
      await message.reply({ content: `${recipient} now has VIP access. Their history limit is 12 messages.`, allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}remove-vip`) {
      if (message.author.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
      const recipient = message.mentions.users.first();
      if (!recipient) throw new Error("Mention a user to remove VIP access.");
      await setVip(recipient.id, false);
      await message.reply({ content: `${recipient} no longer has VIP access.`, allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}blacklist`) {
      if (message.author.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
      const recipient = message.mentions.users.first();
      if (!recipient) throw new Error("Mention a user to blacklist.");
      await setUserBlacklist(recipient.id, true);
      await message.reply({ content: `${recipient} has been blacklisted and cannot use bot commands.`, allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}unblacklist`) {
      if (message.author.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
      const recipient = message.mentions.users.first();
      if (!recipient) throw new Error("Mention a user to remove from the blacklist.");
      await setUserBlacklist(recipient.id, false);
      await message.reply({ content: `${recipient} has been removed from the blacklist.`, allowedMentions: { repliedUser: false } });
      return;
    }
    if (command === `${prefix}settings`) {
      await message.reply({
        content: settingsStepContent("persona"),
        components: await settingsComponents("persona", message.author.id, message.guildId ?? undefined),
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    if ([`${prefix}listen`, `${prefix}ignore`].includes(command.split(/\s+/)[0])) {
      if (!message.guildId || !isAdmin(message.member)) throw new Error("Only server administrators can change channel rules.");
      const rule = command.startsWith(`${prefix}listen`) ? "listen" : "ignore";
      const channel = message.mentions.channels.first() ?? message.channel;
      setChannelRule(message.guildId, channel.id, rule);
      await message.reply(`${rule === "listen" ? "Enabled" : "Disabled"} the bot in ${channel}.`);
      return;
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
        const settings = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
        const quota = await getPromptStatus(interaction.user.id);
        const averageResponseMs = await getAverageResponseTime(interaction.user.id);
        const persona = settings.persona === "Custom" ? `Custom: ${settings.custom_persona || "not configured"}` : settings.persona;
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Your AI status").setColor(0x57F287).addFields(
          { name: "Provider / model", value: `${settings.provider === "gemini" ? "Gemini" : "Groq"} • \`${settings.model}\`` },
          { name: "Persona", value: persona },
          { name: "Response length", value: settings.response_length, inline: true },
          { name: "History", value: `${settings.vip ? 12 : 5} messages${settings.vip ? " (VIP)" : ""}`, inline: true },
          { name: "Average response", value: `${averageResponseMs} ms`, inline: true },
          { name: "Prompt quota", value: `${quota.remaining}/8 remaining this minute${quota.cooldownSeconds ? ` • cooldown: ${quota.cooldownSeconds}s` : ""}` },
          { name: "Quota violations", value: `${quota.violations} in the last ${Math.round(quota.windowMs / 1000)}s`, inline: true },
        )], ephemeral: true });
        return;
      }
      if (command === "persona") {
        const settings = await getSettings(interaction.user.id, interaction.guildId ?? undefined);
        await interaction.reply({ content: settings.vip ? "Choose a preset, or use Custom to write a personalized persona for VIP access." : "Choose a preset or select Custom to describe how the AI should act. Custom personas are VIP-only.", components: await personaMenu(interaction.user.id, interaction.guildId ?? undefined), ephemeral: true });
        return;
      }
      if (command === "delete-my-data") {
        deleteUserDataExceptVip(interaction.user.id);
        await interaction.reply({ content: "Your saved conversations, prompt records, and personal settings were deleted. Your VIP status was kept.", ephemeral: true });
        return;
      }
      if (command === "give-vip") {
        if (interaction.user.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
        const recipient = interaction.options.getUser("user", true);
        await setVip(recipient.id, true);
        await interaction.reply({ content: `${recipient} now has VIP access. Their history limit is 12 messages.`, ephemeral: true });
        return;
      }
      if (command === "remove-vip") {
        if (interaction.user.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
        const recipient = interaction.options.getUser("user", true);
        await setVip(recipient.id, false);
        await interaction.reply({ content: `${recipient} no longer has VIP access.`, ephemeral: true });
        return;
      }
      if (command === "blacklist") {
        if (interaction.user.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
        const recipient = interaction.options.getUser("user", true);
        await setUserBlacklist(recipient.id, true);
        await interaction.reply({ content: `${recipient} has been blacklisted and cannot use bot commands.`, ephemeral: true });
        return;
      }
      if (command === "unblacklist") {
        if (interaction.user.id !== VIP_ADMIN_ID) throw new Error("You are not allowed to use this command.");
        const recipient = interaction.options.getUser("user", true);
        await setUserBlacklist(recipient.id, false);
        await interaction.reply({ content: `${recipient} has been removed from the blacklist.`, ephemeral: true });
        return;
      }
      if (command === "clear" || command === "reset") {
        clearHistory(interaction.user.id, interaction.guildId ?? undefined, interaction.channelId);
        if (command === "reset") resetSettings(interaction.user.id, interaction.guildId ?? undefined);
        await interaction.reply({ content: command === "clear" ? "Your history in this channel has been cleared." : "Your history was cleared and settings reset.", ephemeral: true });
        return;
      }
      if (command === "listen" || command === "ignore") {
        if (!interaction.guildId || !isAdmin(interaction.member as never)) throw new Error("Only server administrators can change channel rules.");
        const channel = interaction.options.getChannel("channel") ?? interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Choose a text channel.");
        setChannelRule(interaction.guildId, channel.id, command);
        await interaction.reply({ content: `${command === "listen" ? "Enabled" : "Disabled"} the bot in ${channel}.`, ephemeral: true });
        return;
      }
      if (command === "chat") {
        const prompt = interaction.options.getString("message", true);
        await interaction.deferReply();
        if (!interaction.channel?.isTextBased()) throw new Error("This channel does not support messages.");
        await runChat({ prompt, user: interaction.user, member: interaction.member instanceof Object && "displayName" in interaction.member ? interaction.member : null, guildId: interaction.guildId ?? undefined, guildName: interaction.guild?.name, channel: interaction.channel, channelId: interaction.channelId, reply: content => interaction.editReply(content) as Promise<Message> });
      }
    }
    if (interaction.isStringSelectMenu()) await handleSettingSelect(interaction);
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
  let nextStep: SettingsStep;
  if (option === "persona") {
    changes = { persona: selected as Persona };
    nextStep = "length";
  } else if (option === "length") {
    changes = { response_length: selected as ResponseLength };
    nextStep = "provider";
  } else if (option === "provider") {
    const provider = selected as Provider;
    changes = { provider, model: MODELS[provider][0] };
    nextStep = "model";
  } else if (option === "model") {
    changes = { model: selected };
    nextStep = "safety";
  } else if (option === "safety") {
    changes = { safety_level: selected as SafetyLevel };
    nextStep = "prompt";
  } else {
    return;
  }

  await updateSettings(interaction.user.id, interaction.guildId ?? undefined, changes);
  await interaction.update({
    content: settingsStepContent(nextStep),
    components: await settingsComponents(nextStep, interaction.user.id, interaction.guildId ?? undefined),
  });
}

client.login(config.discordToken);
