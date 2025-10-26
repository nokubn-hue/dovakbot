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
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

// ----- 환경 변수 -----
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];
const PORT = process.env.PORT || 10000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || 'https://dovakbot.onrender.com';

// ===== Express 서버 =====
const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(PORT, () => console.log('✅ 웹 서버 실행 완료'));

// Render keep-alive ping (4분 간격)
if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await fetch(KEEPALIVE_URL);
      console.log('🔁 Keep-alive ping');
    } catch (e) {}
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

let db;

// ===== DB 초기화 =====

let db;

export async function initDB() {
  // sqlite3 드라이버를 import로 지정
  db = await open({
    filename: './data.sqlite',
    driver: sqlite3.Database
  });

  // users 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0
    );
  `);

  // transactions 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount INTEGER,
      reason TEXT,
      timestamp INTEGER
    );
  `);

  // lottery_tickets 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      numbers TEXT,
      draw_date TEXT
    );
  `);

  console.log('✅ 데이터베이스 초기화 완료');
}

// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

// ===== DB 초기화 =====
export async function initDB() {
  db = await open({
    filename: './data.sqlite',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount INTEGER,
      reason TEXT,
      timestamp INTEGER
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      numbers TEXT,
      draw_date TEXT
    );
  `);

  console.log('✅ 데이터베이스 초기화 완료');
}

// ===== DB 객체 export =====
export { db };

// ===== 안전 DB 함수 =====
export async function safeDBRun(query, ...params) {
  try {
    return await db.run(query, ...params);
  } catch (err) {
    console.error('💥 DB 실행 에러:', err, query, params);
    throw err;
  }
}

export async function safeDBGet(query, ...params) {
  try {
    return await db.get(query, ...params);
  } catch (err) {
    console.error('💥 DB 조회 에러:', err, query, params);
    throw err;
  }
}

export async function safeDBAll(query, ...params) {
  try {
    return await db.all(query, ...params);
  } catch (err) {
    console.error('💥 DB 전체 조회 에러:', err, query, params);
    throw err;
  }
}

// ===== 유틸 함수 =====
export async function getUser(id) {
  let user = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    await db.run('INSERT INTO users (id, balance) VALUES (?, ?)', id, 1000);
    user = { id, balance: 1000, last_claim: 0 };
  }
  return user;
}

export async function updateBalance(userId, amount, reason) {
  await db.run('BEGIN TRANSACTION');
  try {
    const user = await getUser(userId);
    const newBalance = Math.max(0, user.balance + amount);
    await db.run('UPDATE users SET balance = ? WHERE id = ?', newBalance, userId);
    await db.run(
      'INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?, ?, ?, ?)',
      userId,
      amount,
      reason,
      Date.now()
    );
    await db.run('COMMIT');
    return newBalance;
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('💥 Balance update error:', err);
    throw err;
  }
}

// commands.js

export const baseCommands = [
  new SlashCommandBuilder()
    .setName('돈줘')
    .setDescription('하루에 한 번 기본금을 받습니다.'),
  
  new SlashCommandBuilder()
    .setName('잔고')
    .setDescription('현재 잔고를 확인합니다.'),
  
  new SlashCommandBuilder()
    .setName('골라')
    .setDescription('여러 옵션 중 하나를 무작위로 선택합니다.')
    .addStringOption(opt =>
      opt
        .setName('옵션들')
        .setDescription('쉼표로 구분된 옵션')
        .setRequired(true)
    ),
  
  new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('슬롯머신을 돌립니다.')
    .addIntegerOption(opt =>
      opt
        .setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(false)
    ),
  
  new SlashCommandBuilder()
    .setName('복권구매')
    .setDescription('복권을 구매합니다.')
    .addStringOption(opt =>
      opt
        .setName('번호')
        .setDescription('복권 번호를 입력하지 않으면 자동 생성됩니다. (예: 1,2,3,4,5,6)')
        .setRequired(false)
    ),
  
  new SlashCommandBuilder()
    .setName('복권상태')
    .setDescription('오늘의 복권 구매 상태를 확인합니다.'),
  
  new SlashCommandBuilder()
    .setName('복권결과')
    .setDescription('오늘의 복권 결과를 수동으로 발표합니다.'),
  
  new SlashCommandBuilder()
    .setName('경마')
    .setDescription('랜덤 경마를 진행합니다.')
    .addIntegerOption(opt =>
      opt
        .setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt
        .setName('말번호')
        .setDescription('1~7 중 하나 선택')
        .setRequired(true)
    ),
  
  new SlashCommandBuilder()
    .setName('관리자지급')
    .setDescription('관리자가 유저에게 포인트를 지급합니다.')
    .addUserOption(opt =>
      opt
        .setName('대상')
        .setDescription('유저 선택')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt
        .setName('금액')
        .setDescription('지급할 금액')
        .setRequired(true)
    ),
  
  new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('블랙잭을 플레이합니다.')
    .addIntegerOption(opt =>
      opt
        .setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(true)
    ),
  
  new SlashCommandBuilder()
    .setName('바카라')
    .setDescription('바카라를 플레이합니다.')
    .addIntegerOption(opt =>
      opt
        .setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName('선택')
        .setDescription('플레이어 / 뱅커 / 타이')
        .setRequired(true)
    ),
];

// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

// ===== DB 초기화 =====
export async function initDB() {
  db = await open({
    filename: './data.sqlite',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount INTEGER,
      reason TEXT,
      timestamp INTEGER
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      numbers TEXT,
      draw_date TEXT
    );
  `);

  console.log('✅ 데이터베이스 초기화 완료');
}

// ===== DB 객체 export =====
export { db };

// ===== 안전 DB 함수 =====
export async function safeDBRun(query, ...params) {
  try {
    return await db.run(query, ...params);
  } catch (err) {
    console.error('💥 DB 실행 에러:', err, query, params);
    throw err;
  }
}

export async function safeDBGet(query, ...params) {
  try {
    return await db.get(query, ...params);
  } catch (err) {
    console.error('💥 DB 조회 에러:', err, query, params);
    throw err;
  }
}

export async function safeDBAll(query, ...params) {
  try {
    return await db.all(query, ...params);
  } catch (err) {
    console.error('💥 DB 전체 조회 에러:', err, query, params);
    throw err;
  }
}

// ===== 유틸 함수 =====
export async function getUser(id) {
  let user = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    await db.run('INSERT INTO users (id, balance) VALUES (?, ?)', id, 1000);
    user = { id, balance: 1000, last_claim: 0 };
  }
  return user;
}

export async function updateBalance(userId, amount, reason) {
  await db.run('BEGIN TRANSACTION');
  try {
    const user = await getUser(userId);
    const newBalance = Math.max(0, user.balance + amount);
    await db.run('UPDATE users SET balance = ? WHERE id = ?', newBalance, userId);
    await db.run(
      'INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?, ?, ?, ?)',
      userId,
      amount,
      reason,
      Date.now()
    );
    await db.run('COMMIT');
    return newBalance;
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('💥 Balance update error:', err);
    throw err;
  }
}

// games.js
import { REST, Routes } from 'discord.js';
import { baseCommands } from './commands.js';
import { TOKEN, CLIENT_ID } from './config.js'; // 환경변수 분리 가정

// ===== 명령어 등록 =====
export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: baseCommands.map((c) => c.toJSON()),
    });
    console.log('✅ 글로벌 명령어 등록 완료');
  } catch (err) {
    console.error('⚠️ 명령어 등록 실패:', err);
  }
}

// ===== 슬롯머신 =====
export function spinSlot() {
  const symbols = ['🍒', '🍋', '🍇', '💎', '7️⃣'];
  return [0, 1, 2].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
}

// ===== 경마/게임 관련 데이터 =====
export const RACE_PAYOUT_MULTIPLIER = 5;
export const horses = [
  { name: '실버 쉽', emoji: '🐎' },
  { name: '언내추럴 위크', emoji: '🐎' },
  { name: '루즈 티켓', emoji: '🐎' },
  { name: '나리타 카나', emoji: '🐎' },
  { name: '싱글코어 터보', emoji: '🐎' },
  { name: '로쿠도 캡', emoji: '🐎' },
  { name: '럭키 카구야', emoji: '🐎' },
];

export const activeRaces = new Map();
export const activeBlackjacks = new Map();
export const activeBaccarat = new Map();

export const suits = ['♠️', '♥️', '♦️', '♣️'];
export const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// ===== 카드 관련 함수 =====
export function drawCard(deck) {
  return deck.pop();
}

export function calcHandValue(hand) {
  let value = 0,
    aces = 0;
  for (const c of hand) {
    if (['J', 'Q', 'K'].includes(c.rank)) value += 10;
    else if (c.rank === 'A') {
      value += 11;
      aces++;
    } else value += parseInt(c.rank);
  }
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return value;
}

export function createDeck() {
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ suit: s, rank: r });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// lottery.js
import cron from 'node-cron';
import { ChannelType } from 'discord.js';

/**
 * 유틸: 복권 채널 탐색
 */
export async function findLotteryChannel(client) {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name.includes('복권') || c.name.toLowerCase().includes('lottery'))
    );
    if (channel) return channel;
  }
  return null;
}

/**
 * 복권 결과 계산 + 발표 함수
 * @param {Client} client Discord client
 * @param {object} db sqlite db
 * @param {function} updateBalance 잔고 업데이트 함수
 * @param {boolean} manual 수동 호출 여부
 * @param {Interaction} interaction interaction 객체 (수동 호출 시)
 */
export async function drawLotteryAndAnnounce(
  client,
  db,
  updateBalance,
  manual = false,
  interaction = null
) {
  const today = new Date().toISOString().split('T')[0];
  const tickets = await db.all('SELECT * FROM lottery_tickets WHERE draw_date = ?', today);

  if (!tickets || tickets.length === 0) {
    const msg = '📭 오늘은 구매한 복권이 없습니다.';
    if (manual && interaction) return interaction.reply(msg);
    console.log(msg);
    return;
  }

  // 랜덤 6개 번호 (중복 없음)
  const available = Array.from({ length: 40 }, (_, i) => i + 1);
  const winning = [];
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * available.length);
    winning.push(available.splice(idx, 1)[0]);
  }
  winning.sort((a, b) => a - b);

  const results = [];

  for (const ticket of tickets) {
    const nums = ticket.numbers.split(',').map((n) => parseInt(n.trim()));
    const matches = nums.filter((n) => winning.includes(n)).length;
    const reward = matches === 5 ? 5000 : 0;

    if (reward > 0) {
      await updateBalance(ticket.user_id, reward, `복권 ${matches}개 일치 보상`);

      // 서버 닉네임 가져오기
      let displayName = ticket.user_id;
      for (const guild of client.guilds.cache.values()) {
        try {
          const member = await guild.members.fetch(ticket.user_id);
          if (member) {
            displayName = member.displayName ?? member.user.username;
            break;
          }
        } catch {}
      }

      results.push(`${displayName} ➜ ${matches}개 일치 🎉 (${reward}코인)`);
    }
  }

  const resultText = [
    '🎰 **오늘의 복권 당첨 결과** 🎰',
    `📅 날짜: ${today}`,
    `🏆 당첨번호: **${winning.join(', ')}**`,
    '',
    results.length ? results.join('\n') : '😢 이번 회차에는 당첨자가 없습니다.',
  ].join('\n');

  if (manual && interaction) return interaction.reply(resultText);

  const channel = await findLotteryChannel(client);
  if (channel) await channel.send(resultText);
  else console.warn('⚠️ 복권 결과 채널 없음');
}

/**
 * 자동 스케줄 등록 함수
 */
export function scheduleDailyLottery(client, db, updateBalance) {
  cron.schedule(
    '0 21 * * *',
    async () => {
      try {
        await drawLotteryAndAnnounce(client, db, updateBalance);
      } catch (err) {
        console.error('💥 Cron 자동 발표 에러:', err);
      }
    },
    { timezone: 'Asia/Seoul' }
  );
  console.log('🕘 매일 오후 9시에 자동 복권 발표 스케줄러 등록 완료');
}


// commandsHandler.js
import { safeDBRun, updateBalance, getUser } from './db.js';
import { spinSlot } from './games.js';

/**
 * Discord SlashCommand 처리
 * @param {Interaction} interaction
 */
export async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, options } = interaction;
  const userData = await getUser(user.id);

  try {
    // ----- 돈줘 -----
    if (commandName === '돈줘') {
      const now = Date.now();
      if (now - userData.last_claim < 86400000) {
        return await interaction.reply({ content: '⏰ 이미 오늘 받았습니다.', ephemeral: true });
      }
      await safeDBRun('UPDATE users SET last_claim=? WHERE id=?', now, user.id);
      const newBal = await updateBalance(user.id, 1000, '기본금 지급');
      return await interaction.reply(`💸 기본금 1000원 지급. 현재 잔고: ${newBal}원`);
    }

    // ----- 잔고 -----
    if (commandName === '잔고') {
      const nickname = interaction.member?.displayName || interaction.user.username;
      return await interaction.reply(`💰 ${nickname}님의 잔고: ${userData.balance}원`);
    }

    // ----- 골라 -----
    if (commandName === '골라') {
      const opts = options.getString('옵션들').split(',').map((x) => x.trim()).filter(Boolean);
      if (opts.length < 2) return await interaction.reply('⚠️ 2개 이상 입력해주세요.');
      const choice = opts[Math.floor(Math.random() * opts.length)];
      return await interaction.reply(`🎯 선택된 항목: **${choice}**`);
    }

    // ----- 슬롯 -----
    if (commandName === '슬롯') {
      const bet = options.getInteger('베팅') ?? 100;
      if (bet <= 0 || bet > userData.balance) return await interaction.reply('❌ 베팅 금액 오류.');

      await updateBalance(user.id, -bet, '슬롯 베팅');

      const result = spinSlot();
      const uniqueSymbols = new Set(result);
      let reward = 0;
      let patternText = '';
      let sevenText = '';

      // 🍒 패널티
      const cherryCount = result.filter((s) => s === '🍒').length;
      let penaltyText = '';
      let isPenalty = false;
      if (cherryCount === 2) {
        reward -= 500;
        penaltyText = '💥 체리 2개! 500코인 차감!';
        isPenalty = true;
      } else if (cherryCount === 3) {
        reward -= 2000;
        penaltyText = '💀 체리 3개! 2000코인 차감!';
        isPenalty = true;
      }

      if (!isPenalty) {
        if (uniqueSymbols.size === 1) {
          reward = bet * 10;
          patternText = '🎉 세 개 동일 심볼! x10 당첨!';
        } else if (uniqueSymbols.size === 2) {
          reward = bet * 2;
          patternText = '✨ 두 개 동일 심볼! x2 당첨!';
        } else {
          patternText = '꽝...';
        }

        // 7️⃣ 심볼 배율
        const sevenCount = result.filter((s) => s === '7️⃣').length;
        if (sevenCount === 2) {
          reward += bet * 5;
          sevenText = '🔥 7️⃣ 2개! x5배 추가!';
        } else if (sevenCount === 3) {
          reward += bet * 20;
          sevenText = '💥 7️⃣ 3개! x20배 추가!';
        }
      }

      if (reward !== 0) await updateBalance(user.id, reward, '슬롯 결과');

      const balance = (await getUser(user.id)).balance;

      return await interaction.reply(
        `🎰 슬롯 결과: ${result.join(' | ')}\n` +
          `${patternText}\n` +
          `${sevenText ? sevenText + '\n' : ''}` +
          `${penaltyText ? penaltyText + '\n' : ''}` +
          `💰 최종 잔고: ${balance}원\n` +
          `${reward > 0 ? `🎉 보상: +${reward}` : reward < 0 ? `💸 손실: ${reward}` : ''}`
      );
    }
  } catch (err) {
    console.error('💥 명령어 처리 에러:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '⚠️ 오류 발생', ephemeral: true });
    }
  }
}


// lotteryCommand.js
import { safeDBRun, safeDBGet } from './db.js';

/**
 * 복권 구매 처리
 * @param {Interaction} interaction
 * @param {Object} userData - getUser(user.id)로 가져온 유저 데이터
 */
export async function handleLotteryPurchase(interaction, userData) {
  const { user, options } = interaction;
  const input = options.getString('번호');
  let nums;

  // ✅ 입력된 번호 검증
  if (input) {
    nums = input.split(',').map((n) => parseInt(n.trim()));
    if (nums.length !== 6 || nums.some((n) => isNaN(n) || n < 1 || n > 45)) {
      return await interaction.reply('⚠️ 번호는 1~45 사이의 숫자 6개를 쉼표로 입력해주세요.');
    }
  } else {
    // ✅ 자동 번호 생성
    const pool = Array.from({ length: 45 }, (_, i) => i + 1);
    nums = [];
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      nums.push(pool.splice(idx, 1)[0]);
    }
  }

  // ✅ 오늘 날짜 문자열 (예: 2025-10-23)
  const today = new Date().toISOString().split('T')[0];

  // ✅ 하루 1회 제한 확인
  const existingTicket = await safeDBGet(
    'SELECT * FROM lottery_tickets WHERE user_id = ? AND draw_date = ?',
    user.id,
    today
  );

  if (existingTicket) {
    return await interaction.reply('⚠️ 오늘은 이미 복권을 구매하셨습니다! 내일 다시 시도해주세요.');
  }

  // ✅ 무료 구매 (금액 차감 없음)
  await safeDBRun(
    'INSERT INTO lottery_tickets (user_id, numbers, draw_date) VALUES (?, ?, ?)',
    user.id,
    nums.join(','),
    today
  );

  return await interaction.reply(`🎟 복권 구매 완료! (무료)\n오늘의 번호: ${nums.join(', ')}`);
}

    // commands/otherCommands.js
import { db, safeDBAll, updateBalance } from '../db.js';
import { drawLotteryAndAnnounce } from '../lottery.js';
import { ADMIN_IDS, RACE_PAYOUT_MULTIPLIER } from '../config.js';

/**
 * 복권 상태, 복권 결과, 경마, 관리자 지급 처리
 * @param {Interaction} interaction
 * @param {Object} client - Discord client
 * @param {Object} userData - getUser(user.id)로 가져온 유저 데이터
 */
export async function handleOtherCommands(interaction, client, userData) {
  const { commandName, user, options } = interaction;

  // ----- 복권상태 -----
  if (commandName === '복권상태') {
    const today = new Date().toISOString().split('T')[0];
    const tickets = await safeDBAll(
      'SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?',
      user.id,
      today
    );
    if (!tickets.length) {
      return await interaction.reply('📭 오늘 구매한 복권이 없습니다.');
    }
    return await interaction.reply(
      '🎟 오늘 구매한 복권:\n' + tickets.map((t) => t.numbers).join('\n')
    );
  }

  // ----- 복권결과 (관리자용) -----
  if (commandName === '복권결과') {
    if (!ADMIN_IDS.includes(user.id)) {
      return await interaction.reply('⚠️ 관리자 전용 명령어입니다.');
    }
    await drawLotteryAndAnnounce(client, db, updateBalance, true, interaction);
  }

  // ----- 경마 -----
  if (commandName === '경마') {
    const bet = options.getInteger('베팅');
    const horseNum = options.getInteger('말번호');

    if (!horseNum || horseNum < 1 || horseNum > 7) {
      return interaction.reply('🐎 말 번호는 1~7 중 하나를 선택하세요.');
    }
    if (bet <= 0 || bet > userData.balance) {
      return interaction.reply('❌ 베팅 금액 오류.');
    }

    await updateBalance(user.id, -bet, '경마 베팅');

    const winner = Math.floor(Math.random() * 7) + 1;
    let resultText = `🐎 경마 결과: ${winner}번 말 승리!\n`;
    if (winner === horseNum) {
      const reward = bet * RACE_PAYOUT_MULTIPLIER;
      await updateBalance(user.id, reward, '경마 당첨');
      resultText += `🎉 축하! ${reward} 코인 획득!`;
    } else resultText += '😢 아쉽네요!';

    return await interaction.reply(resultText);
  }

  // ----- 관리자지급 -----
  if (commandName === '관리자지급') {
    if (!ADMIN_IDS.includes(user.id)) {
      return interaction.reply('⚠️ 관리자 전용 명령어입니다.');
    }
    const target = options.getUser('대상');
    const amount = options.getInteger('금액');
    await updateBalance(target.id, amount, '관리자 지급');
    return interaction.reply(`✅ ${target.username}님에게 ${amount} 코인 지급 완료`);
  }
}


// index.js
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import { initDB } from './db.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { handleOtherCommands } from './commands/otherCommands.js';
import { getUser } from './db.js';

dotenv.config();

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('❌ Discord Token이 설정되지 않았습니다. .env 확인 필요');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

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
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
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



















