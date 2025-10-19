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
  setInterval(() => {
    try {
      fetch(KEEPALIVE_URL)
        .then(() => console.log('🔁 Keep-alive ping'))
        .catch(() => {});
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
async function initDB() {
  db = await open({ filename: './data.sqlite', driver: sqlite3.Database });
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

// ===== 안전 DB 함수 =====
async function safeDBRun(query, ...params) {
  try {
    return await db.run(query, ...params);
  } catch (err) {
    console.error('💥 DB 실행 에러:', err, query, params);
    throw err;
  }
}
async function safeDBGet(query, ...params) {
  try {
    return await db.get(query, ...params);
  } catch (err) {
    console.error('💥 DB 조회 에러:', err, query, params);
    throw err;
  }
}
async function safeDBAll(query, ...params) {
  try {
    return await db.all(query, ...params);
  } catch (err) {
    console.error('💥 DB 전체 조회 에러:', err, query, params);
    throw err;
  }
}

// ===== 유틸 함수 =====
async function getUser(id) {
  let user = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    await db.run('INSERT INTO users (id, balance) VALUES (?, ?)', id, 1000);
    user = { id, balance: 1000, last_claim: 0 };
  }
  return user;
}

async function updateBalance(userId, amount, reason) {
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

// ===== 명령어 정의 (SlashCommandBuilder 모음) =====
const baseCommands = [
  new SlashCommandBuilder().setName('돈줘').setDescription('하루에 한 번 기본금을 받습니다.'),
  new SlashCommandBuilder().setName('잔고').setDescription('현재 잔고를 확인합니다.'),
  new SlashCommandBuilder()
    .setName('골라')
    .setDescription('여러 옵션 중 하나를 무작위로 선택합니다.')
    .addStringOption((opt) => opt.setName('옵션들').setDescription('쉼표로 구분된 옵션').setRequired(true)),
  new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('슬롯머신을 돌립니다.')
    .addIntegerOption((opt) => opt.setName('베팅').setDescription('베팅 금액').setRequired(false)),
  new SlashCommandBuilder()
    .setName('복권구매')
    .setDescription('복권을 구매합니다.')
    .addStringOption((opt) =>
      opt.setName('번호').setDescription('복권 번호를 입력하지 않으면 자동 생성됩니다. (예: 1,2,3,4,5,6)').setRequired(false)
    ),
  new SlashCommandBuilder().setName('복권상태').setDescription('오늘의 복권 구매 상태를 확인합니다.'),
  new SlashCommandBuilder()
    .setName('복권결과')
    .setDescription('오늘의 복권 결과를 수동으로 발표합니다.'),
  new SlashCommandBuilder()
    .setName('경마')
    .setDescription('랜덤 경마를 진행합니다.')
    .addIntegerOption((opt) => opt.setName('베팅').setDescription('베팅 금액').setRequired(true))
    .addIntegerOption((opt) => opt.setName('말번호').setDescription('1~7 중 하나 선택').setRequired(true)),
  new SlashCommandBuilder()
    .setName('관리자지급')
    .setDescription('관리자가 유저에게 포인트를 지급합니다.')
    .addUserOption((opt) => opt.setName('대상').setDescription('유저 선택').setRequired(true))
    .addIntegerOption((opt) => opt.setName('금액').setDescription('지급할 금액').setRequired(true)),
  new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('블랙잭을 플레이합니다.')
    .addIntegerOption((opt) => opt.setName('베팅').setDescription('베팅 금액').setRequired(true)),
  new SlashCommandBuilder()
    .setName('바카라')
    .setDescription('바카라를 플레이합니다.')
    .addIntegerOption((opt) => opt.setName('베팅').setDescription('베팅 금액').setRequired(true))
    .addStringOption((opt) => opt.setName('선택').setDescription('플레이어 / 뱅커 / 타이').setRequired(true)),
];

// ===== 명령어 등록 =====
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: baseCommands.map((c) => c.toJSON()) });
    console.log('✅ 글로벌 명령어 등록 완료');
  } catch (err) {
    console.error('⚠️ 명령어 등록 실패:', err);
  }
})();

// ===== 슬롯머신 =====
function spinSlot() {
  const symbols = ['🍒', '🍋', '🍇', '💎', '7️⃣'];
  return [0, 1, 2].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
}

// ===== 경마/게임 관련 데이터 =====
const RACE_PAYOUT_MULTIPLIER = 5;
const horses = [
  { name: '썬더', emoji: '🐎' },
  { name: '스피드', emoji: '🐎' },
  { name: '라이트닝', emoji: '🐎' },
  { name: '블레이드', emoji: '🐎' },
  { name: '토네이도', emoji: '🐎' },
  { name: '스타', emoji: '🐎' },
  { name: '썬샤인', emoji: '🐎' },
];
const activeRaces = new Map();
const activeBlackjacks = new Map();
const suits = ['♠️', '♥️', '♦️', '♣️'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const activeBaccarat = new Map();

function drawCard(deck) {
  return deck.pop();
}
function calcHandValue(hand) {
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
function createDeck() {
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ suit: s, rank: r });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// =====  관련 함수 =====
// ===== 복권 발표용 채널 자동 탐색 함수 =====
async function findLotteryChannel(client) {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(
      c =>
        c.type === ChannelType.GuildText &&
        (c.name.includes('복권') || c.name.toLowerCase().includes('lottery'))
    );
    if (channel) return channel;
  }
  return null;
}

// ===== 복권 결과 계산 + 발표 함수 =====
export async function drawLotteryAndAnnounce(client, db, updateBalance, manual = false, interaction = null) {
  const today = new Date().toISOString().split('T')[0];
  const tickets = await db.all('SELECT * FROM lottery_tickets WHERE draw_date = ?', today);

  if (!tickets || tickets.length === 0) {
    const msg = '📭 오늘은 구매한 복권이 없습니다.';
    if (manual && interaction) return interaction.reply(msg);
    console.log(msg);
    return;
  }

  // 랜덤 6개 번호 (중복 없음)
  const available = Array.from({ length: 45 }, (_, i) => i + 1);
  const winning = [];
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * available.length);
    winning.push(available.splice(idx, 1)[0]);
  }
  winning.sort((a, b) => a - b);

  const results = [];

  for (const ticket of tickets) {
    const nums = ticket.numbers.split(',').map(n => parseInt(n.trim()));
    const matches = nums.filter(n => winning.includes(n)).length;
    const reward = matches === 6 ? 5000 : 0;

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

  if (manual && interaction) {
    return interaction.reply(resultText);
  }

  const channel = await findLotteryChannel(client);
  if (channel) {
    await channel.send(resultText);
    console.log(`✅ 복권 결과가 ${channel.name} 채널에 전송되었습니다.`);
  } else {
    console.warn('⚠️ 복권 결과를 보낼 채널을 찾을 수 없습니다.');
  }
}

// ===== 매일 오후 9시 자동 발표 =====
cron.schedule('0 21 * * *', async () => {
  try {
    await drawLotteryAndAnnounce(client, db, updateBalance);
  } catch (err) {
    console.error('💥 Cron 자동 발표 에러:', err);
  }
}, { timezone: 'Asia/Seoul' });

console.log('🕘 매일 오후 9시에 자동 복권 발표 스케줄러 등록 완료');

// ===== /복권결과 명령어 처리 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === '복권결과') {
    try {
      await drawLotteryAndAnnounce(interaction.client, db, updateBalance, true, interaction);
    } catch (err) {
      console.error('❌ /복권결과 처리 중 오류:', err);
      if (!interaction.replied) await interaction.reply('⚠️ 복권 결과 발표 중 오류가 발생했습니다.');
    }
  }
});


// ===== Discord interaction 처리 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, options } = interaction;
  const userData = await getUser(user.id);

  try {
    if (commandName === '돈줘') {
      const now = Date.now();
      if (now - userData.last_claim < 86400000) {
        return await interaction.reply({ content: '⏰ 이미 오늘 받았습니다.', ephemeral: true });
      }
      await db.run('UPDATE users SET last_claim=? WHERE id=?', now, user.id);
      const newBal = await updateBalance(user.id, 1000, '기본금 지급');
      return await interaction.reply(`💸 기본금 1000원 지급. 현재 잔고: ${newBal}원`);
    }

    if (commandName === '잔고') {
      return await interaction.reply(`💰 ${user.username}님의 잔고: ${userData.balance}원`);
    }

    if (commandName === '골라') {
      const opts = options.getString('옵션들').split(',').map(x => x.trim()).filter(Boolean);
      if (opts.length < 2) {
        return await interaction.reply('⚠️ 2개 이상 입력해주세요.');
      }
      const choice = opts[Math.floor(Math.random() * opts.length)];
      return await interaction.reply(`🎯 선택된 항목: **${choice}**`);
    }

    if (commandName === '슬롯') {
  const bet = options.getInteger('베팅') ?? 100;
  if (bet <= 0 || bet > userData.balance) 
    return await interaction.reply('❌ 베팅 금액 오류.');

  // 베팅 차감
  await updateBalance(user.id, -bet, '슬롯 베팅');

  // 슬롯 결과
  const result = spinSlot();
  let reward = 0;
  let penaltyText = '';

  const uniqueSymbols = new Set(result);

  // 당첨 계산
  if (uniqueSymbols.size === 1) reward = bet * 10;
  else if (uniqueSymbols.size === 2) reward = bet * 2;

  // 🍒 패널티 적용
  const cherryCount = result.filter(s => s === '🍒').length;
  if (cherryCount === 2) {
    reward -= 500;
    penaltyText = '💥 체리 2개! 500코인 차감!';
  } else if (cherryCount === 3) {
    reward -= 2000;
    penaltyText = '💀 체리 3개! 2000코인 차감!';
  }

  // 보상 업데이트
  if (reward !== 0) await updateBalance(user.id, reward, '슬롯 결과');

  const balance = (await getUser(user.id)).balance;

  return await interaction.reply(
    `🎰 ${result.join(' | ')}\n${reward > 0 ? `🎉 +${reward}` : reward < 0 ? `💸 ${reward}` : '꽝...'}${penaltyText ? `\n${penaltyText}` : ''}\n💰 잔고: ${balance}`
  );
}


    if (commandName === '복권구매') {
      let nums;
      const input = options.getString('번호');
      if (input) {
        nums = input.split(',').map(n => parseInt(n.trim()));
        if (nums.length !== 6 || nums.some(n => isNaN(n) || n < 1 || n > 45)) {
          return await interaction.reply('⚠️ 번호는 1~45 사이의 숫자 6개를 쉼표로 구분해 입력하세요. (예: 3,7,12,22,34,45)');
        }
      } else {
        const available = Array.from({ length: 45 }, (_, i) => i + 1);
        nums = [];
        for (let i = 0; i < 6; i++) {
          const randIndex = Math.floor(Math.random() * available.length);
          nums.push(available.splice(randIndex, 1)[0]);
        }
        nums.sort((a, b) => a - b);
      }

      const today = new Date().toISOString().split('T')[0];
      const exist = await db.get('SELECT * FROM lottery_tickets WHERE user_id = ? AND draw_date = ?', user.id, today);
      if (exist) return await interaction.reply('🎟️ 이미 오늘 복권을 구매했습니다.');
      if (userData.balance < 1000) return await interaction.reply('💸 잔고가 부족합니다. (필요 금액: 1000)');

      await updateBalance(user.id, -1000, '복권 구매');
      await db.run('INSERT INTO lottery_tickets(user_id, numbers, draw_date) VALUES(?, ?, ?)', user.id, nums.join(','), today);

      return await interaction.reply(`🎟️ 복권 구매 완료!\n번호: ${nums.join(', ')}`);
    }

    if (commandName === '복권상태') {
      const today = new Date().toISOString().split('T')[0];
      const ticket = await db.get('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      return await interaction.reply(ticket ? `🎟️ 오늘 구매 번호: ${ticket.numbers}` : '❌ 오늘 구매하지 않음');
    }

    if (commandName === '복권결과') {
      return await drawLotteryAndAnnounce(client, db, updateBalance, true, interaction);
    }

    if (commandName === '관리자지급') {
      if (!ADMIN_IDS.includes(user.id)) return await interaction.reply('❌ 관리자만 사용 가능');
      const target = options.getUser('대상');
      const amt = options.getInteger('금액');
      const newBal = await updateBalance(target.id, amt, '관리자 지급');
      return await interaction.reply(`✅ ${target.username}에게 ${amt}원 지급. (잔고: ${newBal})`);
    }

    // 블랙잭/바카라 명령어는 수동 버튼 처리로 개선
    if (commandName === '블랙잭') {
      const bet = options.getInteger('베팅');
      if (bet <= 0 || bet > userData.balance) return await interaction.reply('💸 베팅 금액 오류');
      await updateBalance(user.id, -bet, '블랙잭 베팅');
      return await startBlackjack(interaction, bet);
    }

    if (commandName === '바카라') {
      const bet = options.getInteger('베팅');
      const choice = options.getString('선택');
      if (bet <= 0 || bet > userData.balance) return await interaction.reply('💸 베팅 금액 오류');
      const side = choice === '플레이어' ? '플레이어' : choice === '뱅커' ? '뱅커' : '타이';
      await updateBalance(user.id, -bet, '바카라 베팅');
      return await startBaccarat(interaction, bet, side);
    }

  } catch (err) {
    console.error('❌ 인터랙션 처리 중 오류:', err);
    try {
      if (!interaction.replied) await interaction.reply('⚠️ 명령어 처리 중 오류가 발생했습니다.');
    } catch {}
  }
});

if (commandName === '복권구매') {
  let nums;
  const input = options.getString('번호');
  if (input) {
    nums = input.split(',').map(n => parseInt(n.trim()));
    if (nums.length !== 6 || nums.some(n => isNaN(n) || n < 1 || n > 45)) {
      await interaction.reply('⚠️ 번호는 1~45 사이의 숫자 6개를 쉼표로 구분해 입력하세요. (예: 3,7,12,22,34,45)');
      return; // 함수 종료
    }
  } else {
    const available = Array.from({ length: 45 }, (_, i) => i + 1);
    nums = [];
    for (let i = 0; i < 6; i++) {
      const randIndex = Math.floor(Math.random() * available.length);
      nums.push(available.splice(randIndex, 1)[0]);
    }
    nums.sort((a, b) => a - b);
  }

  const today = new Date().toISOString().split('T')[0];
  const exist = await db.get('SELECT * FROM lottery_tickets WHERE user_id = ? AND draw_date = ?', user.id, today);

  if (exist) {
    await interaction.reply('🎟️ 이미 오늘 복권을 구매했습니다.');
    return;
  }

  if (userData.balance < 1000) {
    await interaction.reply('💸 잔고가 부족합니다. (필요 금액: 1000)');
    return;
  }

  await updateBalance(user.id, -1000, '복권 구매');
  await db.run('INSERT INTO lottery_tickets(user_id, numbers, draw_date) VALUES(?, ?, ?)', user.id, nums.join(','), today);

  await interaction.reply(`🎟️ 복권 구매 완료!\n번호: ${nums.join(', ')}`);
}

    if (commandName === '복권상태') {
      const today = new Date().toISOString().split('T')[0];
      const ticket = await db.get('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      return interaction.reply(ticket ? `🎟️ 오늘 구매 번호: ${ticket.numbers}` : '❌ 오늘 구매하지 않음');
    }

    if (commandName === '복권결과') {
      return drawLotteryAndAnnounce(interaction.client, true, interaction);
    }

    if (commandName === '관리자지급') {
      if (!ADMIN_IDS.includes(user.id)) return interaction.reply('❌ 관리자만 사용 가능');
      const target = options.getUser('대상');
      const amt = options.getInteger('금액');
      const newBal = await updateBalance(target.id, amt, '관리자 지급');
      return interaction.reply(`✅ ${target.displayname}에게 ${amt}원 지급. (잔고: ${newBal})`);
    }

    if (commandName === '경마') {
      const bet = options.getInteger('베팅');
      const horseNum = options.getInteger('말번호');
      if (bet <= 0 || bet > userData.balance) return interaction.reply('💸 베팅 금액 오류');
      if (horseNum < 1 || horseNum > horses.length) return interaction.reply('❌ 말 번호 오류');
      await updateBalance(user.id, -bet, '경마 베팅');
      const bettors = new Map([[user.id, { bet, horseIndex: horseNum - 1 }]]);
      return startRace(interaction.channel, bettors);
    }

    if (commandName === '블랙잭') {
      const bet = options.getInteger('베팅');
      if (bet <= 0 || bet > userData.balance) return interaction.reply('💸 베팅 금액 오류');
      await updateBalance(user.id, -bet, '블랙잭 베팅');
      return startBlackjack(interaction, bet);
    }

    if (commandName === '바카라') {
      const bet = options.getInteger('베팅');
      const choice = options.getString('선택');
      if (bet <= 0 || bet > userData.balance) return interaction.reply('💸 베팅 금액 오류');
      const side = choice === '플레이어' ? '플레이어' : choice === '뱅커' ? '뱅커' : '타이';
      await updateBalance(user.id, -bet, '바카라 베팅');
      return startBaccarat(interaction, bet, side);
    }
  } catch (err) {
    console.error('❌ 인터랙션 처리 중 오류:', err);
    try {
      if (!interaction.replied) await interaction.reply('⚠️ 명령어 처리 중 오류가 발생했습니다.');
    } catch {}
  }
});

// ===== 블랙잭 함수 =====
async function playBlackjack(interaction, bet) {
  if (bet <= 0 || bet > userData.balance) {
    await interaction.reply('💸 베팅 금액 오류');
  }
  await updateBalance(interaction.user.id, -bet, '블랙잭 베팅');

  const deck = createDeck();
  const playerHand = [drawCard(deck), drawCard(deck)];
  const dealerHand = [drawCard(deck), drawCard(deck)];

  const playerVal = calcHandValue(playerHand);
  const dealerVal = calcHandValue(dealerHand);

  let resultText;
  if (playerVal > 21) {
    resultText = `💀 버스트! 패배... -${bet}코인`;
  } else if (dealerVal > 21 || playerVal > dealerVal) {
    await updateBalance(interaction.user.id, bet * 2, '블랙잭 승리');
    resultText = `🎉 승리! +${bet}코인`;
  } else if (playerVal === dealerVal) {
    await updateBalance(interaction.user.id, bet, '블랙잭 무승부'); // 원금 반환
    resultText = `🤝 무승부`;
  } else {
    resultText = `💀 패배! -${bet}코인`;
  }

  await interaction.reply(
    `🃏 **블랙잭 결과**\n딜러: ${dealerHand.map(c => `${c.suit}${c.rank}`).join(' ')} (${dealerVal})\n플레이어: ${playerHand.map(c => `${c.suit}${c.rank}`).join(' ')} (${playerVal})\n${resultText}`
  );
}

// ===== 바카라 함수 =====
async function playBaccarat(interaction, bet, choice) {
  if (bet <= 0 || bet > userData.balance) {
    await interaction.reply('💸 베팅 금액 오류');
  }
  await updateBalance(interaction.user.id, -bet, '바카라 베팅');

  const deck = createDeck();
  const player = [drawCard(deck), drawCard(deck)];
  const banker = [drawCard(deck), drawCard(deck)];
  const playerVal = baccaratValue(player);
  const bankerVal = baccaratValue(banker);

  let result = '', payout = 0;
  let winSide = playerVal > bankerVal ? '플레이어' : playerVal < bankerVal ? '뱅커' : '타이';

  if (choice === winSide) {
    if (winSide === '플레이어') payout = bet * 2;
    else if (winSide === '뱅커') payout = Math.floor(bet * 1.95);
    else payout = bet * 8;
    await updateBalance(interaction.user.id, payout, '바카라 승리');
    result = `🎉 ${winSide} 승리! +${payout}코인`;
  } else {
    result = `💀 ${winSide} 승리... 선택(${choice}) 패배`;
  }

  await interaction.reply(
    `🎴 **바카라 결과**\n플레이어: ${player.map(c => `${c.suit}${c.rank}`).join(' ')} (${playerVal})\n뱅커: ${banker.map(c => `${c.suit}${c.rank}`).join(' ')} (${bankerVal})\n${result}`
  );
}

// ===== 경마 함수 =====
async function startRace(channel, bettors) {
  let positions = Array(horses.length).fill(0);
  const trackLength = 30;
  const msg = await channel.send('🏁 경주 시작! 잠시만 기다려주세요...');
  return new Promise((resolve) => {
    let finished = false;
    const interval = setInterval(async () => {
      for (let i = 0; i < horses.length; i++) {
        positions[i] += Math.floor(Math.random() * 3);
        if (positions[i] > trackLength) positions[i] = trackLength;
      }
      const raceMsg = positions
        .map((p, i) => `${horses[i].emoji} ${horses[i].name.padEnd(8, ' ')} |${'·'.repeat(p)}${' '.repeat(trackLength - p)}🏁`)
        .join('\n');
      try {
        await msg.edit(`🏇 경주 중...\n\n${raceMsg}`);
      } catch {}
      const winnerIdx = positions.findIndex((p) => p >= trackLength);
      if (winnerIdx !== -1) {
        finished = true;
        clearInterval(interval);
        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) await updateBalance(uid, Number(b.bet) * RACE_PAYOUT_MULTIPLIER, '경마 승리');
        }
        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} ${horses[winnerIdx].emoji}`);
        resolve(winnerIdx);
      }
    }, 1000);
    setTimeout(() => {
      if (!finished) {
        clearInterval(interval);
        msg.reply('⏱ 경주 시간초과 종료');
        resolve(null);
      }
    }, 40000);
  });
}

// ===== 절대 안꺼지게 (가벼운 루프 유지) =====
setInterval(() => {}, 60 * 1000);

// Discord 로그인 자동 재시도
async function loginBot() {
  try {
    await client.login(TOKEN);
    console.log(`🤖 로그인 성공: ${client.user.tag}`);
  } catch (err) {
    console.error('💥 로그인 실패. 5초 후 재시도:', err);
    setTimeout(loginBot, 5000);
  }
}

// ===== 시작 =====
initDB().then(() => loginBot()).catch((e) => console.error('DB 초기화 실패:', e));

client.once('ready', () => console.log(`🤖 로그인됨: ${client.user.tag}`));

















