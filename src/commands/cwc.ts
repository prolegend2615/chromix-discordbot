import { EmbedBuilder } from "discord.js";
import {
  clearSlot,
  createWorkspaceZip,
  formatCwcSize,
  getActiveSlot,
  getUserWorkspaces,
  listSlotFiles,
  MAX_CWC_SLOTS,
  MAX_FILES_PER_SLOT,
  renameSlot,
  setActiveSlot,
} from "../services/cwc.js";
import { getSettings } from "../services/settings.js";

export interface CwcCommandReply {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: { attachment: Buffer; name: string }[];
  ephemeral?: boolean;
  allowedMentions?: { repliedUser?: boolean; parse?: Array<"users" | "roles" | "everyone"> };
}

/** Discord-independent context so the command can be driven by tests and both surfaces. */
export interface CwcCommandContext {
  userId: string;
  guildId?: string;
  ephemeral: boolean;
  reply: (payload: CwcCommandReply) => Promise<unknown>;
}

export interface CwcCommandOptions {
  slot?: number;
  name?: string;
}

export interface CwcPrefixInvocation extends CwcCommandOptions {
  subcommand: string;
}

/** Parses `c.cwc ...` into a subcommand, or null when the message is not a CWC command. */
export function parseCwcPrefixInvocation(content: string, prefix = "c."): CwcPrefixInvocation | null {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${escapedPrefix}cwc(?:\\s|$)`, "i").test(content.trim())) return null;
  const args = content.trim().slice(`${prefix}cwc`.length).trim().split(/\s+/u).filter(Boolean);
  const subcommand = (args[0] ?? "list").toLowerCase();
  const slot = args[1] && /^\d+$/u.test(args[1]) ? Number(args[1]) : undefined;
  const name = subcommand === "rename" ? args.slice(2).join(" ").trim() || undefined : undefined;
  return { subcommand, slot, name };
}

function inlineCode(value: string) {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

export async function handleCwcCommand(
  context: CwcCommandContext,
  subcommand: string,
  options: CwcCommandOptions = {},
) {
  const settings = await getSettings(context.userId, context.guildId);
  if (!settings.vip) throw new Error("CWC workspaces are a VIP feature. Ask an administrator about VIP access.");
  if (options.slot !== undefined && (!Number.isInteger(options.slot) || options.slot < 1 || options.slot > MAX_CWC_SLOTS)) {
    throw new Error(`Choose a workspace slot from 1 to ${MAX_CWC_SLOTS}.`);
  }
  const sub = subcommand.toLowerCase();

  if (sub === "list" || sub === "slots") {
    const workspaces = await getUserWorkspaces(context.userId);
    const lines = workspaces.map(workspace =>
      `${workspace.isActive ? "●" : "○"} **${workspace.slot}. ${workspace.name}** — ${workspace.fileCount}/${MAX_FILES_PER_SLOT} files · ${formatCwcSize(workspace.totalSizeBytes)}`,
    );
    await context.reply({
      embeds: [new EmbedBuilder().setTitle("Your CWC workspaces").setColor(0x5865F2)
        .setDescription(`${lines.join("\n")}\n\nUse \`/cwc files\` or \`c.cwc files\` to inspect the active workspace.`)
        .setFooter({ text: "Actions apply to the active slot. Max 10 files per slot, 2 MB each." })],
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (sub === "switch") {
    if (options.slot === undefined) throw new Error("Usage: `/cwc switch slot:<1-3>` or `c.cwc switch <slot>`.");
    const active = await setActiveSlot(context.userId, options.slot);
    await context.reply({
      content: `Switched to slot ${active.slot}: **${active.name}**.`,
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (sub === "rename") {
    const name = options.name?.trim();
    if (options.slot === undefined || !name) throw new Error("Usage: `/cwc rename slot:<1-3> name:<new name>` or `c.cwc rename <slot> <new name>`.");
    const updated = await renameSlot(context.userId, options.slot, name);
    await context.reply({
      content: `Renamed slot ${options.slot} to **${updated}**.`,
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (sub === "clear") {
    const target = options.slot ?? (await getActiveSlot(context.userId)).slot;
    const removed = await clearSlot(context.userId, target);
    await context.reply({
      content: `Cleared ${removed} file${removed === 1 ? "" : "s"} from slot ${target}.`,
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (sub === "files") {
    const target = options.slot ?? (await getActiveSlot(context.userId)).slot;
    const files = await listSlotFiles(context.userId, target);
    await context.reply({
      content: files.length
        ? `Files in slot ${target}:\n${files.map(file => `• ${inlineCode(file.relativePath)} — ${file.lineCount} lines, ${formatCwcSize(file.sizeBytes)}`).join("\n")}`
        : `Slot ${target} is empty.`,
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (sub === "download") {
    const target = options.slot ?? (await getActiveSlot(context.userId)).slot;
    const files = await listSlotFiles(context.userId, target);
    if (!files.length) throw new Error("That workspace is empty, so there is nothing to download.");
    const workspace = (await getUserWorkspaces(context.userId)).find(item => item.slot === target);
    const zip = await createWorkspaceZip(context.userId, target);
    await context.reply({
      content: `Slot ${target}${workspace ? ` (${workspace.name})` : ""} — ${files.length} file${files.length === 1 ? "" : "s"}.`,
      files: [{ attachment: zip, name: `chromix-cwc-slot-${target}.zip` }],
      ephemeral: context.ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  throw new Error("Usage: `c.cwc list`, `c.cwc files [slot]`, `c.cwc switch <slot>`, `c.cwc rename <slot> <name>`, `c.cwc clear [slot]`, or `c.cwc download [slot]`.");
}
