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
  let row = await db.get("SELECT * FROM users WHERE id=?", userId);
  if (!row) {
    await db.run("INSERT INTO users(id,balance,last_claim) VALUES(?,?,?)", userId, 0, 0);
    row = await db.get("SELECT * FROM users WHERE id=?", userId);
  }
  return row;
}

async function changeBalance(userId, delta, reason = "adjust") {
  const user = await getUser(userId);
  const newBalance = Math.max(0, user.balance + delta); // 잔고 0 이하 방지
  await db.run("UPDATE users SET balance=? WHERE id=?", newBalance, userId);
  await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", userId, delta, reason, Date.now());
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
// 슬롯머신
// -------------------
function spinSlot() {
  const reels = ["🍒", "🍋", "🍊", "🔔", "⭐", "7️⃣"];
  const r1 = reels[Math.floor(Math.random() * reels.length)];
  const r2 = reels[Math.floor(Math.random() * reels.length)];
  const r3 = reels[Math.floor(Math.random() * reels.length)];
  let payout = 0;
  if (r1 === r2 && r2 === r3) {
    if (r1 === "7️⃣") payout = 10;
    else if (r1 === "⭐") payout = 6;
    else payout = 4;
  } else if (r1 === r2 || r2 === r3 || r1 === r3) payout = 2;
  return { r1, r2, r3, payout };
}

// -------------------
// 복권
// -------------------
async function runLotteryDraw(channel) {
  const tickets = await db.all("SELECT * FROM lottery_tickets");
  if (tickets.length === 0) {
    if (channel) channel.send("오늘 복권 참여자가 없습니다.");
    return;
  }
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
  const msg = await channel.send("🏁 경주 시작! 잠시만 기다려주세요...");
  const trackLength = 30;

  return new Promise((resolve) => {
    let finished = false;

    const interval = setInterval(async () => {
      for (let i = 0; i < horses.length; i++) {
        positions[i] += Math.random() < 0.5 ? 1 : 0; // 전진 확률 조정
        if (positions[i] > trackLength) positions[i] = trackLength;
      }

      const raceMsg = positions
        .map((p, i) => `${horses[i].emoji} ${horses[i].name.padEnd(5, " ")} | ${"·".repeat(p)}🏁`)
        .join("\n");

      await msg.edit(`🏇 경주 중...\n\n${raceMsg}`);

      const winnerIdx = positions.findIndex((p) => p >= trackLength);
      if (winnerIdx !== -1) {
        finished = true;
        clearInterval(interval);

        // 승자 처리
        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) {
            await changeBalance(uid, b.bet * 4, "race_win");
          }
        }

        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} (번호 ${winnerIdx + 1})`);
        resolve(winnerIdx);
      }
    }, 1000);

    setTimeout(() => {
      if (!finished) {
        clearInterval(interval);
        msg.reply("⏱ 경주가 시간 초과로 종료되었습니다.");
        resolve(null);
      }
    }, 40000);
  });
}

// -------------------
// interactionCreate
// -------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const uid = interaction.user.id;
  const cmd = interaction.commandName;

  if (cmd === "돈줘") {
    const user = await getUser(uid);
    const now = Date.now();
    if (now - (user.last_claim || 0) < 24 * 60 * 60 * 1000)
      return interaction.reply({ content: "이미 24시간 내 지급됨", ephemeral: true });

    await db.run("UPDATE users SET balance=balance+?, last_claim=? WHERE id=?", DEFAULT_STARTING, now, uid);
    await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", uid, DEFAULT_STARTING, "daily_claim", now);
    return interaction.reply({ content: `기본금 ${DEFAULT_STARTING} 지급 완료`, ephemeral: true });
  }

  if (cmd === "잔고") {
    const user = await getUser(uid);
    return interaction.reply({ content: `잔고: ${user.balance}포인트`, ephemeral: true });
  }

  if (cmd === "슬롯") {
    const bet = interaction.options.getInteger("배팅") ?? SLOT_DEFAULT_BET;
    if (bet <= 0) return interaction.reply({ content: "배팅은 양수여야 함", ephemeral: true });
    const user = await getUser(uid);
    if (user.balance < bet) return interaction.reply({ content: "잔고 부족", ephemeral: true });

    const spin = spinSlot();
    const delta = spin.payout > 0 ? bet * (spin.payout - 1) : -bet;
    await changeBalance(uid, delta, "slot");
    const newBal = (await getUser(uid)).balance;
    return interaction.reply({
      content: `슬롯 결과: ${spin.r1}${spin.r2}${spin.r3}\n결과: ${delta >= 0 ? `승리 +${delta}` : `패배 ${-delta}`}\n잔고: ${newBal}`,
    });
  }

  if (cmd === "복권구매") {
    const qty = interaction.options.getInteger("수량") ?? 1;
    if (qty <= 0) return interaction.reply({ content: "1장 이상 구매하세요", ephemeral: true });
    const price = qty * 100;
    const user = await getUser(uid);
    if (user.balance < price) return interaction.reply({ content: "잔고 부족", ephemeral: true });

    for (let i = 0; i < qty; i++) {
      const ticket = Math.random().toString(36).slice(2, 10).toUpperCase();
      await db.run("INSERT INTO lottery_tickets(user_id, ticket_number, ts) VALUES(?,?,?)", uid, ticket, Date.now());
    }
    await changeBalance(uid, -price, "lottery_buy");
    return interaction.reply({ content: `${qty}장 구매 완료 (총 ${price}포인트 차감)` });
  }

  if (cmd === "복권상태") {
    const cnt = (await db.get("SELECT COUNT(*) as c FROM lottery_tickets")).c;
    return interaction.reply({ content: `현재 복권 판매량: ${cnt}장`, ephemeral: true });
  }

  if (cmd === "관리자지급") {
    if (!isAdmin(uid)) return interaction.reply({ content: "관리자 전용", ephemeral: true });
    const target = interaction.options.getUser("대상");
    const amount = interaction.options.getInteger("금액");
    if (!target) return interaction.reply({ content: "대상 지정 필요", ephemeral: true });
    await changeBalance(target.id, amount, "admin_adjust");
    return interaction.reply({ content: `<@${target.id}>에게 ${amount}포인트 적용 완료` });
  }

  // ------------------- 경마 -------------------
  if (cmd === "경마") {
    await interaction.deferReply();
    const channelId = interaction.channelId;
    const bet = interaction.options.getInteger("배팅") ?? 100;
    const horseNum = interaction.options.getInteger("번호");

    if (horseNum < 1 || horseNum > horses.length)
      return interaction.editReply("1~7번 말 중 선택하세요");

    const user = await getUser(uid);
    if (user.balance < bet) return interaction.editReply("잔고 부족");

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
    if (race.bettors.has(uid)) return interaction.editReply("이미 베팅했습니다");

    race.bettors.set(uid, { horseIndex: horseNum - 1, bet });
    await changeBalance(uid, -bet, "race_lock");
    return interaction.editReply(
      `경마 베팅 완료! 배팅 ${bet}포인트, 선택 말: ${horses[horseNum - 1].name}`
    );
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
].map(cmd => cmd.toJSON());

async function registerCommands() {
  if (!CLIENT_ID || !TOKEN) return;
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
