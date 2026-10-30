// Copy this file to config.js and fill in your own values.
// Keep config.js private; it is excluded by .gitignore.
module.exports = {
  BASE_URL: "https://YOUR-WEB-DOMAIN",
  REDIRECT_URI: "https://YOUR-WEB-DOMAIN/auth/callback",
  DISCORD_CLIENT_ID: "YOUR_DISCORD_CLIENT_ID",
  DISCORD_CLIENT_SECRET: "YOUR_DISCORD_CLIENT_SECRET",
  BOT_API_URL: "https://YOUR-BOT-API-DOMAIN",
  BOT_API_SECRET: "REPLACE_WITH_A_LONG_RANDOM_SECRET",
  WEBHOOK_URL: "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
  SESSION_SECRET: "REPLACE_WITH_ANOTHER_LONG_RANDOM_SECRET",
  TRUST_PROXY_HOPS: 1,
  DATABASE_PATH: "./data/verification.sqlite"
};
