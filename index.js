// index.js
// ===== 안정화 코드: 가장 상단 =====
process.on('uncaughtException', (err) => { console.error('💥 Uncaught Exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('💥 Unhandled Rejection:', reason); });

async function safeInterval(callback, intervalMs) {
  return setInterval(async () => {
    try { await callback(); } catch (err) { console.error('💥 Interval 에러:', err); }
  }, intervalMs);
}

// ===== 모듈 임포트 =====
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { initDB, getUser, updateBalance, db } from './db.js';
import { handleOtherCommands } from './commandsHandler.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery } from './lottery.js';

// ----- 환경 변수 -----
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || 'https://dovakbot.onrender.com';

// ===== Express 서버 =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 웹 서버 실행: ${PORT}`));

// Render keep-alive ping (4분)
if (KEEPALIVE_URL) {
  safeInterval(async () => { try { await fetch(KEEPALIVE_URL); console.log('🔁 Keep-alive ping'); } catch {} }, 1000 * 60 * 4);
}

// ===== Discord 클라이언트 초기화 =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

// ===== interactionCreate 이벤트 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, member } = interaction;
  try {
    // 서버 닉네임 우선
    const nickname = member?.displayName || user.username;
    const userData = await getUser(user.id);

    switch (commandName) {
      case '블랙잭':
        await runBlackjackManual(interaction);
        break;
      case '바카라':
        await runBaccaratManual(interaction);
        break;
      default:
        // 슬롯, 복권, 경마 등
        await handleOtherCommands(interaction, client, userData, nickname);
        break;
    }
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
  }
});

// ===== 봇 준비 완료 이벤트 =====
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ===== DB 초기화 후 봇 로그인 =====
(async () => {
  try {
    await initDB();
    scheduleDailyLottery(client, db, updateBalance); // 매일 복권 자동
    await client.login(TOKEN);
    console.log('🤖 봇 로그인 완료 & DB 초기화 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();
