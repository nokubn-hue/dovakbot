// ===== 안정화 코드: 가장 상단 =====

// 전역 예외 처리
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
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
} from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

// dovakbot 폴더 기준으로 경로 수정
import { initDB, getUser, updateBalance, safeDBRun, safeDBAll } from './dovakbot/db.js';
import { runBlackjackManual, runBaccaratManual } from './dovakbot/casinoGames_manual.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery, findLotteryChannel } from './dovakbot/lottery.js';
import { baseCommands } from './dovakbot/commands.js';
import { handleOtherCommands } from './dovakbot/otherCommands.js';
import { spinSlot } from './dovakbot/games.js';
import { TOKEN, CLIENT_ID, ADMIN_IDS } from './dovakbot/config.js';

// ===== Express 서버 =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ 웹 서버 실행 완료 (포트 ${PORT})`));

// Render keep-alive ping (4분 간격)
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || '';
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
  partials: [Partials.Message, Partials.Channel],
});

// ===== 봇 준비 완료 이벤트 =====
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ===== interactionCreate 이벤트 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  try {
    const userData = await getUser(user.id);

    // 블랙잭/바카라는 casinoGames_manual.js에서 수동 처리
    if (commandName === '블랙잭') {
      await runBlackjackManual(interaction);
      return;
    }
    if (commandName === '바카라') {
      await runBaccaratManual(interaction);
      return;
    }

    // 그 외 명령어 (슬롯, 복권, 경마, 관리자 지급 등)
    await handleOtherCommands(interaction, client, userData);
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
    }
  }
});

// ===== DB 초기화 후 봇 로그인 =====
(async () => {
  try {
    await initDB();

    // 자동 복권 스케줄 등록
    scheduleDailyLottery(client, safeDBAll, updateBalance);

    await client.login(TOKEN);
    console.log('🤖 봇 로그인 완료 & DB 초기화 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();
