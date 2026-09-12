import type { Message } from "discord.js";

const EDIT_INTERVAL_MS = 1200;
const MAX_MESSAGE_LENGTH = 1900;

export async function streamToDiscord(placeholder: Message, produce: (onDelta: (text: string) => void) => Promise<void>): Promise<string> {
  let accumulated = "";
  let lastSent = "";
  let editing = false;
  const render = async (final = false) => {
    if (editing || (!final && accumulated === lastSent)) return;
    editing = true;
    try {
      const text = accumulated || "Thinking…";
      const display = final ? text : `${text} ▌`;
      await placeholder.edit(display.slice(0, MAX_MESSAGE_LENGTH));
      lastSent = accumulated;
    } finally { editing = false; }
  };
  const timer = setInterval(() => void render(), EDIT_INTERVAL_MS);
  try {
    await produce(text => { accumulated += text; });
  } finally {
    clearInterval(timer);
    await render(true);
  }
  return accumulated;
}
