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
