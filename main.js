import { Client, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import dotenv from 'dotenv';
import { initDB } from './db.js';
import { registerCommands } from './commands.js';
import { handleCommand } from './commandsHandler.js';
import { scheduleDailyLottery } from './lottery.js';

dotenv.config();

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 10000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// 웹 서버 (Render keep-alive용)
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log(`✅ 서버 실행: ${PORT}`));

// Discord 준비 이벤트
client.once('ready', async () => {
  console.log(`🤖 로그인 완료: ${client.user.tag}`);
  scheduleDailyLottery(client);
});

// 명령어 처리
client.on('interactionCreate', async (interaction) => {
  await handleCommand(interaction, client);
});

// 초기화 및 실행
(async () => {
  try {
    await initDB();
    await registerCommands();
    await client.login(TOKEN);
  } catch (err) {
    console.error('초기화 실패:', err);
    process.exit(1);
  }
})();
