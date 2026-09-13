import type { Message } from "discord.js";

const EDIT_INTERVAL_MS = 1200;
const MAX_MESSAGE_LENGTH = 1900;

export async function streamToDiscord(
  placeholder: Message,
  produce: (onDelta: (text: string) => void) => Promise<void>,
  editMessage: (content: string) => Promise<unknown> = content => placeholder.edit(content),
): Promise<string> {
  let accumulated = "";
  let lastSent = "";
  let renderChain = Promise.resolve();
  const render = (final = false) => {
    renderChain = renderChain.then(async () => {
      if (!final && accumulated === lastSent) return;
      const text = accumulated || "Thinking…";
      const display = final ? text : `${text} ▌`;
      await editMessage(display.slice(0, MAX_MESSAGE_LENGTH));
      lastSent = accumulated;
    });
    return renderChain;
  };
  const timer = setInterval(() => void render().catch(() => undefined), EDIT_INTERVAL_MS);
  try {
    await produce(text => { accumulated += text; });
  } finally {
    clearInterval(timer);
    await render(true);
  }
  return accumulated;
}
