// index.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } from "discord.js";
import process from "process";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("봇 실행 중"));
app.listen(PORT, () => console.log(`웹서버 포트 ${PORT}에서 실행 중`));

// -------------------
// 환경 변수
// -------------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

// -------------------
// 기본 설정
// -------------------
const DEFAULT_STARTING = 1000;
const SLOT_DEFAULT_BET = 100;
const TABLE_MIN_BET = 100;
const RACE_PAYOUT_MULTIPLIER = 5; // 스테이크 포함 (예: 5이면 순이익은 +4배)

// -------------------
// DB 초기화
// -------------------
let db;
async function initDB() {
  db = await open({ filename: "./dovakbot.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0,
      last_claim INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      delta INTEGER,
      reason TEXT,
      ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      ticket_number TEXT,
      ts INTEGER
    );
  `);
  console.log("DB 연결 성공");
}

// -------------------
// 유틸
// -------------------
function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

async function getUser(userId) {
  const row = await db.get("SELECT * FROM users WHERE id = ?", userId);
  if (!row) {
    await db.run("INSERT INTO users(id, balance, last_claim) VALUES(?,?,?)", userId, 0, 0);
    return await db.get("SELECT * FROM users WHERE id = ?", userId);
  }
  return { id: row.id, balance: Number(row.balance || 0), last_claim: row.last_claim || 0 };
}

async function changeBalance(userId, delta, reason = "adjust") {
  const d = Number(delta) || 0;
  await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", userId, d, reason, Date.now());
  await db.run("UPDATE users SET balance = balance + ? WHERE id = ?", d, userId);
  return await getUser(userId);
}

// -------------------
// Discord Client
// -------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// -------------------
// 슬롯
// -------------------
function spinSlot() {
  const reels = ["🍒", "🍋", "🍊", "🔔", "⭐", "7️⃣"];
  const r1 = reels[Math.floor(Math.random() * reels.length)];
  const r2 = reels[Math.floor(Math.random() * reels.length)];
  const r3 = reels[Math.floor(Math.random() * reels.length)];
  let multiplier = 0;
  if (r1 === r2 && r2 === r3) {
    if (r1 === "7️⃣") multiplier = 10;
    else if (r1 === "⭐") multiplier = 6;
    else multiplier = 4;
  } else if (r1 === r2 || r2 === r3 || r1 === r3) multiplier = 2;
  return { r1, r2, r3, multiplier };
}

// -------------------
// 블랙잭 헬퍼
// -------------------
function createDeck() {
  const faces = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];
  for (let i = 0; i < 4; i++) for (const f of faces) deck.push(f);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcBlackjack(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c === "A") { aces++; total += 11; }
    else if (["J", "Q", "K"].includes(c)) total += 10;
    else total += Number(c);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

// -------------------
// 복권
// -------------------
async function runLotteryDraw(channel) {
  const tickets = await db.all("SELECT * FROM lottery_tickets");
  if (tickets.length === 0) { if (channel) channel.send("오늘 복권 참여자가 없습니다."); return; }
  const winnerTicket = tickets[Math.floor(Math.random() * tickets.length)];
  const winnerId = winnerTicket.user_id;
  const prize = tickets.length * 100;
  await changeBalance(winnerId, prize, "lottery_prize");
  await db.run("DELETE FROM lottery_tickets");
  if (channel) channel.send(`<@${winnerId}> 님이 복권 당첨! 상금: ${prize}포인트 🎉`);
}

function scheduleLottery(channelId) {
  cron.schedule("0 0 21 * * *", async () => {
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    await runLotteryDraw(channel);
  }, { timezone: "Asia/Seoul" });
}

// -------------------
// 블랙잭 & 바카라 상태
// -------------------
const activeBlackjacks = new Map();
const activeBaccarat = new Map();

// -------------------
// 경마 시스템
// -------------------
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

  return new Promise((resolve) => {
    let finished = false;

    const interval = setInterval(async () => {
      for (let i = 0; i < horses.length; i++) {
        // 전진량: 0~2 랜덤 (속도 임의화)
        positions[i] += Math.floor(Math.random() * 3);
        if (positions[i] > trackLength) positions[i] = trackLength;
      }

      const raceMsg = positions
        .map((p, i) => `${horses[i].emoji} ${horses[i].name.padEnd(8, " ")} |${"·".repeat(p)}${" ".repeat(Math.max(0, trackLength - p))}🏁`)
        .join("\n");

      try { await msg.edit(`🏇 경주 중...\n\n${raceMsg}`); } catch (e) { console.warn("메시지 편집 실패:", e.message); }

      const winnerIdx = positions.findIndex(p => p >= trackLength);
      if (winnerIdx !== -1) {
        finished = true;
        clearInterval(interval);

        // 정산: 베팅은 이미 차감되어 있으므로 (스테이크 포함) '배당 곱셈'만 지급
        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) {
            const payout = Number(b.bet) * Number(RACE_PAYOUT_MULTIPLIER);
            await changeBalance(uid, payout, "race_win"); // 이미 -bet 되어 있으므로 net = -bet + payout
          }
        }

        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} ${horses[winnerIdx].emoji} (번호 ${winnerIdx + 1})`);
        resolve(winnerIdx);
      }
    }, 1000);

    setTimeout(() => {
      if (!finished) {
        clearInterval(interval);
        msg.reply("⏱ 경주가 시간초과로 종료되었습니다.");
        resolve(null);
      }
    }, 40000);
  });
}

// -------------------
// interactionCreate (명령 처리)
// -------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

// ------------------- 🃏 바카라 -------------------
if (cmd === "바카라") {
  await interaction.deferReply();
  const uid = interaction.user.id;
  const side = interaction.options.getString("배팅방향") || "플레이어"; // 기본값
  const bet = Number(interaction.options.getInteger("배팅") ?? 100);

  const user = await getUser(uid);
  if (!["플레이어", "뱅커", "무승부"].includes(side)) {
    return interaction.editReply("배팅방향은 플레이어 / 뱅커 / 무승부 중 하나여야 합니다.");
  }
  if (bet <= 0) return interaction.editReply("배팅 금액은 1 이상이어야 합니다.");
  if (user.balance < bet) return interaction.editReply("잔고가 부족합니다.");

  // 배팅 금액 차감
  await changeBalance(uid, -bet, "baccarat_bet");

  // 카드 덱 생성
  const deck = createDeck();
  const draw = () => deck.pop();

  const playerCards = [draw(), draw()];
  const bankerCards = [draw(), draw()];

  const baccaratValue = (card) => {
    if (["J", "Q", "K", "10"].includes(card)) return 0;
    if (card === "A") return 1;
    return Number(card);
  };

  const calcBaccaratTotal = (cards) => cards.reduce((a, c) => a + baccaratValue(c), 0) % 10;

  const playerTotal = calcBaccaratTotal(playerCards);
  const bankerTotal = calcBaccaratTotal(bankerCards);

  let winner;
  if (playerTotal > bankerTotal) winner = "플레이어";
  else if (bankerTotal > playerTotal) winner = "뱅커";
  else winner = "무승부";

  let payout = 0;
  // ⚠️ 변수 이름 변경 (resultText → baccaratResultText)
  let baccaratResultText = `🎴 **바카라 결과** 🎴
플레이어: ${playerCards.join(", ")} (${playerTotal})
뱅커: ${bankerCards.join(", ")} (${bankerTotal})
--------------------------\n`;

  if (side === winner) {
    if (winner === "플레이어") payout = bet * 2;
    else if (winner === "뱅커") payout = Math.floor(bet * 1.95);
    else if (winner === "무승부") payout = bet * 9;

    await changeBalance(uid, payout, "baccarat_win");
    baccaratResultText += `✅ 당신이 선택한 ${side} 승리!\n💰 상금 ${payout}포인트 지급되었습니다.`;
  } else {
    baccaratResultText += `❌ 당신이 선택한 ${side}이(가) 패배했습니다.\n💸 배팅액 ${bet}포인트가 차감되었습니다.`;
  }

  const newBal = (await getUser(uid)).balance;
  baccaratResultText += `\n\n현재 잔고: ${newBal}포인트`;

  return interaction.editReply(baccaratResultText);
}

  } catch (err) {
    console.error("interaction 처리 중 오류:", err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply("명령 처리 중 오류가 발생했습니다.");
      else await interaction.reply({ content: "명령 처리 중 오류가 발생했습니다.", ephemeral: true });
    } catch(e){}
  }
});

// ------------------- ♠ 블랙잭 -------------------
if (cmd === "블랙잭") {
  try {
    await interaction.deferReply();
    const uid = interaction.user.id;
    const bet = Number(interaction.options.getInteger("배팅") ?? 100);

    const user = await getUser(uid);
    if (bet <= 0) return interaction.editReply("배팅 금액은 1 이상이어야 합니다.");
    if (user.balance < bet) return interaction.editReply("잔고가 부족합니다.");

    // 💰 배팅 금액 차감
    await changeBalance(uid, -bet, "blackjack_bet");

    // 카드 덱 생성
    const deck = [];
    const suits = ["♠", "♥", "♦", "♣"];
    const values = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    for (const s of suits) for (const v of values) deck.push(v + s);
    deck.sort(() => Math.random() - 0.5);

    const draw = () => deck.pop();

    const getValue = (cards) => {
      let total = 0;
      let aces = 0;
      for (const c of cards) {
        const v = c.slice(0, -1);
        if (["J", "Q", "K"].includes(v)) total += 10;
        else if (v === "A") {
          total += 11;
          aces++;
        } else total += Number(v);
      }
      while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
      }
      return total;
    };

    const playerCards = [draw(), draw()];
    const dealerCards = [draw(), draw()];

    let playerTotal = getValue(playerCards);
    let dealerTotal = getValue(dealerCards);

    let blackjackResultText = `🃏 **블랙잭 시작!**  
당신의 카드: ${playerCards.join(", ")} (${playerTotal})  
딜러의 카드: ${dealerCards[0]}, ❓`;

    await interaction.editReply(blackjackResultText);

    // 자동 진행
    while (playerTotal < 17) {
      playerCards.push(draw());
      playerTotal = getValue(playerCards);
    }

    while (dealerTotal < 17) {
      dealerCards.push(draw());
      dealerTotal = getValue(dealerCards);
    }

    let winner;
    if (playerTotal > 21) winner = "딜러";
    else if (dealerTotal > 21) winner = "플레이어";
    else if (playerTotal > dealerTotal) winner = "플레이어";
    else if (dealerTotal > playerTotal) winner = "딜러";
    else winner = "무승부";

    blackjackResultText = `🎲 **블랙잭 결과** 🎲  
당신의 카드: ${playerCards.join(", ")} (${playerTotal})  
딜러의 카드: ${dealerCards.join(", ")} (${dealerTotal})  
--------------------------  
`;

    let payout = 0;
    if (winner === "플레이어") {
      payout = Math.floor(bet * 2);
      await changeBalance(uid, payout, "blackjack_win");
      blackjackResultText += `✅ 당신이 승리했습니다! (+${payout} 포인트)`;
    } else if (winner === "무승부") {
      payout = bet;
      await changeBalance(uid, payout, "blackjack_draw");
      blackjackResultText += `🤝 무승부입니다. 배팅액이 반환됩니다.`;
    } else {
      blackjackResultText += `❌ 딜러가 승리했습니다. (-${bet} 포인트)`;
    }

    const newBal = (await getUser(uid)).balance;
    blackjackResultText += `\n\n현재 잔고: ${newBal} 포인트`;

    await interaction.editReply(blackjackResultText);
  } catch (err) {
    console.error("블랙잭 오류:", err);
    await interaction.editReply("⚠️ 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
  return interaction.editReply(blackjackResultText);
}

});


client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  const uid = interaction.user.id;

  try {
    // ------------------- 돈줘 -------------------
    if (cmd === "돈줘") {
      const user = await getUser(uid);
      const now = Date.now();
      if (now - (user.last_claim || 0) < 24 * 60 * 60 * 1000) {
        await interaction.reply({ content: "이미 24시간 내 지급됨", ephemeral: true });
        return;
      }

      await db.run("UPDATE users SET balance = balance + ?, last_claim = ? WHERE id = ?", DEFAULT_STARTING, now, uid);
      await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", uid, DEFAULT_STARTING, "daily_claim", now);
      await interaction.reply({ content: `기본금 ${DEFAULT_STARTING} 지급 완료`, ephemeral: true });
      return;
    }


       // ------------------- 잔고 -------------------
    if (cmd === "잔고") {
      const user = await getUser(uid);
      await interaction.reply({ content: `잔고: ${user.balance}포인트`, ephemeral: true });
      return;
    }

 // ------------------- 슬롯 -------------------
    if (cmd === "슬롯") {
      const bet = Number(interaction.options.getInteger("배팅") ?? SLOT_DEFAULT_BET);
      if (bet <= 0) {
        await interaction.reply({ content: "배팅은 양수여야 합니다", ephemeral: true });
        return;
      }
      const user = await getUser(uid);
      if (user.balance < bet) {
        await interaction.reply({ content: "잔고 부족", ephemeral: true });
        return;
      }

      await changeBalance(uid, -bet, "slot_bet");
      const spin = spinSlot();
      const newBal = (await getUser(uid)).balance;

      if (spin.multiplier > 0) {
        const payout = bet * spin.multiplier;
        await changeBalance(uid, payout, "slot_win");
        await interaction.reply({ content: `슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n승리! 배수: ${spin.multiplier}, 상금 ${payout}포인트 지급\n잔고: ${newBal}` });
      } else {
        await interaction.reply({ content: `슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n꽝! 배팅액 ${bet}포인트 차감\n잔고: ${newBal}` });
      }
      return;
    }


     // ------------------- 복권구매 -------------------
    if (cmd === "복권구매") {
      const qty = Number(interaction.options.getInteger("수량") ?? 1);
      if (qty <= 0) {
        await interaction.reply({ content: "1장 이상 구매하세요", ephemeral: true });
        return;
      }

      const price = qty * 100;
      const user = await getUser(uid);
      if (user.balance < price) {
        await interaction.reply({ content: "잔고 부족", ephemeral: true });
        return;
      }

      for (let i = 0; i < qty; i++) {
        const ticket = Math.random().toString(36).slice(2, 10).toUpperCase();
        await db.run("INSERT INTO lottery_tickets(user_id, ticket_number, ts) VALUES(?,?,?)", uid, ticket, Date.now());
      }
      await changeBalance(uid, -price, "lottery_buy");
      await interaction.reply({ content: `${qty}장 구매 완료 (총 ${price}포인트 차감)` });
      return;
    }


     if (cmd === "복권상태") {
      const cntRow = await db.get("SELECT COUNT(*) as c FROM lottery_tickets");
      const cnt = cntRow ? Number(cntRow.c || 0) : 0;
      await interaction.reply({ content: `현재 복권 판매량: ${cnt}장`, ephemeral: true });
      return;
    }


   if (cmd === "관리자지급") {
      if (!isAdmin(uid)) {
        await interaction.reply({ content: "관리자 전용", ephemeral: true });
        return;
      }
      const target = interaction.options.getUser("대상");
      const amount = Number(interaction.options.getInteger("금액") || 0);
      if (!target) {
        await interaction.reply({ content: "대상 지정 필요", ephemeral: true });
        return;
      }

      await changeBalance(target.id, amount, "admin_adjust");
      await interaction.reply({ content: `<@${target.id}>에게 ${amount}포인트 적용 완료` });
      return;
    }

    // ------------------- 경마 -------------------
    if (cmd === "경마") {
      await interaction.deferReply();
      const channelId = interaction.channelId;
      const bet = Number(interaction.options.getInteger("배팅") ?? 100);
      const horseNum = Number(interaction.options.getInteger("번호"));

      if (!Number.isInteger(horseNum) || horseNum < 1 || horseNum > horses.length) {
        await interaction.editReply("1~7번 말 중 선택하세요");
        return;
      }

      const user = await getUser(uid);
      if (user.balance < bet) {
        await interaction.editReply("잔고 부족");
        return;
      }

      if (!activeRaces.has(channelId)) {
        activeRaces.set(channelId, { bettors: new Map(), started: false });
        setTimeout(async () => {
          const race = activeRaces.get(channelId);
          if (!race || race.started) return;
          race.started = true;
          await startRace(interaction.channel, race.bettors);
          activeRaces.delete(channelId);
        }, 10000);
      }

      const race = activeRaces.get(channelId);
      if (race.bettors.has(uid)) {
        await interaction.editReply("이미 베팅했습니다");
        return;
      }

      await changeBalance(uid, -bet, "race_lock");
      race.bettors.set(uid, { horseIndex: horseNum - 1, bet });
      await interaction.editReply(`경마 베팅 완료! 배팅 ${bet}포인트, 선택 말: ${horses[horseNum - 1].name}`);
      return;
    }


      const race = activeRaces.get(channelId);
      if (race.bettors.has(uid)) return interaction.editReply("이미 베팅했습니다");

      // 차감 후 저장
      await changeBalance(uid, -bet, "race_lock");
      race.bettors.set(uid, { horseIndex: horseNum - 1, bet });
      return interaction.editReply(`경마 베팅 완료! 배팅 ${bet}포인트, 선택 말: ${horses[horseNum - 1].name}`);
    }

  } catch (err) {
    console.error("interaction 처리 중 오류:", err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply("명령 처리 중 오류가 발생했습니다.");
      else await interaction.reply({ content: "명령 처리 중 오류가 발생했습니다.", ephemeral: true });
    } catch (e) { /* 무시 */ }
  }
});

// -------------------
// 슬래시 명령 등록
// -------------------
const commandList = [
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 지급"),
  new SlashCommandBuilder().setName("잔고").setDescription("잔고 조회"),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신").addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("복권구매").setDescription("복권 구매").addIntegerOption(o => o.setName("수량").setDescription("장 수")),
  new SlashCommandBuilder().setName("복권상태").setDescription("복권 판매량 확인"),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 포인트 조정")
    .addUserOption(o => o.setName("대상").setDescription("대상 유저").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("양수=지급, 음수=회수").setRequired(true)),
  new SlashCommandBuilder().setName("경마").setDescription("경마 게임")
    .addIntegerOption(o => o.setName("번호").setDescription("1~7번 선택").setRequired(true))
    .addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("블랙잭").setDescription("블랙잭 게임").addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("바카라").setDescription("바카라 게임")
    .addStringOption(o => o.setName("배팅방향").setDescription("플레이어/뱅커/무승부"))
    .addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액")),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  if (!CLIENT_ID || !TOKEN) {
    console.log("CLIENT_ID 또는 TOKEN 이 설정되어 있지 않아 슬래시 명령 등록을 건너뜁니다.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    if (GUILD_ID)
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandList });
    else
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandList });
    console.log("슬래시 명령 등록 완료");
  } catch (e) {
    console.error("명령 등록 실패", e);
  }
}

// -------------------
// ready 이벤트
// -------------------
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  await registerCommands();

  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild && guild.systemChannelId) scheduleLottery(guild.systemChannelId);
    else scheduleLottery(null);
  } else scheduleLottery(null);

  console.log("봇 준비 완료");
});

// -------------------
// 로그인
// -------------------
client.login(TOKEN);






