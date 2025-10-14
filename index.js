// index.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import express from "express";
import process from "process";
import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes
} from "discord.js";

// -------------------
// Express 서버
// -------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("봇이 실행 중입니다."));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

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
const HORSE_COUNT = 7;

// -------------------
// DB 초기화
// -------------------
let db;
async function initDB() {
  db = await open({ filename: './dovakbot.db', driver: sqlite3.Database });
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

async function changeBalance(userId, delta, reason="adjust") {
  const user = await getUser(userId);
  const newBalance = user.balance + delta;
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
// 슬롯
// -------------------
function spinSlot() {
  const reels = ["🍒","🍋","🍊","🔔","⭐","7️⃣"];
  const r1 = reels[Math.floor(Math.random()*reels.length)];
  const r2 = reels[Math.floor(Math.random()*reels.length)];
  const r3 = reels[Math.floor(Math.random()*reels.length)];
  let payout = 0;
  if(r1===r2 && r2===r3){
    if(r1==="7️⃣") payout=10;
    else if(r1==="⭐") payout=6;
    else payout=4;
  } else if(r1===r2 || r2===r3 || r1===r3) payout=2;
  return { r1,r2,r3,payout };
}

// -------------------
// 블랙잭 헬퍼
// -------------------
function createDeck() {
  const faces = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for(let i=0;i<4;i++) for(const f of faces) deck.push(f);
  for(let i=deck.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
  return deck;
}

function calcBlackjack(hand){
  let total=0, aces=0;
  for(const c of hand){
    if(c==="A"){ aces++; total+=11; }
    else if(["J","Q","K"].includes(c)) total+=10;
    else total+=Number(c);
  }
  while(total>21 && aces>0){ total-=10; aces--; }
  return total;
}

// -------------------
// 복권
// -------------------
async function runLotteryDraw(channel){
  const tickets = await db.all("SELECT * FROM lottery_tickets");
  if(tickets.length===0){ if(channel) channel.send("오늘 복권 참여자가 없습니다."); return; }
  const winnerTicket = tickets[Math.floor(Math.random()*tickets.length)];
  const winnerId = winnerTicket.user_id;
  const prize = tickets.length*100;
  await changeBalance(winnerId, prize, "lottery_prize");
  await db.run("DELETE FROM lottery_tickets");
  if(channel) channel.send({ content: `<@${winnerId}> 님이 복권에 당첨되었습니다! 상금: ${prize}포인트 🎉`});
}

function scheduleLottery(channelId){
  cron.schedule("0 0 21 * * *", async ()=>{
    const channel = channelId ? await client.channels.fetch(channelId).catch(()=>null) : null;
    await runLotteryDraw(channel);
  }, { timezone:"Asia/Seoul" });
}

// -------------------
// 블랙잭/바카라/경마 상태 저장
// -------------------
const activeBlackjacks = new Map();
const activeBaccarat = new Map();
const activeRaces = new Map();
const horses = ["🐎","🐎","🐎","🐎","🐎","🐎","🐎"];

// -------------------
// 경마 게임
// -------------------
async function startRace(channel, bettors) {
  let positions = new Array(horses.length).fill(0);
  const msg = await channel.send("🏁 경주 시작! 잠시만 기다려주세요...");

  return new Promise((resolve) => {
    let finished = false;
    const interval = setInterval(async () => {
      for (let i = 0; i < horses.length; i++) {
        positions[i] += Math.random() < 0.6 ? 0 : Math.floor(Math.random() * 3);
        if (positions[i] >= 30) positions[i] = 30;
      }

      const raceMsg = positions.map((p, i) => `${horses[i]} |${"·".repeat(p)}🏁`).join("\n");
      await msg.edit(raceMsg);

      const winners = positions.map((p, i) => (p >= 30 ? i : null)).filter((x) => x !== null);
      if (winners.length > 0) {
        finished = true;
        clearInterval(interval);
        const winnerIdx = winners[0];

        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) {
            await changeBalance(uid, b.bet * 5, "race_win");
          }
        }

        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx]} (번호 ${winnerIdx + 1})`);
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
// 슬래시 명령 등록
// -------------------
const commandList = [
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 지급"),
  new SlashCommandBuilder().setName("잔고").setDescription("잔고 조회"),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("복권구매").setDescription("복권 구매").addIntegerOption(o=>o.setName("수량").setDescription("구매 장 수")),
  new SlashCommandBuilder().setName("복권상태").setDescription("복권 판매 현황"),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 포인트 조정")
    .addUserOption(o=>o.setName("대상").setDescription("대상 유저").setRequired(true))
    .addIntegerOption(o=>o.setName("금액").setDescription("양수=지급, 음수=회수").setRequired(true)),
  new SlashCommandBuilder().setName("블랙잭").setDescription("블랙잭 게임").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("바카라").setDescription("바카라 게임")
    .addStringOption(o=>o.setName("배팅방향").setDescription("플레이어/뱅커/무승부"))
    .addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("경마").setDescription("경마 게임")
    .addIntegerOption(o=>o.setName("번호").setDescription("1~7번 선택").setRequired(true))
    .addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액"))
].map(cmd=>cmd.toJSON());

async function registerCommands(){
  if(!CLIENT_ID || !TOKEN) return;
  const rest = new REST({ version:'10' }).setToken(TOKEN);
  try{
    if(GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body:commandList });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body:commandList });
    console.log("슬래시 명령 등록 완료");
  }catch(e){ console.error("명령 등록 실패", e); }
}

// -------------------
// ready 이벤트
// -------------------
client.on("ready", async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  await registerCommands();

  if(GUILD_ID){
    const guild = await client.guilds.fetch(GUILD_ID).catch(()=>null);
    if(guild && guild.systemChannelId) scheduleLottery(guild.systemChannelId);
    else scheduleLottery(null);
  } else scheduleLottery(null);

  console.log("봇 준비 완료");
});

// -------------------
// 로그인
// -------------------
client.login(TOKEN);
