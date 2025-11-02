// index.js
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { initDB } from './db.js';
import { registerCommands } from './commands.js';
import { handleCommand } from './commandsHandler.js';
import { scheduleDailyLottery } from './lottery.js';
import { DISCORD_TOKEN, PORT, KEEPALIVE_URL } from './config.js';

// -------------------- Discord 클라이언트 초기화 --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// -------------------- 웹 서버 (Render Keep-Alive용) --------------------
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 서버 실행: ${PORT}`));

// -------------------- Discord 이벤트 --------------------
client.once('ready', async () => {
  console.log(`🤖 로그인 완료: ${client.user.tag}`);
  scheduleDailyLottery(client);
});

// -------------------- 명령어 처리 --------------------
client.on('interactionCreate', async (interaction) => {
  await handleCommand(interaction, client);
});

// -------------------- DB 초기화 및 봇 로그인 --------------------
(async () => {
  try {
    await initDB();                 // DB 초기화
    await registerCommands();       // 슬래시 명령어 등록
    await client.login(DISCORD_TOKEN); // 실제 Render 환경에서는 실제 토큰 사용
    console.log('✅ DB 초기화 & 봇 로그인 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();

// -------------------- Keep-Alive (선택) --------------------
// Render나 다른 호스팅 환경에서 주기적으로 호출하면 봇 서버가 잠들지 않음
if (KEEPALIVE_URL) {
  setInterval(() => {
    fetch(KEEPALIVE_URL).catch(() => {});
  }, 5 * 60 * 1000); // 5분마다 호출
}
