// index.js
import sqlite3 from "sqlite3";
import { promisify } from "util";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, Collection, SlashCommandBuilder, REST, Routes } from "discord.js";
import process from "process";

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
const db = new sqlite3.Database("./dovakbot.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error("DB 연결 실패:", err);
  else console.log("DB 연결 성공");
});

// promisify
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

async function initDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0,
      last_claim INTEGER DEFAULT 0
    );
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      delta INTEGER,
      reason TEXT,
      ts INTEGER
    );
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      ticket_number TEXT,
      ts INTEGER
    );
  `);
}

// -------------------
// 유틸 함수
// -------------------
function isAdmin(userId) {
  if (ADMIN_USER_IDS.length === 0) return false;
  return ADMIN_USER_IDS.includes(userId);
}

async function getUser(userId) {
  let row = await dbGet("SELECT * FROM users WHERE id = ?", userId);
  if (!row) {
    await dbRun("INSERT INTO users(id,balance,last_claim) VALUES(?,?,?)", userId, 0, 0);
    row = await dbGet("SELECT * FROM users WHERE id=?", userId);
  }
  return row;
}

async function changeBalance(userId, delta, reason = "adjust") {
  await getUser(userId);
  await dbRun("UPDATE users SET balance = balance + ? WHERE id = ?", delta, userId);
  await dbRun("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", userId, delta, reason, Date.now());
  return await getUser(userId);
}

// -------------------
// Discord client
// -------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// -------------------
// 슬롯 로직
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
  } else if (r1 === r2 || r2 === r3 || r1 === r3) {
    payout = 2;
  }
  return { r1, r2, r3, payout };
}

// -------------------
// 슬래시 명령어 등록
// -------------------
const commands = [
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 1000포인트 지급"),
  new SlashCommandBuilder().setName("잔고").setDescription("내 포인트 조회"),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신").addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 포인트 조정")
    .addUserOption(o => o.setName("대상").setDescription("대상 유저").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("양수: 지급, 음수: 회수").setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  if (!CLIENT_ID || !TOKEN) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("슬래시 명령어 등록 완료");
  } catch (e) { console.error("명령어 등록 실패", e); }
}

// -------------------
// 이벤트
// -------------------
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  await registerCommands();
});

// interaction 처리
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const uid = interaction.user.id;
  const cmd = interaction.commandName;

  if (cmd === "돈줘") {
    await interaction.deferReply({ ephemeral: true });
    const user = await getUser(uid);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    if (now - user.last_claim < dayMs) return interaction.editReply("이미 24시간 내에 받았습니다.");
    await dbRun("UPDATE users SET balance = balance + ?, last_claim = ? WHERE id = ?", DEFAULT_STARTING, now, uid);
    await dbRun("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", uid, DEFAULT_STARTING, "daily_claim", now);
    return interaction.editReply(`기본금 ${DEFAULT_STARTING}포인트 지급 완료!`);
  }

  if (cmd === "잔고") {
    const user = await getUser(uid);
    return interaction.reply({ content: `잔고: ${user.balance}포인트`, ephemeral: true });
  }

  if (cmd === "슬롯") {
    await interaction.deferReply();
    let bet = interaction.options.getInteger("배팅") ?? SLOT_DEFAULT_BET;
    if (bet <= 0) return interaction.editReply("배팅은 양수여야 합니다.");
    const user = await getUser(uid);
    if (user.balance < bet) return interaction.editReply("잔고 부족");
    const spin = spinSlot();
    const multiplier = spin.payout;
    const win = bet * multiplier;
    const delta = multiplier > 0 ? win : -bet;
    await changeBalance(uid, delta, "slot");
    let txt = `슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n`;
    txt += multiplier > 0 ? `승리! 배수: ${multiplier} => ${win}포인트 획득\n` : `꽝! ${bet}포인트 차감\n`;
    txt += `잔고: ${(await getUser(uid)).balance}포인트`;
    return interaction.editReply(txt);
  }

  if (cmd === "관리자지급") {
    await interaction.deferReply();
    if (!isAdmin(uid)) return interaction.editReply("관리자 전용 명령입니다.");
    const target = interaction.options.getUser("대상");
    const amount = interaction.options.getInteger("금액");
    await changeBalance(target.id, amount, "admin_adjust");
    return interaction.editReply(`<@${target.id}> 에게 ${amount}포인트 적용 완료`);
  }
});

// -------------------
// 로그인
// -------------------
client.login(TOKEN);
