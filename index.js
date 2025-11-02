// index.js

// ===== 안정화 코드: 가장 상단 =====
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception 발생:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection 발생:', reason);
});

// 안전한 Interval Wrapper
async function safeInterval(callback, intervalMs) {
  return setInterval(async () => {
    try {
      await callback();
    } catch (err) {
      console.error('💥 Interval 에러:', err);
    }
  }, intervalMs);
}

// ===== 모듈 임포트 =====
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { initDB, db, safeDBRun, getUser, updateBalance } from './db.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery } from './lottery.js';
import { handleOtherCommands } from './commandsHandler.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { baseCommands } from './commands.js';
import { REST, Routes } from 'discord.js';

// ----- 환경 변수 -----
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || 'https://dovakbot.onrender.com';

// ===== Express 서버 =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 웹 서버 실행 완료 (포트 ${PORT})`));

// Render keep-alive ping (4분 간격)
if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await fetch(KEEPALIVE_URL);
      console.log('🔁 Keep-alive ping');
    } catch {}
  }, 1000 * 60 * 4);
}

// ===== Discord 클라이언트 초기화 =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ===== Discord 명령어 등록 =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: baseCommands.map(c => c.toJSON()),
    });
    console.log('✅ 글로벌 명령어 등록 완료');
  } catch (err) {
    console.error('⚠️ 명령어 등록 실패:', err);
  }
}

// ===== interactionCreate 이벤트 통합 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  try {
    const userData = await getUser(user.id);

    switch (commandName) {
      case '블랙잭':
        await runBlackjackManual(interaction);
        break;
      case '바카라':
        await runBaccaratManual(interaction);
        break;
      default:
        // 그 외 명령어 (복권, 경마, 슬롯 등)
        await handleOtherCommands(interaction, client, userData);
        break;
    }
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
    }
  }
});

// ===== 봇 준비 완료 이벤트 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 자동 복권 스케줄 등록
  scheduleDailyLottery(client, db, updateBalance);

  // 명령어 등록
  await registerCommands();
});

// ===== DB 초기화 후 봇 로그인 =====
(async () => {
  try {
    await initDB();
    await client.login(TOKEN);
    console.log('🤖 봇 로그인 완료 & DB 초기화 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();
