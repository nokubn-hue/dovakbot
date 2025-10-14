// index.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } from "discord.js";
import process from "process";

// --------------------
// 환경 변수
// --------------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

// --------------------
// 기본값
// --------------------
const DEFAULT_STARTING = 1000;
const SLOT_DEFAULT_BET = 100;
const TABLE_MIN_BET = 100;

// --------------------
// DB 초기화
// --------------------
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
}

// --------------------
// 유틸 함수
// --------------------
function isAdmin(userId) {
  if (ADMIN_USER_IDS.length === 0) return false;
  return ADMIN_USER_IDS.includes(userId);
}

async function getUser(userId) {
  let row = await db.get("SELECT * FROM users WHERE id = ?", userId);
  if (!row) {
    await db.run("INSERT INTO users(id,balance,last_claim) VALUES(?,?,?)", userId, 0, 0);
    row = await db.get("SELECT * FROM users WHERE id=?", userId);
  }
  return row;
}

async function changeBalance(userId, delta, reason = "adjust") {
  await getUser(userId);
  await db.run("UPDATE users SET balance = balance + ? WHERE id = ?", delta, userId);
  await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", userId, delta, reason, Date.now());
  return await getUser(userId);
}

// --------------------
// Discord 클라이언트
// --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// --------------------
// 명령어 등록
// --------------------
const commands = [
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 1000포인트를 24시간마다 받을 수 있습니다."),
  new SlashCommandBuilder().setName("잔고").setDescription("내 포인트를 보여줍니다."),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신을 돌립니다.").addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("블랙잭").setDescription("블랙잭 게임에 참여하거나 시작합니다.").addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("바카라").setDescription("바카라 게임 시작/참여").addIntegerOption(o => o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("경마").setDescription("경마를 시작합니다. (베팅 후 시작)"),
  new SlashCommandBuilder().setName("복권구매").setDescription("복권을 구매합니다. (1장당 100)").addIntegerOption(o => o.setName("수량").setDescription("구매할 장 수").setRequired(false)),
  new SlashCommandBuilder().setName("복권상태").setDescription("이번 복권의 구매자 수를 보여줍니다."),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 전용: 포인트를 지급/회수합니다.")
    .addUserOption(o => o.setName("대상").setDescription("대상 유저").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("양수는 지급, 음수는 회수").setRequired(true))
].map(cmd => cmd.toJSON());

async function registerCommands() {
  if (!CLIENT_ID || !TOKEN) return;
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("Registered guild commands");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("Registered global commands");
    }
  } catch (e) { console.error("Failed reg commands", e); }
}

// --------------------
// 슬롯머신
// --------------------
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

// --------------------
// Blackjack/Baccarat 기본 틀
// --------------------
const activeBlackjacks = new Map();
const activeBaccarat = new Map();

function createDeck() {
  const faces = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];
  for (let i = 0; i < 4; i++) for (const f of faces) deck.push(f);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
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

// --------------------
// 경마
// --------------------
const horses = ["🐎", "🐎", "🐎", "🐎", "🐎", "🐎", "🐎"];
function generateRaceMessage(positions) {
  return positions.map((p, i) => `${horses[i]} |${"·".repeat(p)}🏁`).join("\n");
}

// --------------------
// 복권
// --------------------
async function runLotteryDraw(channel) {
  const tickets = await db.all("SELECT * FROM lottery_tickets");
  if (tickets.length === 0) { if (channel) channel.send("오늘 복권 참여자가 없습니다."); return; }
  const winnerTicket = tickets[Math.floor(Math.random() * tickets.length)];
  const winnerId = winnerTicket.user_id;
  const prize = tickets.length * 100;
  await changeBalance(winnerId, prize, "lottery_prize");
  await db.exec("DELETE FROM lottery_tickets");
  if (channel) channel.send({ content: `<@${winnerId}> 님이 복권 당첨! 상금: ${prize}포인트 🎉` });
}
function scheduleLottery(channelIdForAnnounce) {
  cron.schedule("0 0 9 * * *", async () => {
    const channel = channelIdForAnnounce ? await client.channels.fetch(channelIdForAnnounce).catch(() => null) : null;
    await runLotteryDraw(channel);
  }, { timezone: "Asia/Seoul" });
}

// --------------------
// 이벤트 핸들링
// --------------------
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  await registerCommands();
  if (GUILD_ID) {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild && guild.systemChannelId) {
      scheduleLottery(guild.systemChannelId);
      console.log("Lottery scheduled in system channel");
    } else { scheduleLottery(null); console.log("Lottery scheduled"); }
  } else { scheduleLottery(null); console.log("Lottery scheduled"); }
});

// --------------------
// interactionCreate 처리
// --------------------
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
    await db.run("UPDATE users SET balance = balance + ?, last_claim = ? WHERE id = ?", DEFAULT_STARTING, now, uid);
    await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", uid, DEFAULT_STARTING, "daily_claim", now);
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
    if (user.balance < bet) return interaction.editReply("잔고가 부족합니다.");
    const spin = spinSlot();
    const multiplier = spin.payout;
    const win = bet * multiplier;
    const delta = multiplier > 0 ? win : -bet;
    await changeBalance(uid, delta, "slot");
    let txt = `슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n`;
    txt += multiplier > 0 ? `승리! 배수: ${multiplier} => ${win}포인트 획득\n` : `꽝! 배팅액 ${bet}포인트 차감\n`;
    txt += `잔고: ${(await getUser(uid)).balance}포인트`;
    return interaction.editReply(txt);
  }

  // 관리자지급
  if (cmd === "관리자지급") {
    await interaction.deferReply();
    if (!isAdmin(uid)) return interaction.editReply("관리자 전용입니다.");
    const target = interaction.options.getUser("대상");
    const amount = interaction.options.getInteger("금액");
    await changeBalance(target.id, amount, "admin_adjust");
    return interaction.editReply(`<@${target.id}> 에게 ${amount}포인트 적용 완료.`);
  }
});

client.login(TOKEN);
