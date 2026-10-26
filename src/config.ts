import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID,
  vipAdminId: process.env.VIP_ADMIN_ID ?? "1347611715826876496",
  geminiApiKey: required("GEMINI_API_KEY"),
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  xkiroApiKey: process.env.XKIRO_API_KEY,
  apinexApiKey: process.env.APINEX_API_KEY,
  vyceaiApiKey: process.env.VYCEAI_API_KEY,
  openrouterTtsVoice: process.env.OPENROUTER_TTS_VOICE ?? "flux-alexis-en",
  pollinationsApiKey: process.env.POLLINATIONS_API_KEY,
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
  exaApiKey: process.env.EXA_API_KEY,
};
