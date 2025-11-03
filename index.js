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

// ===== 전역 예외 처리 =====
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

// ===== 환경 변수 =====
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL;

// ===== 토큰 확인 =====
if (!TOKEN) {
  console.error('💥 DISCORD_TOKEN이 .env에 설정되어 있지 않습니다.');
  process.exit(1);
}

// ===== Express 서버 (Render Keep-Alive) =====
const app = express();
app.get('/', (_, res) => res.send('✅ DovakBot is running.'));
app.listen(PORT, () => console.log(`🌐 서버 실행 중: 포트 ${PORT}`));

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

// ===== Discord 클라이언트 생성 =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ===== 클라이언트 준비 이벤트 =====
client.once('clientReady', async () => {
  console.log(`🤖 로그인 완료: ${client.user.tag}`);
  scheduleDailyLottery(client);
});

// ===== Interaction 처리 =====
client.on('interactionCreate', async (interaction) => {
  try {
    await handleOtherCommands(interaction, client);
  } catch (err) {
    console.error('💥 Interaction 처리 에러:', err);
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: '⚠️ 오류가 발생했습니다. 다시 시도해주세요.', flags: 64 });
      }
    } catch {
      console.warn('⚠️ Interaction 응답 실패 (이미 만료된 요청)');
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
