# Discord AI Bot

An AI-only Discord bot with prefix, slash-command, mention, and reply prompts. It stores settings and history in SQLite. Gemini `gemini-2.5-flash` is the default model; users can select a supported Groq model from `/settings`.

## Setup

1. Copy `.env.example` to `.env` and fill in the values.
2. Add `GEMINI_API_KEY`; add `GROQ_API_KEY` as well if you want Groq selectable.
3. Install dependencies with `npm install`.
4. Register commands with `npm run register`.
5. Start the bot with `npm run dev`.

Enable the **Message Content Intent** in the Discord Developer Portal. Give the bot permissions to View Channels, Send Messages, Embed Links, Read Message History, and Use Application Commands.

## Global AI instructions

Edit [`system-instructions.txt`](system-instructions.txt) to control how the AI behaves for everyone. The bot reads this file for every new prompt, so changes apply immediately without restarting it. Personal custom instructions set through `/settings` are added after these owner instructions and cannot override them.

## Commands

- `c.chat <message>` / `/chat`
- Mention the bot or reply to one of its messages
- `c.settings` / `/settings`
- `/help`, `/status`, `/persona`
- `c.clear` / `/clear`
- `c.reset` / `/reset`
- `/delete-my-data` (keeps VIP access)
- `/give-vip @user` (restricted to the configured owner ID)
- `c.listen [channel]` / `/listen` (server administrators)
- `c.ignore [channel]` / `/ignore` (server administrators)

## AI actions (through chat)

- **AFK** — ask the bot to set your AFK status, e.g. `set my afk status, reason: done for the day`.
- **Reminder** — ask the bot to remind you later, e.g. `remind me in 15 minutes to check the oven`.
- **Avatar** — ask the bot to show an avatar or profile picture, e.g. `show me my avatar` or `show the avatar of @user`. To see someone else's avatar, **mention (ping) them** in the message; if you ask for another member's avatar without pinging anyone, the bot will ask you to ping them.

## Flux TTS voice replies

Set OPENROUTER_API_KEY to enable Deepgram Flux TTS voice replies through OpenRouter. Set OPENROUTER_TTS_VOICE to choose a supported Flux voice; the default is flux-alexis-en. Voice requests in the same channel are reserved and processed in FIFO order. The bot displays “Generating voice…” while waiting, tries Flux first, and automatically falls back to the local SAM WAV voice if Flux or delivery fails.

## AI image generation

Ask the AI to create an image in a server chat, for example `c.chat create an image of a watercolor fox under a starry sky`. The AI turns the request into a visual prompt and generates one image through Pollinations. Image generation is disabled in direct messages.

Set `POLLINATIONS_API_KEY` in the bot's environment using a secret from [Pollinations](https://enter.pollinations.ai/keys). Do not commit the key. Each Discord server shares a limit of 3 image-generation requests in any rolling 15-minute window and 50 images per UTC day. Requests are recorded in the existing SQLite database so limits persist across restarts. Failed provider calls still count toward the 15-minute request limit; only successful generations count toward the daily image cap.
