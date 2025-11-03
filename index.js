// ===== 안정화 코드: 가장 상단 =====
import express from 'express';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { initDB } from './db.js';
import { registerCommands } from './command.js';
import { handleOtherCommands } from './commandsHandler.js';
import { scheduleDailyLottery } from './lottery.js';
import { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, PORT, KEEPALIVE_URL } from './config.js';

// 전역 예외 처리
process.on('uncaughtException', err => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('💥 Unhandled Rejection:', reason));

// ===== Express 서버 (Keep-alive) =====
const app = express();
app.get('/', (_, res) => res.send('✅ DovakBot is running.'));
app.listen(PORT, () => console.log(`🌐 Express 서버 실행 중: 포트 ${PORT}`));

if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await fetch(KEEPALIVE_URL);
      console.log('🔁 Keep-alive ping 성공');
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
client.on('interactionCreate', async interaction => {
  try {
    await handleOtherCommands(interaction, client);
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '⚠️ 오류가 발생했습니다.', ephemeral: true });
    }
  }
});

// ===== 재시도 가능한 안전한 초기화 =====
async function safeInit() {
  try {
    console.log('🚀 DovakBot 초기화 중...');
    await initDB();
    await registerCommands();
    await client.login(DISCORD_TOKEN);
    console.log('✅ DB & 명령어 등록 & 로그인 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    console.log('⏳ 10초 후 재시도합니다...');
    setTimeout(safeInit, 10_000);
  }
}

// 실행 시작
safeInit();
