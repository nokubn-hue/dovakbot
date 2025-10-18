import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

// ----- 환경 변수 -----
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];

const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(3000, () => console.log('✅ 서버가 실행되었습니다.'));

// ----- 클라이언트 초기화 -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
});

let db;

// ----- DB 초기화 -----
async function initDB() {
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

// ----- 유틸 함수 -----
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
    let newBalance = Math.max(0, user.balance + amount);
    await db.run('UPDATE users SET balance = ? WHERE id = ?', newBalance, userId);
    await db.run('INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?, ?, ?, ?)', userId, amount, reason, Date.now());
    await db.run('COMMIT');
    return newBalance;
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('💥 Balance update error:', err);
    throw err;
  }
}

// ----- 명령어 정의 -----
const commands = [
  new SlashCommandBuilder().setName('돈줘').setDescription('하루에 한 번 기본금을 받습니다.'),
  new SlashCommandBuilder().setName('잔고').setDescription('현재 잔고를 확인합니다.'),
  new SlashCommandBuilder().setName('골라')
    .setDescription('여러 옵션 중 하나를 무작위로 선택합니다.')
    .addStringOption(opt => opt.setName('옵션들').setDescription('쉼표로 구분된 옵션들').setRequired(true)),
  new SlashCommandBuilder().setName('슬롯')
    .setDescription('슬롯머신을 돌립니다.')
    .addIntegerOption(opt => opt.setName('베팅').setDescription('베팅 금액을 입력하세요.').setRequired(false)),
  new SlashCommandBuilder().setName('복권구매')
    .setDescription('복권을 구매합니다.')
    .addStringOption(opt => opt.setName('번호').setDescription('1~45 중 6개 번호를 쉼표로 입력').setRequired(true)),
  new SlashCommandBuilder().setName('복권상태').setDescription('오늘의 복권 구매 상태를 확인합니다.'),
  new SlashCommandBuilder().setName('경마')
    .setDescription('랜덤 경마를 진행합니다.')
    .addIntegerOption(opt => opt.setName('베팅').setDescription('베팅 금액').setRequired(true))
    .addIntegerOption(opt => opt.setName('말번호').setDescription('1~5 중 하나 선택').setRequired(true)),
  new SlashCommandBuilder().setName('관리자지급')
    .setDescription('관리자가 유저에게 포인트를 지급합니다.')
    .addUserOption(opt => opt.setName('대상').setDescription('유저 선택').setRequired(true))
    .addIntegerOption(opt => opt.setName('금액').setDescription('지급할 금액').setRequired(true)),
];

// ----- 명령어 등록 -----
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ 명령어 등록 완료');
  } catch (err) {
    console.error('명령어 등록 실패:', err);
  }
})();

// ----- 슬롯머신 -----
function spinSlot() {
  const symbols = ['🍒', '🍋', '🍇', '💎', '7️⃣'];
  return [0, 1, 2].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
}

// ----- 복권 자동 추첨 -----
cron.schedule('0 21 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  const tickets = await db.all('SELECT * FROM lottery_tickets WHERE draw_date = ?', today);
  if (!tickets.length) return;
  const winning = Array.from({ length: 6 }, () => Math.floor(Math.random() * 45) + 1);
  console.log('🎯 오늘의 복권 당첨번호:', winning.join(', '));

  for (const ticket of tickets) {
    const nums = ticket.numbers.split(',').map(n => parseInt(n.trim()));
    const matches = nums.filter(n => winning.includes(n)).length;
    if (matches >= 3) {
      const reward = matches === 6 ? 100000 : matches === 5 ? 10000 : 1000;
      await updateBalance(ticket.user_id, reward, `복권 ${matches}개 일치 보상`);
    }
  }
}, { timezone: 'Asia/Seoul' });

// ----- 인터랙션 핸들러 -----
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, options } = interaction;
  const userData = await getUser(user.id);

  switch (commandName) {
    case '돈줘': {
      const now = Date.now();
      if (now - userData.last_claim < 86400000)
        return interaction.reply({ content: '⏰ 이미 오늘 받았습니다. 내일 다시 시도하세요.', ephemeral: true });
      await db.run('UPDATE users SET last_claim = ? WHERE id = ?', now, user.id);
      const newBal = await updateBalance(user.id, 500, '기본금 지급');
      return interaction.reply(`💸 기본금 500원을 받았습니다. 현재 잔고: ${newBal}원`);
    }

    case '잔고': {
      return interaction.reply(`💰 ${user.username}님의 현재 잔고는 ${userData.balance}원입니다.`);
    }

    case '골라': {
      const opts = options.getString('옵션들').split(',').map(x => x.trim()).filter(Boolean);
      if (opts.length < 2) return interaction.reply('⚠️ 2개 이상 입력해주세요.');
      const choice = opts[Math.floor(Math.random() * opts.length)];
      return interaction.reply(`🎯 선택된 항목: **${choice}**`);
    }

    case '슬롯': {
      const bet = options.getInteger('베팅') ?? 100;
      if (bet <= 0 || bet > userData.balance) return interaction.reply('❌ 베팅 금액이 잘못되었습니다.');
      await updateBalance(user.id, -bet, '슬롯 베팅');
      const result = spinSlot();
      const msg = result.join(' | ');
      let reward = 0;
      if (new Set(result).size === 1) reward = bet * 10;
      else if (new Set(result).size === 2) reward = bet * 2;
      if (reward > 0) await updateBalance(user.id, reward, '슬롯 당첨');
      return interaction.reply(`🎰 결과: ${msg}\n${reward > 0 ? `당첨! +${reward}` : '꽝...'}\n💰 잔고: ${(await getUser(user.id)).balance}`);
    }

    case '복권구매': {
      const nums = options.getString('번호').split(',').map(n => parseInt(n.trim()));
      if (nums.length !== 6 || nums.some(n => n < 1 || n > 45))
        return interaction.reply('⚠️ 1~45 중 6개의 번호를 입력하세요.');
      const today = new Date().toISOString().split('T')[0];
      const exist = await db.get('SELECT * FROM lottery_tickets WHERE user_id = ? AND draw_date = ?', user.id, today);
      if (exist) return interaction.reply('🎫 이미 오늘 복권을 구매했습니다.');
      if (userData.balance < 100) return interaction.reply('💸 잔고가 부족합니다.');
      await updateBalance(user.id, -100, '복권 구매');
      await db.run('INSERT INTO lottery_tickets (user_id, numbers, draw_date) VALUES (?, ?, ?)', user.id, nums.join(','), today);
      return interaction.reply(`🎟️ 복권 구매 완료! 번호: ${nums.join(', ')}`);
    }

    case '복권상태': {
      const today = new Date().toISOString().split('T')[0];
      const ticket = await db.get('SELECT * FROM lottery_tickets WHERE user_id = ? AND draw_date = ?', user.id, today);
      return interaction.reply(ticket ? `🎟️ 오늘 구매한 번호: ${ticket.numbers}` : '❌ 오늘 복권을 구매하지 않았습니다.');
    }


    case '관리자지급': {
      if (!ADMIN_IDS.includes(user.id)) return interaction.reply('❌ 관리자만 사용 가능합니다.');
      const target = options.getUser('대상');
      const amt = options.getInteger('금액');
      const newBal = await updateBalance(target.id, amt, '관리자 지급');
      return interaction.reply(`✅ ${target.username}에게 ${amt}원을 지급했습니다. (현재 잔고: ${newBal})`);
    }
  }
});


// ======== 블랙잭 & 바카라 & 개선된 경마 ========

// ----- 경마 개선 코드 -----
const horses = [
  { name: "썬더", emoji: "🐎" },
  { name: "스피드", emoji: "🐎" },
  { name: "라이트닝", emoji: "🐎" },
  { name: "블레이드", emoji: "🐎" },
  { name: "토네이도", emoji: "🐎" },
  { name: "스타", emoji: "🐎" },
  { name: "썬샤인", emoji: "🐎" },
];
const activeRaces = new Map();

async function startRace(channel, bettors) {
  let positions = new Array(horses.length).fill(0);
  const trackLength = 30;
  const msg = await channel.send("🏁 경주 시작! 잠시만 기다려주세요...");
  return new Promise(resolve => {
    let finished = false;
    const interval = setInterval(async () => {
      for (let i = 0; i < horses.length; i++) {
        positions[i] += Math.floor(Math.random() * 3);
        if (positions[i] > trackLength) positions[i] = trackLength;
      }
      const raceMsg = positions
        .map((p, i) => `${horses[i].emoji} ${horses[i].name.padEnd(8, " ")} |${"·".repeat(p)}${" ".repeat(Math.max(0, trackLength - p))}🏁`)
        .join("\n");
      try {
        await msg.edit(`🏇 경주 중...\n\n${raceMsg}`);
      } catch (e) {}
      const winnerIdx = positions.findIndex(p => p >= trackLength);
      if (winnerIdx !== -1) {
        finished = true;
        clearInterval(interval);
        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) {
            const payout = Number(b.bet) * Number(5);
            await updateBalance(uid, payout, "경마 승리");
          }
        }
        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} ${horses[winnerIdx].emoji} (번호 ${winnerIdx + 1})`);
        resolve(winnerIdx);
      }
    }, 1000);
    setTimeout(() => {
      if (!finished) {
        clearInterval(interval);
        msg.reply("⏱ 경주 시간초과 종료");
        resolve(null);
      }
    }, 40000);
  });
}

// ----- 블랙잭 -----
const activeBlackjacks = new Map();
const suits = ["♠️", "♥️", "♦️", "♣️"];
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function drawCard(deck) {
  const card = deck.pop();
  return card;
}

function calcHandValue(hand) {
  let value = 0;
  let aces = 0;
  for (const c of hand) {
    if (["J", "Q", "K"].includes(c.rank)) value += 10;
    else if (c.rank === "A") {
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
  for (const s of suits)
    for (const r of ranks)
      deck.push({ suit: s, rank: r });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

async function startBlackjack(interaction, bet) {
  const deck = createDeck();
  const playerHand = [drawCard(deck), drawCard(deck)];
  const dealerHand = [drawCard(deck), drawCard(deck)];

  activeBlackjacks.set(interaction.user.id, {
    deck,
    playerHand,
    dealerHand,
    bet,
  });

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('hit').setLabel('히트').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('stand').setLabel('스탠드').setStyle(ButtonStyle.Secondary)
    );

  const msg = await interaction.reply({
    content: renderBlackjack(interaction.user.username, playerHand, dealerHand, false),
    components: [row],
    fetchReply: true
  });

  const collector = msg.createMessageComponentCollector({ time: 30000 });
  collector.on('collect', async (btn) => {
    if (btn.user.id !== interaction.user.id) {
      return btn.reply({ content: '❌ 당신의 게임이 아닙니다.', ephemeral: true });
    }
    const game = activeBlackjacks.get(interaction.user.id);
    if (!game) return;

    if (btn.customId === 'hit') {
      game.playerHand.push(drawCard(game.deck));
      const playerVal = calcHandValue(game.playerHand);
      if (playerVal > 21) {
        collector.stop('bust');
        await btn.update({ content: renderBlackjack(interaction.user.username, game.playerHand, game.dealerHand, true, '버스트! 패배...'), components: [] });
        await updateBalance(interaction.user.id, -bet, '블랙잭 패배');
        activeBlackjacks.delete(interaction.user.id);
        return;
      }
      await btn.update({ content: renderBlackjack(interaction.user.username, game.playerHand, game.dealerHand, false), components: [row] });
    } else if (btn.customId === 'stand') {
      collector.stop('stand');
      await dealerTurn(interaction, game);
    }
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      await interaction.editReply({ content: '⏰ 시간 초과로 게임이 종료되었습니다.', components: [] });
      activeBlackjacks.delete(interaction.user.id);
    }
  });
}

function renderBlackjack(username, playerHand, dealerHand, revealDealer = false, resultText = null) {
  const playerVal = calcHandValue(playerHand);
  const dealerVal = revealDealer ? calcHandValue(dealerHand) : '?';
  const dealerShow = revealDealer
    ? dealerHand.map(c => `${c.suit}${c.rank}`).join(' ')
    : `${dealerHand[0].suit}${dealerHand[0].rank} ??`;

  return `🃏 **${username}의 블랙잭**  
딜러: ${dealerShow} (${dealerVal})
플레이어: ${playerHand.map(c => `${c.suit}${c.rank}`).join(' ')} (${playerVal})
${resultText ? `\n${resultText}` : ''}`;
}

async function dealerTurn(interaction, game) {
  while (calcHandValue(game.dealerHand) < 17) {
    game.dealerHand.push(drawCard(game.deck));
  }

  const playerVal = calcHandValue(game.playerHand);
  const dealerVal = calcHandValue(game.dealerHand);

  let result = '';
  if (dealerVal > 21 || playerVal > dealerVal) {
    result = `🎉 승리! +${game.bet}`;
    await updateBalance(interaction.user.id, game.bet, '블랙잭 승리');
  } else if (playerVal === dealerVal) {
    result = '🤝 무승부! (베팅 반환)';
  } else {
    result = '💀 패배!';
    await updateBalance(interaction.user.id, -game.bet, '블랙잭 패배');
  }

  await interaction.editReply({
    content: renderBlackjack(interaction.user.username, game.playerHand, game.dealerHand, true, result),
    components: []
  });
  activeBlackjacks.delete(interaction.user.id);
}

// ----- 바카라 -----
const activeBaccarat = new Map();

function baccaratValue(cards) {
  let total = cards.reduce((acc, c) => {
    if (['J', 'Q', 'K', '10'].includes(c.rank)) return acc;
    if (c.rank === 'A') return acc + 1;
    return acc + parseInt(c.rank);
  }, 0);
  return total % 10;
}

async function startBaccarat(interaction, bet, side) {
  const deck = createDeck();
  const player = [drawCard(deck), drawCard(deck)];
  const banker = [drawCard(deck), drawCard(deck)];

  const playerVal = baccaratValue(player);
  const bankerVal = baccaratValue(banker);

  let result = '';
  let winSide = '';
  if (playerVal > bankerVal) winSide = '플레이어';
  else if (playerVal < bankerVal) winSide = '뱅커';
  else winSide = '타이';

  if (side === winSide) {
    let payout = bet;
    if (side === '플레이어') payout = bet * 2;
    else if (side === '뱅커') payout = bet * 1.95;
    else if (side === '타이') payout = bet * 8;
    await updateBalance(interaction.user.id, payout - bet, '바카라 승리');
    result = `🎉 ${winSide} 승리! +${Math.floor(payout - bet)}`;
  } else {
    await updateBalance(interaction.user.id, -bet, '바카라 패배');
    result = `💀 ${winSide} 승리... 당신의 선택(${side})은 패배했습니다.`;
  }

  return interaction.reply(`🎴 **바카라 결과**
플레이어: ${player.map(c => `${c.suit}${c.rank}`).join(' ')} (${playerVal})
뱅커: ${banker.map(c => `${c.suit}${c.rank}`).join(' ')} (${bankerVal})
${result}`);
}

// ----- 명령어 등록 확장 -----
(async () => {
  try {
    const newCommands = [
      new SlashCommandBuilder()
        .setName('블랙잭')
        .setDescription('블랙잭을 플레이합니다.')
        .addIntegerOption(opt => opt.setName('베팅').setDescription('베팅 금액').setRequired(true)),
      new SlashCommandBuilder()
        .setName('바카라')
        .setDescription('바카라를 플레이합니다.')
        .addIntegerOption(opt => opt.setName('베팅').setDescription('베팅 금액').setRequired(true))
        .addStringOption(opt => opt.setName('선택').setDescription('플레이어 / 뱅커 / 타이').setRequired(true))
    ];
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [...commands, ...newCommands] });
    console.log('✅ 블랙잭 / 바카라 명령어 등록 완료');
  } catch (err) {
    console.error('명령어 등록 실패:', err);
  }
})();

// ----- 명령어 처리 확장 -----
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === '블랙잭') {
    const bet = interaction.options.getInteger('베팅');
    const user = await getUser(interaction.user.id);
    if (bet <= 0 || bet > user.balance)
      return interaction.reply('💸 베팅 금액이 잘못되었거나 잔고가 부족합니다.');
    await updateBalance(interaction.user.id, -bet, '블랙잭 베팅');
    return startBlackjack(interaction, bet);
  }

  if (interaction.commandName === '바카라') {
    const bet = interaction.options.getInteger('베팅');
    const choice = interaction.options.getString('선택');
    const user = await getUser(interaction.user.id);
    if (bet <= 0 || bet > user.balance)
      return interaction.reply('💸 베팅 금액이 잘못되었거나 잔고가 부족합니다.');
    const side = choice === '플레이어' ? '플레이어' : choice === '뱅커' ? '뱅커' : '타이';
    await updateBalance(interaction.user.id, -bet, '바카라 베팅');
    return startBaccarat(interaction, bet, side);
  }
});

client.once('ready', () => console.log(`🤖 로그인됨: ${client.user.tag}`));
initDB().then(() => client.login(TOKEN));
