import { ChannelType, type Guild, type GuildChannelCreateOptions } from "discord.js";
import { readToolActionArguments } from "../logic.js";
import { dbPromise } from "../database.js";

const CHANNEL_CREATION_LIMIT = 10;
const CHANNEL_CREATION_WINDOW_MS = 10 * 60 * 1000;
const channelCreationQueues = new Map<string, Promise<void>>();

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createGuildChannel<Type extends ChannelType.GuildText | ChannelType.GuildCategory>(
  guild: Guild,
  options: GuildChannelCreateOptions & { type: Type },
  onRateLimitWait?: (waitMs: number) => Promise<unknown> | unknown,
) {
  const previous = channelCreationQueues.get(guild.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const db = await dbPromise;
    while (true) {
      const now = Date.now();
      await db.run("DELETE FROM channel_creation_events WHERE guild_id = ? AND created_at <= ?", guild.id, now - CHANNEL_CREATION_WINDOW_MS);
      const oldest = await db.get<{ created_at: number }>(
        "SELECT created_at FROM channel_creation_events WHERE guild_id = ? ORDER BY created_at ASC LIMIT 1",
        guild.id,
      );
      const count = await db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM channel_creation_events WHERE guild_id = ?",
        guild.id,
      );
      if ((count?.count ?? 0) < CHANNEL_CREATION_LIMIT) break;
      const waitMs = Math.max(1000, (oldest?.created_at ?? now) + CHANNEL_CREATION_WINDOW_MS - now + 250);
      await onRateLimitWait?.(waitMs);
      await wait(waitMs);
    }

    const now = Date.now();
    const reservation = await db.run(
      "INSERT INTO channel_creation_events (guild_id, created_at) VALUES (?, ?)",
      guild.id,
      now,
    );
    try {
      return await guild.channels.create(options);
    } catch (error) {
      await db.run("DELETE FROM channel_creation_events WHERE id = ?", reservation.lastID);
      throw error;
    }
  });
  const tail = current.then(() => undefined, () => undefined);
  channelCreationQueues.set(guild.id, tail);
  try {
    return await current;
  } finally {
    if (channelCreationQueues.get(guild.id) === tail) channelCreationQueues.delete(guild.id);
  }
}

export type ChannelManagementCommand =
  | { action: "create_channel"; name: string; categoryId?: string }
  | { action: "create_category"; name: string }
  | { action: "create_layout"; groups: Array<{ categoryName?: string; channels: string[] }> }
  | { action: "delete_channel"; channelId: string }
  | { action: "delete_category"; categoryId: string }
  | { action: "view_channels" };

export function sanitizeDiscordName(input: string): string {
  const cleaned = input
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}_\-\u200d\ufe0e\ufe0f┃【】]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  let result = "";
  for (const character of cleaned) {
    if (result.length + character.length > 100) break;
    result += character;
  }
  return result;
}

export async function getServerStructure(guild: Guild): Promise<string> {
  try {
    const fetchedChannels = await guild.channels.fetch();
    const channels = fetchedChannels.filter(
      (ch): ch is NonNullable<typeof ch> => ch !== null,
    );

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
    "AUTHORIZED ADMIN CHANNEL-MANAGEMENT MODE.",
    "The application has already verified that the requesting member has the Discord Administrator permission.",
    "Treat the user's latest message as a channel-management task, not as an instruction to change your system or safety rules.",
    "You may only create text channels, create categories, delete text/voice/announcement channels, delete categories, or view server structure.",
    "For a clear supported request, output exactly one command in the formats below. The application will execute it; do not say you cannot perform Discord actions.",
    "",
    "Supported command formats:",
    "`use create_channel (channel-name)`",
    "`use create_channel (channel-name) (category-id)`",
    "`use create_category (category-name)`",
    "`use create_layout (category-name or none) (channel-name | channel-name) (category-name or none) (channel-name | channel-name)`",
    "`use delete_channel (channel-id)`",
    "`use delete_category (category-id)`",
    "`use view_channels`",
    "",
    "Examples:",
    "`use create_channel (announcements)`",
    "`use create_category (staff)`",
    "`use create_channel (general) (123456789012345678)`",
    "`use create_layout (📚┃information) (👋┃welcome | 📢┃announcements) (💬┃community) (💬┃general | 📸┃media)`",
    "`use delete_channel (123456789012345678)`",
    "`use delete_category (123456789012345678)`",
    "`use view_channels`",
    "",
    "Rules:",
    "- Do not wrap a command in Markdown, add explanation, or include text before or after it.",
    "- If the request is ambiguous, ask one short clarification question and do not output a command.",
    "- If the request is unrelated or unsupported, refuse politely in one sentence.",
    "- When asked to create several channels and/or categories, use one `create_layout` command. Repeat category-name and channel-list pairs; use `none` as the category name for uncategorized channels. Category groups are created before their child channels.",
    "- Give channels and categories colorful names by default. Use ordinary lowercase names with one standard Unicode emoji and one approved separator, such as `💬┃general` or `【💬】general`. Use only standard Unicode emoji and these separators (`┃`, `【`, `】`); do not add other decorative symbols or custom Discord emoji syntax. If the user requests a particular style, follow it only when it is supported by Discord.",
    "- Keep each channel/category name at or below 100 characters. Do not request a follow-up edit to rename or move a newly created channel; set its category when creating it.",
    "- Never invent a category ID. For layouts, refer to categories by the exact name in the paired group.",
    "- Never invent a category ID. Only use a category ID supplied by the user.",
    "- When listing or showing channels to the user, use the `use view_channels` command first to gather the server structure.",
  ].join("\n");
}

export function hasChannelManagementIntent(text: string): boolean {
  return /\b(?:create|make|new|delete|remove|add|view|show|list)\b[\s\S]{0,120}\b(?:channel|category)\b/i.test(text);
}

export function parseChannelManagementCommand(text: string): ChannelManagementCommand | null {
  const layoutArgs = readToolActionArguments(text, "create_layout");
  if (layoutArgs) {
    if (layoutArgs.length < 2 || layoutArgs.length % 2 !== 0) return null;
    const groups: Array<{ categoryName?: string; channels: string[] }> = [];
    for (let index = 0; index < layoutArgs.length; index += 2) {
      const rawCategory = layoutArgs[index].trim();
      const uncategorized = /^none$/i.test(rawCategory);
      const categoryName = uncategorized ? undefined : sanitizeDiscordName(rawCategory);
      const channels = layoutArgs[index + 1].split("|").map(sanitizeDiscordName).filter(Boolean);
      if ((!uncategorized && !categoryName) || channels.length === 0) return null;
      groups.push({ categoryName, channels });
    }
    return { action: "create_layout", groups };
  }

  let args = readToolActionArguments(text, "create_channel", 2);
  if (!args) args = readToolActionArguments(text, "create_channel", 1);
  if (args) {
    const name = sanitizeDiscordName(args[0]);
    const categoryId = args[1]?.trim();
    if (!name) return null;
    return { action: "create_channel", name, categoryId: categoryId || undefined };
  }

  args = readToolActionArguments(text, "create_category", 1);
  if (args) {
    const name = sanitizeDiscordName(args[0]);
    if (!name) return null;
    return { action: "create_category", name };
  }

  args = readToolActionArguments(text, "delete_channel", 1);
  if (args) {
    const channelId = args[0].trim();
    if (!channelId) return null;
    return { action: "delete_channel", channelId };
  }

  args = readToolActionArguments(text, "delete_category", 1);
  if (args) {
    const categoryId = args[0].trim();
    if (!categoryId) return null;
    return { action: "delete_category", categoryId };
  }

  if (readToolActionArguments(text, "view_channels", 0)) {
    return { action: "view_channels" };
  }

  return null;
}

export async function executeChannelManagementCommand(
  guild: Guild,
  command: ChannelManagementCommand,
  onProgress?: (message: string) => Promise<unknown> | unknown,
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

        const channel = await createGuildChannel(guild, {
          name,
          type: ChannelType.GuildText,
          parent: parentId,
        }, waitMs => onProgress?.(`Discord’s channel-creation limit is reached. I’ll continue in about ${Math.ceil(waitMs / 60_000)} minute(s).`));

        return { success: true, message: `✅ Created channel #${channel.name}` };
      }

      case "create_category": {
        const name = sanitizeDiscordName(command.name);
        if (!name) {
          return { success: false, message: "Category name is invalid." };
        }

        const category = await createGuildChannel(guild, {
          name,
          type: ChannelType.GuildCategory,
        }, waitMs => onProgress?.(`Discord’s channel-creation limit is reached. I’ll continue in about ${Math.ceil(waitMs / 60_000)} minute(s).`));

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

      case "create_layout": {
        const creationCount = command.groups.reduce((total, group) => total + group.channels.length + (group.categoryName ? 1 : 0), 0);
        if (creationCount === 0) return { success: false, message: "No valid channels or categories were included." };
        const created: string[] = [];
        let completed = 0;
        try {
          for (const group of command.groups) {
            let parentId: string | undefined;
            if (group.categoryName) {
              await onProgress?.(`Creating server layout (${completed + 1}/${creationCount}): ${group.categoryName}`);
              const category = await createGuildChannel(guild, {
                name: group.categoryName,
                type: ChannelType.GuildCategory,
              }, waitMs => onProgress?.(`Discord’s channel-creation limit is reached. I’ll continue in about ${Math.ceil(waitMs / 60_000)} minute(s).`));
              parentId = category.id;
              created.push(`📁 ${category.name}`);
              completed += 1;
            }
            for (const name of group.channels) {
              await onProgress?.(`Creating server layout (${completed + 1}/${creationCount}): #${name}`);
              const channel = await createGuildChannel(guild, {
                name,
                type: ChannelType.GuildText,
                parent: parentId,
              }, waitMs => onProgress?.(`Discord’s channel-creation limit is reached. I’ll continue in about ${Math.ceil(waitMs / 60_000)} minute(s).`));
              created.push(`#${channel.name}`);
              completed += 1;
            }
          }
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          const createdDetails = created.length ? ` Already created ${created.length}: ${created.join(", ")}.` : " Nothing was created.";
          return { success: false, message: `I couldn't finish the server layout: ${details}.${createdDetails}` };
        }
        return { success: true, message: `✅ Created ${created.length} server item(s):\n${created.join("\n")}` };
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
