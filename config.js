import dotenv from 'dotenv';
dotenv.config();

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
export const CLIENT_ID = process.env.CLIENT_ID;
export const GUILD_ID = process.env.GUILD_ID;
export const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];
export const PORT = process.env.PORT || 10000;
export const KEEPALIVE_URL = process.env.KEEPALIVE_URL;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN이 누락되었습니다.');
  process.exit(1);
}
