// index.js
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } from 'discord.js';
import { initDB, getUser, updateBalance, canClaimDaily, updateClaim } from './db.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery } from './lottery.js';
import { startRace, RACE_PAYOUT_MULTIPLIER, horses } from './race.js';
import { baseCommands } from './baseCommands.js';
import { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, ADMIN_USER_IDS, PORT, KEEPALIVE_URL } from './config.js';

dotenv.config();

// 전역 예외 처리
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

// ===== Express 서버 (Keep-alive) =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT || 10000, () => console.log(`✅ 서버 실행: ${PORT || 10000}`));

if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await fetch(KEEPALIVE_URL);
      console.log('🔁 Keep-alive ping');
    } catch (err) {
      console.warn('⚠️ Keep-alive 실패:', err.message);
    }
  }, 1000 * 60 * 4);
}

// ===== Discord 클라이언트 =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ===== 슬래시 명령어 등록 =====
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('🔹 슬래시 명령어 등록 시작...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: baseCommands.map(cmd => cmd.toJSON()),
    });
    console.log('✅ 슬래시 명령어 등록 완료');
  } catch (err) {
    console.error('💥 명령어 등록 에러:', err);
  }
}

// ===== Discord 준비 이벤트 =====
client.once('ready', async () => {
  console.log(`🤖 로그인 완료: ${client.user.tag}`);
  scheduleDailyLottery(client);
});

// ===== Interaction 처리 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, options } = interaction;
  let userData;

  try {
    userData = await getUser(user.id);
    if (!userData) throw new Error('유저 데이터를 불러올 수 없습니다.');
  } catch (err) {
    console.error('💥 유저 데이터 조회 실패:', err);
    await interaction.reply({ content: '⚠️ 유저 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.', ephemeral: true });
    return;
  }

  try {
    // ----- 돈줘 -----
    if (commandName === '돈줘') {
      if (!(await canClaimDaily(user.id))) {
        await interaction.reply({ content: '⏰ 이미 오늘의 기본금을 받으셨습니다.', ephemeral: true });
        return;
      }
      const reward = 1000;
      const newBalance = await updateBalance(user.id, reward, '일일 기본금');
      await updateClaim(user.id);
      await interaction.reply({ content: `💸 오늘의 기본금 ${reward.toLocaleString()}원을 받으셨습니다.\n현재 잔고: ${newBalance.toLocaleString()}원`, ephemeral: true });
      return;
    }

    // ----- 잔고 -----
    if (commandName === '잔고') {
      await interaction.reply({ content: `💰 ${user.username}님의 잔고: ${userData.balance.toLocaleString()}원`, ephemeral: true });
      return;
    }

    // ----- 골라 -----
    if (commandName === '골라') {
      const optionsStr = options.getString('옵션들');
      const choices = optionsStr.split(',').map(s => s.trim()).filter(Boolean);
      if (choices.length === 0) return interaction.reply({ content: '❌ 옵션을 입력해주세요.', ephemeral: true });
      const selected = choices[Math.floor(Math.random() * choices.length)];
      await interaction.reply({ content: `🎯 선택 결과: ${selected}`, ephemeral: true });
      return;
    }

    // ----- 슬롯 -----
    if (commandName === '슬롯') {
      const bet = options.getInteger('베팅') ?? 100;
      if (bet <= 0 || bet > userData.balance) return interaction.reply({ content: '❌ 베팅 금액 오류', ephemeral: true });

      await updateBalance(user.id, -bet, '슬롯 베팅');

      // 슬롯 랜덤 심볼
      const symbols = ['🍒','🍋','🔔','🍀','7️⃣','💎'];
      const result = Array.from({length:3}, () => symbols[Math.floor(Math.random()*symbols.length)]);

      // 결과 계산
      let reward = 0, patternText='', sevenText='', penaltyText='';
      const cherryCount = result.filter(s => s==='🍒').length;
      if (cherryCount===2){ reward -=500; penaltyText='💥 체리 2개! 500코인 차감!'; }
      else if (cherryCount===3){ reward -=2000; penaltyText='💀 체리 3개! 2000코인 차감!'; }

      if (!penaltyText){
        const unique = new Set(result);
        if (unique.size===1){ reward=bet*10; patternText='🎉 세 개 동일 심볼! x10 당첨!'; }
        else if (unique.size===2){ reward=bet*2; patternText='✨ 두 개 동일 심볼! x2 당첨!'; }
        else patternText='꽝...';
        const sevenCount = result.filter(s=>'7️⃣'===s).length;
        if (sevenCount===2){ reward+=bet*5; sevenText='🔥 7️⃣ 2개! x5배 추가!'; }
        else if (sevenCount===3){ reward+=bet*20; sevenText='💥 7️⃣ 3개! x20배 추가!'; }
      }

      if (reward!==0) await updateBalance(user.id, reward, '슬롯 결과');
      const newBal = (await getUser(user.id)).balance;

      await interaction.reply({
        content:
        `🎰 슬롯 결과: ${result.join(' | ')}\n${patternText}\n${sevenText ? sevenText+'\n':''}${penaltyText ? penaltyText+'\n':''}💰 최종 잔고: ${newBal}원\n${reward>0?`🎉 보상: +${reward}`:reward<0?`💸 손실: ${reward}`:''}`,
        ephemeral: true
      });
      return;
    }

    // ----- 복권 -----
    if (commandName==='복권구매'){
      await interaction.deferReply({ ephemeral:true });
      await drawLotteryAndAnnounce(client, interaction);
      return;
    }

    // ----- 블랙잭 -----
    if (commandName==='블랙잭'){
      const bet = options.getInteger('베팅');
      await runBlackjackManual(interaction, userData, bet);
      return;
    }

    // ----- 바카라 -----
    if (commandName==='바카라'){
      const bet = options.getInteger('베팅');
      const choice = options.getString('선택');
      await runBaccaratManual(interaction, userData, bet, choice);
      return;
    }

    // ----- 경마 -----
    if (commandName==='경마'){
      const bet = options.getInteger('베팅');
      const horseNum = options.getInteger('말번호');
      await startRace(interaction, new Map([[user.id, {horseIndex: horseNum-1, bet}]]));
      return;
    }

    await interaction.reply({ content: '❓ 알 수 없는 명령어입니다.', ephemeral: true });

  } catch (err){
    console.error('💥 Interaction 처리 에러:', err);
    if (!interaction.replied) await interaction.reply({ content:'⚠️ 오류 발생', ephemeral:true });
  }
});

// ===== DB 초기화 및 봇 로그인 =====
(async ()=>{
  try{
    await initDB();
    await registerSlashCommands();
    await client.login(DISCORD_TOKEN);
    console.log('✅ DB 초기화 & 봇 로그인 완료');
  } catch(err){
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();
