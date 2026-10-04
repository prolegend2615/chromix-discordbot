import { ChannelType, type Guild } from "discord.js";

export type ChannelManagementCommand =
  | { action: "create_channel"; name: string; categoryId?: string }
  | { action: "create_category"; name: string }
  | { action: "delete_channel"; channelId: string }
  | { action: "delete_category"; categoryId: string }
  | { action: "view_channels" };

export function sanitizeDiscordName(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned.slice(0, 100);
}

export async function getServerStructure(guild: Guild): Promise<string> {
  try {
    const channels = await guild.channels.fetch();

    const categories = channels.filter(ch => ch.type === ChannelType.GuildCategory);
    const uncategorizedTextChannels = channels.filter(ch => ch.type === ChannelType.GuildText && !ch.parentId);
    const uncategorizedVoiceChannels = channels.filter(ch => ch.type === ChannelType.GuildVoice && !ch.parentId);

    let structure = `**Server Structure for ${guild.name}**\n\n`;

    if (categories.size > 0) {
      structure += "**Categories:**\n";
      for (const [, category] of categories) {
        structure += `\n📁 ${category.name} (ID: ${category.id})\n`;

        const channelsInCategory = channels.filter(
          ch => ch.parentId === category.id && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice)
        );

        if (channelsInCategory.size > 0) {
          for (const [, channel] of channelsInCategory) {
            const icon = channel.type === ChannelType.GuildText ? "#" : "🎙️";
            structure += `  ${icon} ${channel.name} (ID: ${channel.id})\n`;
          }
        } else {
          structure += "  (empty)\n";
        }
      }
    }

    if (uncategorizedTextChannels.size > 0) {
      structure += "\n**Text Channels (No Category):**\n";
      for (const [, channel] of uncategorizedTextChannels) {
        structure += `# ${channel.name} (ID: ${channel.id})\n`;
      }
    }

    if (uncategorizedVoiceChannels.size > 0) {
      structure += "\n**Voice Channels (No Category):**\n";
      for (const [, channel] of uncategorizedVoiceChannels) {
        structure += `🎙️ ${channel.name} (ID: ${channel.id})\n`;
      }
    }

    if (categories.size === 0 && uncategorizedTextChannels.size === 0 && uncategorizedVoiceChannels.size === 0) {
      structure += "No channels or categories found.";
    }

    return structure;
  } catch (error) {
    return `Error fetching server structure: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function getAdminChatSystemPrompt(): string {
  return [
    "You are the server admin Discord assistant.",
    "You may ONLY create channels, create categories, delete channels, delete categories, or view server structure.",
    "You may NOT answer normal chat questions in this mode.",
    "You may NOT do anything else except these admin actions.",
    "",
    "Use ONLY these exact tool formats:",
    "`use create_channel (channel-name)`",
    "`use create_channel (channel-name) (category-id)`",
    "`use create_category (category-name)`",
    "`use delete_channel (channel-id)`",
    "`use delete_category (category-id)`",
    "`use view_channels`",
    "",
    "Examples:",
    "`use create_channel (announcements)`",
    "`use create_category (staff)`",
    "`use create_channel (general) (123456789012345678)`",
    "`use delete_channel (123456789012345678)`",
    "`use delete_category (123456789012345678)`",
    "`use view_channels`",
    "",
    "Rules:",
    "- Only use the tool syntax above.",
    "- Do not write a normal conversational reply.",
    "- Do not explain the tool.",
    "- If the request is not clearly about creating, deleting, or viewing channels/categories, refuse politely with one sentence.",
    "- Keep channel names lowercase, simple, and hyphenated.",
    "- When listing or showing channels to the user, use the `use view_channels` command first to gather the server structure.",
  ].join("\n");
}

export function hasChannelManagementIntent(text: string): boolean {
  return /\b(?:create|make|new|delete|remove|add|view|show|list)\b[\s\S]{0,120}\b(?:channel|category)\b/i.test(text);
}

export function parseChannelManagementCommand(text: string): ChannelManagementCommand | null {
  const createChannelMatch = /^\s*use\s+create_channel\s*\(([\s\S]*?)\)\s*(?:\(([\s\S]*?)\))?\s*$/i.exec(text);
  if (createChannelMatch) {
    const name = sanitizeDiscordName(createChannelMatch[1]);
    const categoryId = createChannelMatch[2]?.trim();
    if (!name) return null;
    return { action: "create_channel", name, categoryId: categoryId || undefined };
  }

  const createCategoryMatch = /^\s*use\s+create_category\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (createCategoryMatch) {
    const name = sanitizeDiscordName(createCategoryMatch[1]);
    if (!name) return null;
    return { action: "create_category", name };
  }

  const deleteChannelMatch = /^\s*use\s+delete_channel\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (deleteChannelMatch) {
    const channelId = deleteChannelMatch[1].trim();
    if (!channelId) return null;
    return { action: "delete_channel", channelId };
  }

  const deleteCategoryMatch = /^\s*use\s+delete_category\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (deleteCategoryMatch) {
    const categoryId = deleteCategoryMatch[1].trim();
    if (!categoryId) return null;
    return { action: "delete_category", categoryId };
  }

  if (/^\s*use\s+view_channels\s*$/i.test(text)) {
    return { action: "view_channels" };
  }

  return null;
}

export async function executeChannelManagementCommand(
  guild: Guild,
  command: ChannelManagementCommand,
): Promise<{ success: boolean; message: string }> {
  try {
    if (!guild) {
      return { success: false, message: "This command only works in a Discord server." };
    }

    switch (command.action) {
      case "create_channel": {
        const name = sanitizeDiscordName(command.name);
        if (!name) {
          return { success: false, message: "Channel name is invalid." };
        }

        let parentId: string | undefined;

        if (command.categoryId) {
          const category = await guild.channels.fetch(command.categoryId).catch(() => null);
          if (!category || category.type !== ChannelType.GuildCategory) {
            return { success: false, message: `Category ID ${command.categoryId} was not found.` };
          }
          parentId = category.id;
        }

        const channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: parentId,
        });

        return { success: true, message: `✅ Created channel #${channel.name}` };
      }

      case "create_category": {
        const name = sanitizeDiscordName(command.name);
        if (!name) {
          return { success: false, message: "Category name is invalid." };
        }

        const category = await guild.channels.create({
          name,
          type: ChannelType.GuildCategory,
        });

        return { success: true, message: `✅ Created category ${category.name}` };
      }

      case "delete_channel": {
        const channel = await guild.channels.fetch(command.channelId).catch(() => null);
        if (!channel) {
          return { success: false, message: `Channel ID ${command.channelId} was not found.` };
        }

        if (![ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement].includes(channel.type)) {
          return { success: false, message: "Only text/voice/announcement channels can be deleted here." };
        }

        const channelName = "name" in channel ? channel.name : "unknown";
        await channel.delete();
        return { success: true, message: `✅ Deleted channel #${channelName}` };
      }

      case "delete_category": {
        const category = await guild.channels.fetch(command.categoryId).catch(() => null);
        if (!category) {
          return { success: false, message: `Category ID ${command.categoryId} was not found.` };
        }

        if (category.type !== ChannelType.GuildCategory) {
          return { success: false, message: "That ID is not a category." };
        }

        const categoryName = "name" in category ? category.name : "unknown";
        await category.delete();
        return { success: true, message: `✅ Deleted category ${categoryName}` };
      }

      case "view_channels": {
        return { success: true, message: await getServerStructure(guild) };
      }

      default:
        return { success: false, message: "Unknown admin action." };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Channel management failed: ${message}` };
  }
}
