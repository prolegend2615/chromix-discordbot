import { REST, Routes, SlashCommandBuilder, ChannelType } from "discord.js";
import { config } from "./config.js";

const commands = [
  new SlashCommandBuilder().setName("chat").setDescription("Chat with the AI")
    .addStringOption(option => option.setName("message").setDescription("Your message").setRequired(true)),
  new SlashCommandBuilder().setName("settings").setDescription("Configure your AI settings"),
  new SlashCommandBuilder().setName("help").setDescription("Show bot commands and prompt methods"),
  new SlashCommandBuilder().setName("status").setDescription("Show your current AI settings and quota status"),
  new SlashCommandBuilder().setName("persona").setDescription("Choose or create an AI persona"),
  new SlashCommandBuilder().setName("delete-my-data").setDescription("Delete your stored data while keeping VIP access"),
  new SlashCommandBuilder().setName("remove-vip").setDescription("Remove a user's VIP access")
    .addUserOption(option => option.setName("user").setDescription("User to remove VIP from").setRequired(true)),
  new SlashCommandBuilder().setName("blacklist").setDescription("Blacklist a user from using commands")
    .addUserOption(option => option.setName("user").setDescription("User to blacklist").setRequired(true)),
  new SlashCommandBuilder().setName("unblacklist").setDescription("Remove a user from the blacklist")
    .addUserOption(option => option.setName("user").setDescription("User to remove from blacklist").setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("Clear your history in this channel"),
  new SlashCommandBuilder().setName("reset").setDescription("Clear history and reset your settings"),
  new SlashCommandBuilder().setName("listen").setDescription("Enable the bot in a channel (admin only)")
    .addChannelOption(option => option.setName("channel").setDescription("Channel to enable").addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName("ignore").setDescription("Disable the bot in a channel (admin only)")
    .addChannelOption(option => option.setName("channel").setDescription("Channel to disable").addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName("cwc").setDescription("Manage your Code With Chromix (CWC) workspace (VIP)")
    .addSubcommand(subcommand => subcommand.setName("list").setDescription("List your workspace slots"))
    .addSubcommand(subcommand => subcommand.setName("files").setDescription("List files in a workspace slot")
      .addIntegerOption(option => option.setName("slot").setDescription("Slot number (defaults to the active slot)").setMinValue(1).setMaxValue(3)))
    .addSubcommand(subcommand => subcommand.setName("switch").setDescription("Switch the active workspace slot")
      .addIntegerOption(option => option.setName("slot").setDescription("Slot number").setMinValue(1).setMaxValue(3).setRequired(true)))
    .addSubcommand(subcommand => subcommand.setName("rename").setDescription("Rename a workspace slot")
      .addIntegerOption(option => option.setName("slot").setDescription("Slot number").setMinValue(1).setMaxValue(3).setRequired(true))
      .addStringOption(option => option.setName("name").setDescription("New slot name").setMaxLength(32).setRequired(true)))
    .addSubcommand(subcommand => subcommand.setName("clear").setDescription("Delete all files in a workspace slot")
      .addIntegerOption(option => option.setName("slot").setDescription("Slot number (defaults to the active slot)").setMinValue(1).setMaxValue(3)))
    .addSubcommand(subcommand => subcommand.setName("download").setDescription("Download a workspace slot as a zip")
      .addIntegerOption(option => option.setName("slot").setDescription("Slot number (defaults to the active slot)").setMinValue(1).setMaxValue(3))),
].map(command => command.toJSON());

const rest = new REST().setToken(config.discordToken);
const route = config.discordGuildId
  ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
  : Routes.applicationCommands(config.discordClientId);
await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} application commands.`);
