// ===== 안정화 코드: 가장 상단 =====
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

await fetch(KEEPALIVE_URL);
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// ===== GitHub 기준 ./ 경로 모듈 =====
import { initDB, safeDBRun, getUser, updateBalance } from './db.js';
import { baseCommands } from './commands.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery } from './lottery.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { handleOtherCommands } from './otherCommands.js';

// ===== 환경 변수 =====
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL;

// ===== Express 서버 =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 웹 서버 실행: ${PORT}`));

if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await fetch(KEEPALIVE_URL);
      console.log('🔁 Keep-alive ping');
    } catch {}
  }, 1000 * 60 * 4);
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

// ===== interaction 처리 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  const userData = await getUser(user.id);

  try {
    switch (commandName) {
      case '블랙잭':
        await runBlackjackManual(interaction);
        break;
      case '바카라':
        await runBaccaratManual(interaction);
        break;
      default:
        await handleOtherCommands(interaction, client, userData);
        break;
    }
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied)
      await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
  }
});

// ===== 봇 준비 완료 =====
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  scheduleDailyLottery(client, { run: safeDBRun }, updateBalance);
});

// ===== DB 초기화 후 로그인 =====
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

