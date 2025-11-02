// ===== 안정화 코드 =====
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

// dovakbot 내부 모듈
import { initDB, getUser, updateBalance, safeDBAll } from './db.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery } from './lottery.js';
import { handleOtherCommands } from './otherCommands.js';
import { startRace } from './games.js';
import { TOKEN } from './config.js';

// ===== Express 서버 =====
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 웹 서버 실행: ${PORT}`));

// Render keep-alive ping
if (process.env.KEEPALIVE_URL) {
  setInterval(async () => { try { await fetch(process.env.KEEPALIVE_URL); console.log('🔁 Keep-alive ping'); } catch {} }, 1000*60*4);
}

// ===== Discord 클라이언트 =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

// ===== interactionCreate 이벤트 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user } = interaction;

  try {
    const userData = await getUser(user.id);

    // 블랙잭/바카라 수동
    if (commandName === '블랙잭') return await runBlackjackManual(interaction);
    if (commandName === '바카라') return await runBaccaratManual(interaction);

    // 그 외 명령어: 슬롯, 복권, 경마, 관리자 지급
    await handleOtherCommands(interaction, client, userData);

  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
  }
});

// ===== 봇 준비 완료 =====
client.once('ready', () => console.log(`✅ Logged in as ${client.user.tag}`));

// ===== DB 초기화 + 자동 복권 스케줄 + 봇 로그인 =====
(async () => {
  try {
    await initDB();
    scheduleDailyLottery(client, safeDBAll, updateBalance); // 매일 오후 9시 자동 복권
    await client.login(TOKEN);
    console.log('🤖 봇 로그인 & DB 초기화 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();

