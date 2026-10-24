# Discord AI Bot

An AI-only Discord bot with prefix, slash-command, mention, and reply prompts. It stores settings and history in SQLite. Gemini `gemini-3.6-flash` is the default model; users can choose Gemini, Xkiro, or OpenRouter in `/settings`. If the selected provider fails, Chromix tries other configured providers automatically.

## Setup

1. Copy `.env.example` to `.env` and fill in the values.
2. Add `GEMINI_API_KEY`. `OPENROUTER_API_KEY` enables OpenRouter in `/settings` and as a fallback. `XKIRO_API_KEY` enables Xkiro in `/settings` and as a fallback. Optional `APINEX_API_KEY` and `VYCEAI_API_KEY` enable automatic fallbacks; they are not selectable in `/settings`.
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
- `c.admin <request>` / `c.adminchat <request>` (server administrators; creates and manages text channels and categories)

In admin chat, ask Chromix to build several categories and channels in one prompt. It creates categories first and assigns channels during creation, uses colorful Unicode emoji names such as `💬┃general` by default, and tracks channel-creation calls in SQLite to stay within the configured limit of 10 creations per rolling 10 minutes. If that limit is full, it shows a status and waits for the next slot.

Administrators can also start giveaways with `c.admin`, for example: `start a giveaway for a Nitro gift, ending in 1 day, with 2 winners; only members with the VIP role can enter`. Chromix posts a styled embed with join/leave buttons, a live entry count, Discord end-time timestamps, optional role eligibility, and an automatic winner draw. Giveaway entries and end times are stored in SQLite and survive bot restarts.

## AI actions (through chat)

- **AFK** — ask the bot to set your AFK status, e.g. `set my afk status, reason: done for the day`.
- **Reminder** — ask the bot to remind you later, e.g. `remind me in 15 minutes to check the oven`.
- **Polls** — ask for a poll with 2–10 choices, either now or after a delay, e.g. `make a poll now: pizza or tacos` or `schedule a poll in 2 hours: movie night or game night`.
- **Timers** — ask for a countdown, e.g. `set a 10-minute timer for the oven`. The confirmation uses Discord's relative timestamp format and the bot posts when it ends.
- **Scheduled messages** — ask Chromix to draft and post a message later in the current channel, e.g. `write and schedule an event reminder for tomorrow` or `schedule this announcement in 3 hours: ...`. Delays are limited to 30 days; ambiguous clock times need a timezone.
- **Server details** — ask for member/channel counts, the highest role, or the server owner. These answers come from Discord's guild data.
- **Avatar** — ask the bot to show an avatar or profile picture, e.g. `show me my avatar` or `show the avatar of @user`. To see someone else's avatar, **mention (ping) them** in the message; if you ask for another member's avatar without pinging anyone, the bot will ask you to ping them.
- **Rock, Paper, Scissors** — ask the bot to play, e.g. `@Chromix let's play rock paper scissors`. Choose a button to play a round; the score stays visible until you press **End Game**. Only the person who started the game can make moves.
- **Tic-Tac-Toe** — ask the bot to play, e.g. `@Chromix let's play tic tac toe`. You play X and Chromix plays O on a 3×3 button board. Only the person who started the game can make moves.

## Flux TTS voice replies

Set `OPENROUTER_API_KEY` to enable Deepgram Flux TTS voice replies through OpenRouter. Set `OPENROUTER_TTS_VOICE` to choose a supported Flux voice; the default is `flux-alexis-en`. Voice requests in the same channel are reserved and processed in FIFO order. The bot displays “Generating voice…” while waiting, tries Flux first, and automatically falls back to the local SAM WAV voice if Flux or delivery fails.

## AI image generation

Ask the AI to create an image in a server chat, for example `c.chat create an image of a watercolor fox under a starry sky`. The AI turns the request into a visual prompt and generates one image through Pollinations. Image generation is disabled in direct messages.

Set `POLLINATIONS_API_KEY` in the bot's environment using a secret from [Pollinations](https://enter.pollinations.ai/keys). Do not commit the key. Each Discord server shares a limit of 3 image-generation requests in any rolling 15-minute window and 50 images per UTC day. Requests are recorded in the existing SQLite database so limits persist across restarts. Failed provider calls still count toward the 15-minute request limit; only successful generations count toward the daily image cap.
