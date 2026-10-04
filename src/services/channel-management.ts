import type { Guild, TextChannel, CategoryChannel } from "discord.js";
import { ChannelType } from "discord.js";

export type ChannelManagementCommand =
  | { action: "create_channel"; name: string; categoryId?: string }
  | { action: "create_category"; name: string }
  | { action: "delete_channel"; channelId: string }
  | { action: "delete_category"; categoryId: string };

/**
 * Detects if the user wants the AI to manage channels or categories.
 * Looks for keywords like "create channel", "delete channel", "create category", etc.
 */
export function hasChannelManagementIntent(text: string): boolean {
  return /\b(?:create|make|new|delete|remove|add)\b[\s\S]{0,100}\b(?:channel|category)\b/i.test(text);
}

/**
 * Parses AI action protocols for channel management.
 * Supports:
 *  - `use create_channel (name)`
 *  - `use create_channel (name) (categoryId)`
 *  - `use create_category (name)`
 *  - `use delete_channel (channelId)`
 *  - `use delete_category (categoryId)`
 */
export function parseChannelManagementCommand(text: string): ChannelManagementCommand | null {
  // Create channel: use create_channel (name) or use create_channel (name) (categoryId)
  let match = /^\s*use\s+create_channel\s*\(([\s\S]*?)\)\s*(?:\(([\s\S]*?)\))?\s*$/i.exec(text);
  if (match) {
    const name = match[1]?.trim();
    const categoryId = match[2]?.trim();
    if (!name) return null;
    return { action: "create_channel", name, categoryId: categoryId || undefined };
  }

  // Create category: use create_category (name)
  match = /^\s*use\s+create_category\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const name = match[1]?.trim();
    if (!name) return null;
    return { action: "create_category", name };
  }

  // Delete channel: use delete_channel (channelId)
  match = /^\s*use\s+delete_channel\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const channelId = match[1]?.trim();
    if (!channelId) return null;
    return { action: "delete_channel", channelId };
  }

  // Delete category: use delete_category (categoryId)
  match = /^\s*use\s+delete_category\s*\(([\s\S]*?)\)\s*$/i.exec(text);
  if (match) {
    const categoryId = match[1]?.trim();
    if (!categoryId) return null;
    return { action: "delete_category", categoryId };
  }

  return null;
}

/**
 * Executes a channel management command on the Discord guild.
 * Requires admin permissions to execute.
 */
export async function executeChannelManagementCommand(
  guild: Guild,
  command: ChannelManagementCommand,
): Promise<{ success: boolean; message: string }> {
  try {
    switch (command.action) {
      case "create_channel": {
        // Validate name
        if (!command.name || command.name.length === 0 || command.name.length > 100) {
          return { success: false, message: "Channel name must be between 1 and 100 characters." };
        }

        // Check if category exists (if provided)
        let parentId: string | undefined;
        if (command.categoryId) {
          const category = await guild.channels.fetch(command.categoryId).catch(() => null);
          if (!category || category.type !== ChannelType.GuildCategory) {
            return { success: false, message: `Category with ID ${command.categoryId} not found or is not a category.` };
          }
          parentId = command.categoryId;
        }

        // Create the channel
        const channel = await guild.channels.create({
          name: command.name,
          type: ChannelType.GuildText,
          parent: parentId,
        });
        return { success: true, message: `✅ Created text channel: #${channel.name}` };
      }

      case "create_category": {
        // Validate name
        if (!command.name || command.name.length === 0 || command.name.length > 100) {
          return { success: false, message: "Category name must be between 1 and 100 characters." };
        }

        // Create the category
        const category = await guild.channels.create({
          name: command.name,
          type: ChannelType.GuildCategory,
        });
        return { success: true, message: `✅ Created category: ${category.name}` };
      }

      case "delete_channel": {
        const channel = await guild.channels.fetch(command.channelId).catch(() => null);
        if (!channel) {
          return { success: false, message: `Channel with ID ${command.channelId} not found.` };
        }
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) {
          return { success: false, message: "Can only delete text or voice channels." };
        }

        const channelName = "name" in channel ? channel.name : "Unknown";
        await channel.delete();
        return { success: true, message: `✅ Deleted channel: #${channelName}` };
      }

      case "delete_category": {
        const category = await guild.channels.fetch(command.categoryId).catch(() => null);
        if (!category) {
          return { success: false, message: `Category with ID ${command.categoryId} not found.` };
        }
        if (category.type !== ChannelType.GuildCategory) {
          return { success: false, message: "Can only delete categories." };
        }

        const categoryName = "name" in category ? category.name : "Unknown";
        await category.delete();
        return { success: true, message: `✅ Deleted category: ${categoryName}` };
      }

      default:
        return { success: false, message: "Unknown channel management action." };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to execute channel management action: ${errorMessage}`,
    };
  }
}
