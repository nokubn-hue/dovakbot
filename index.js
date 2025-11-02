// ===== 안정화 코드: 가장 상단 =====
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection:', reason));

async function safeInterval(callback, intervalMs) {
  return setInterval(async () => {
    try { await callback(); } catch (err) { console.error('💥 Interval Error:', err); }
  }, intervalMs);
}

// ===== 모듈 임포트 =====
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType
} from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { initDB, safeDBRun, safeDBGet, safeDBAll, getUser, updateBalance } from './db.js';
import { baseCommands } from './commands.js';
import { spinSlot, horses } from './games.js';
import { drawLotteryAndAnnounce, scheduleDailyLottery, findLotteryChannel } from './lottery.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';

// ----- 환경 변수 -----
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL;

// ===== Express 서버 =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log('✅ 웹 서버 실행 완료'));

if (KEEPALIVE_URL) {
  setInterval(async () => {
    try { await fetch(KEEPALIVE_URL); console.log('🔁 Keep-alive ping'); } catch {}
  }, 1000 * 60 * 4);
}

// ===== Discord 클라이언트 초기화 =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel]
});

// ===== Interaction 처리 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, options } = interaction;
  const userData = await getUser(user.id);

  try {
    // ----- 블랙잭 / 바카라 수동 -----
    if (commandName === '블랙잭') return await runBlackjackManual(interaction);
    if (commandName === '바카라') return await runBaccaratManual(interaction);

    // ----- 돈줘 -----
    if (commandName === '돈줘') {
      const now = Date.now();
      if (now - userData.last_claim < 86400000)
        return interaction.reply({ content: '⏰ 이미 오늘 받았습니다.', ephemeral: true });
      await updateBalance(user.id, 1000, '기본금 지급');
      await safeDBRun('UPDATE users SET last_claim=? WHERE id=?', now, user.id);
      return interaction.reply(`💸 기본금 1000원 지급. 현재 잔고: ${(await getUser(user.id)).balance}원`);
    }

    // ----- 잔고 -----
    if (commandName === '잔고') {
      const nickname = interaction.member?.displayName || user.username;
      return interaction.reply(`💰 ${nickname}님의 잔고: ${userData.balance}원`);
    }

    // ----- 골라 -----
    if (commandName === '골라') {
      const opts = options.getString('옵션들').split(',').map(x => x.trim()).filter(Boolean);
      if (opts.length < 2) return interaction.reply('⚠️ 2개 이상 입력해주세요.');
      const choice = opts[Math.floor(Math.random() * opts.length)];
      return interaction.reply(`🎯 선택된 항목: **${choice}**`);
    }

    // ----- 슬롯 -----
    if (commandName === '슬롯') {
      const bet = options.getInteger('베팅') ?? 100;
      if (bet <= 0 || bet > userData.balance) return interaction.reply('❌ 베팅 금액 오류.');
      await updateBalance(user.id, -bet, '슬롯 베팅');

      const result = spinSlot();
      const uniqueSymbols = new Set(result);
      let reward = 0, patternText = '', sevenText = '', penaltyText = '';

      const cherryCount = result.filter(s => s === '🍒').length;
      if (cherryCount === 2) { reward -= 500; penaltyText = '💥 체리 2개! 500코인 차감!'; }
      else if (cherryCount === 3) { reward -= 2000; penaltyText = '💀 체리 3개! 2000코인 차감!'; }
      else {
        if (uniqueSymbols.size === 1) { reward = bet * 10; patternText = '🎉 세 개 동일 심볼! x10 당첨!'; }
        else if (uniqueSymbols.size === 2) { reward = bet * 2; patternText = '✨ 두 개 동일 심볼! x2 당첨!'; }
        else patternText = '꽝...';

        const sevenCount = result.filter(s => s === '7️⃣').length;
        if (sevenCount === 2) { reward += bet * 5; sevenText = '🔥 7️⃣ 2개! x5배 추가!'; }
        else if (sevenCount === 3) { reward += bet * 20; sevenText = '💥 7️⃣ 3개! x20배 추가!'; }
      }

      if (reward !== 0) await updateBalance(user.id, reward, '슬롯 결과');
      const balance = (await getUser(user.id)).balance;

      return interaction.reply(
        `🎰 슬롯 결과: ${result.join(' | ')}\n${patternText}\n${sevenText ? sevenText + '\n' : ''}${penaltyText ? penaltyText + '\n' : ''}💰 최종 잔고: ${balance}원\n${reward > 0 ? `🎉 보상: +${reward}` : reward < 0 ? `💸 손실: ${reward}` : ''}`
      );
    }

    // ----- 복권 구매 -----
    if (commandName === '복권구매') {
      const input = options.getString('번호');
      let nums;

      if (input) {
        nums = input.split(',').map(n => parseInt(n.trim()));
        if (nums.length !== 6 || nums.some(n => isNaN(n) || n < 1 || n > 45))
          return interaction.reply('⚠️ 번호는 1~45 사이의 숫자 6개를 쉼표로 입력해주세요.');
      } else {
        const pool = Array.from({ length: 45 }, (_, i) => i + 1);
        nums = [];
        for (let i = 0; i < 6; i++) { nums.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); }
      }

      const today = new Date().toISOString().split('T')[0];
      const existingTicket = await safeDBGet('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      if (existingTicket) return interaction.reply('⚠️ 오늘은 이미 복권을 구매하셨습니다!');

      await safeDBRun('INSERT INTO lottery_tickets (user_id, numbers, draw_date) VALUES (?,?,?)', user.id, nums.join(','), today);
      return interaction.reply(`🎟 복권 구매 완료! 오늘의 번호: ${nums.join(', ')}`);
    }

    // ----- 복권 상태 -----
    if (commandName === '복권상태') {
      const today = new Date().toISOString().split('T')[0];
      const tickets = await safeDBAll('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      if (!tickets.length) return interaction.reply('📭 오늘 구매한 복권이 없습니다.');
      return interaction.reply('🎟 오늘 구매한 복권:\n' + tickets.map(t => t.numbers).join('\n'));
    }

    // ----- 복권 결과 (관리자용) -----
    if (commandName === '복권결과') {
      if (!ADMIN_IDS.includes(user.id)) return interaction.reply('⚠️ 관리자 전용 명령어입니다.');
      await drawLotteryAndAnnounce(client, null, updateBalance, true, interaction);
    }

    // ----- 관리자 지급 -----
    if (commandName === '관리자지급') {
      if (!ADMIN_IDS.includes(user.id)) return interaction.reply('⚠️ 관리자 전용 명령어입니다.');
      const target = options.getUser('대상');
      const amount = options.getInteger('금액');
      await updateBalance(target.id, amount, '관리자 지급');
      return interaction.reply(`✅ ${target.username}님에게 ${amount} 코인 지급 완료`);
    }

    // ----- 경마 -----
    if (commandName === '경마') {
      const betHorse = options.getString('말');
      const betAmount = options.getInteger('금액');
      if (betAmount <= 0 || betAmount > userData.balance) return interaction.reply('❌ 베팅 금액 오류.');
      await updateBalance(user.id, -betAmount, '경마 베팅');

      const horseNames = horses.map(h => h.name);
      if (!horseNames.includes(betHorse)) return interaction.reply(`⚠️ 존재하지 않는 말: ${betHorse}`);

      // 단순 랜덤 경주
      const winner = horses[Math.floor(Math.random() * horses.length)].name;
      let reward = 0;
      if (winner === betHorse) reward = betAmount * 5;
      if (reward) await updateBalance(user.id, reward, '경마 결과');

      const balance = (await getUser(user.id)).balance;
      return interaction.reply(`🏇 경주 결과: ${winner} 승!\n${reward ? `🎉 보상: +${reward}` : '😢 패배'}\n💰 현재 잔고: ${balance}`);
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
    scheduleDailyLottery(client, null, updateBalance); // 자동 복권 스케줄
    await client.login(TOKEN);
    console.log('🤖 봇 로그인 완료 & DB 초기화 완료');
  } catch (err) {
    console.error('💥 초기화 실패:', err);
    process.exit(1);
  }
})();
