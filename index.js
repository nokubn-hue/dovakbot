// ===== 안정화 코드: 가장 상단 =====
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { initDB } from './db.js';
import { registerCommands } from './command.js';
import { handleOtherCommands } from './commandsHandler.js';
import { scheduleDailyLottery } from './lottery.js';

dotenv.config();



// 전역 예외 처리
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

// 환경 변수
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('💥 DISCORD_TOKEN이 설정되지 않았습니다.');
  process.exit(1);
}
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',').map(id => id.trim()) || [];
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL;

// ===== Express 서버 (Keep-alive) =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 서버 실행: ${PORT}`));

if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await fetch(KEEPALIVE_URL);
      console.log('🔁 Keep-alive ping');
    } catch (err) {
      console.warn('⚠️ Keep-alive 실패:', err.message);
    }
  }, 1000 * 60 * 4); // 4분마다 ping
}

// ===== Discord 클라이언트 =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ===== Discord 준비 이벤트 =====
client.once('ready', async () => {
  console.log(`🤖 로그인 완료: ${client.user.tag}`);
  scheduleDailyLottery(client);
});

// ===== Interaction 처리 =====
client.on('interactionCreate', async (interaction) => {
  try {
    await handleOtherCommands(interaction, client);
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
    }
  }
});

// ===== DB 초기화 및 봇 로그인 =====
(async () => {
  try {
    await initDB();
    await registerCommands();
    await client.login(TOKEN);
    console.log('✅ DB 초기화 & 봇 로그인 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();


if(!TOKEN) {
  console.error('💥 DISCORD_TOKEN이 설정되지 않았습니다.');
  process.exit(1);
}
