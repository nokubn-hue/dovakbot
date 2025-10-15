// index.js (완전판)
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const cron = require("node-cron");
const express = require("express");
const process = require("process");
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require("discord.js");

////////////////////////////////////////////////////////////////////////////////
// 웹서버
////////////////////////////////////////////////////////////////////////////////
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("봇 실행 중"));
app.listen(PORT, () => console.log(`웹서버 포트 ${PORT}에서 실행 중`));

////////////////////////////////////////////////////////////////////////////////
// 환경 변수
////////////////////////////////////////////////////////////////////////////////
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "").split(",").filter(Boolean);

////////////////////////////////////////////////////////////////////////////////
// 기본 설정
////////////////////////////////////////////////////////////////////////////////
const DEFAULT_STARTING = 1000;
const SLOT_DEFAULT_BET = 100;
const RACE_PAYOUT_MULTIPLIER = 5;

////////////////////////////////////////////////////////////////////////////////
// DB 초기화
////////////////////////////////////////////////////////////////////////////////
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

////////////////////////////////////////////////////////////////////////////////
// 유틸리티
////////////////////////////////////////////////////////////////////////////////
function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

async function getUser(userId) {
  const row = await db.get("SELECT * FROM users WHERE id = ?", userId);
  if (!row) {
    await db.run("INSERT INTO users(id, balance, last_claim) VALUES(?,?,?)", userId, 0, 0);
    const newRow = await db.get("SELECT * FROM users WHERE id = ?", userId);
    return { id: newRow.id, balance: Number(newRow.balance || 0), last_claim: newRow.last_claim || 0 };
  }
  return { id: row.id, balance: Number(row.balance || 0), last_claim: row.last_claim || 0 };
}

async function changeBalance(userId, delta, reason = "adjust") {
  const d = Number(delta) || 0;
  await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", userId, d, reason, Date.now());
  await db.run("UPDATE users SET balance = balance + ? WHERE id = ?", d, userId);
  return getUser(userId);
}

////////////////////////////////////////////////////////////////////////////////
// Discord Client
////////////////////////////////////////////////////////////////////////////////
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

////////////////////////////////////////////////////////////////////////////////
// 슬롯머신
////////////////////////////////////////////////////////////////////////////////
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

////////////////////////////////////////////////////////////////////////////////
// 블랙잭
////////////////////////////////////////////////////////////////////////////////
function createDeck() {
  const faces = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (let i=0;i<4;i++) for (const f of faces) deck.push(f);
  for (let i=deck.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcBlackjackHandValue(hand) {
  let total=0, aces=0;
  for(const c of hand) {
    if(c==="A"){total+=11; aces++;}
    else if(["J","Q","K"].includes(c)) total+=10;
    else total+=Number(c);
  }
  while(total>21 && aces>0){total-=10; aces--;}
  return total;
}

////////////////////////////////////////////////////////////////////////////////
// 복권
////////////////////////////////////////////////////////////////////////////////
async function runLotteryDraw(channel) {
  const tickets = await db.all("SELECT * FROM lottery_tickets");
  if(!tickets || tickets.length===0){ if(channel) await channel.send("오늘 복권 참여자가 없습니다."); return; }
  const winnerTicket = tickets[Math.floor(Math.random()*tickets.length)];
  const winnerId = winnerTicket.user_id;
  const prize = tickets.length*100;
  await changeBalance(winnerId, prize, "lottery_prize");
  await db.run("DELETE FROM lottery_tickets");
  if(channel) await channel.send(`<@${winnerId}> 님이 복권 당첨! 상금: ${prize}포인트 🎉`);
}

function scheduleLottery(channelId){
  cron.schedule("0 0 21 * * *", async ()=>{
    const channel = channelId ? await client.channels.fetch(channelId).catch(()=>null) : null;
    await runLotteryDraw(channel);
  }, {timezone:"Asia/Seoul"});
}

////////////////////////////////////////////////////////////////////////////////
// 경마 시스템 
////////////////////////////////////////////////////////////////////////////////
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
        positions[i] += Math.floor(Math.random() * 3); // 0..2
        if (positions[i] > trackLength) positions[i] = trackLength;
      }

      const raceMsg = positions
        .map((p, i) => `${horses[i].emoji} ${horses[i].name.padEnd(8, " ")} |${"·".repeat(p)}${" ".repeat(Math.max(0, trackLength - p))}🏁`)
        .join("\n");

      try { await msg.edit(`🏇 경주 중...\n\n${raceMsg}`); } catch (e) { /* 편집 실패 무시 (권한/메시지 삭제 등) */ }

      const winnerIdx = positions.findIndex(p => p >= trackLength);
      if (winnerIdx !== -1) {
        finished = true;
        clearInterval(interval);

        // 정산: 베팅은 이미 차감되어 있으므로 '총액'을 지급 (예: multiplier=5 => 지급 = 5*bet, net = -bet + 5*bet = +4*bet)
        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) {
            const payout = Number(b.bet) * Number(RACE_PAYOUT_MULTIPLIER);
            await changeBalance(uid, payout, "race_win");
          }
        }

        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} ${horses[winnerIdx].emoji} (번호 ${winnerIdx + 1})`);
        resolve(winnerIdx);
      }
    }, 1000);

    // 타임아웃 방지
    setTimeout(() => {
      if (!finished) {
        clearInterval(interval);
        try { msg.reply("⏱ 경주가 시간초과로 종료되었습니다."); } catch (e) {}
        resolve(null);
      }
    }, 40000);
  });
}


////////////////////////////////////////////////////////////////////////////////
// 슬래시 명령 등록
////////////////////////////////////////////////////////////////////////////////
const commandList=[
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 지급"),
  new SlashCommandBuilder().setName("잔고").setDescription("잔고 조회"),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("복권구매").setDescription("복권 구매").addIntegerOption(o=>o.setName("수량").setDescription("장 수")),
  new SlashCommandBuilder().setName("복권상태").setDescription("복권 상태"),
  new SlashCommandBuilder().setName("골라").setDescription("옵션 중에서 무작위 선택").addStringOption(o=>o.setName("option").setDescription("예: 사과,바나나,귤").setRequired(true)).addIntegerOption(o=>o.setName("count").setDescription("한 번에 뽑을 개수")),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 포인트 조정").addUserOption(o=>o.setName("대상").setDescription("대상 유저").setRequired(true)).addIntegerOption(o=>o.setName("금액").setDescription("양수=지급, 음수=회수").setRequired(true)),
  new SlashCommandBuilder().setName("경마").setDescription("경마 게임").addIntegerOption(o=>o.setName("번호").setDescription("1~7번 선택").setRequired(true)).addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("블랙잭").setDescription("블랙잭 게임").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액")),
  new SlashCommandBuilder().setName("바카라").setDescription("바카라 게임").addStringOption(o=>o.setName("배팅방향").setDescription("플레이어/뱅커/무승부")).addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액"))
].map(cmd=>cmd.toJSON());

async function registerCommands(){
  if(!CLIENT_ID||!TOKEN) return;
  const rest=new REST({version:"10"}).setToken(TOKEN);
  try{
    if(GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID),{body:commandList});
    else await rest.put(Routes.applicationCommands(CLIENT_ID),{body:commandList});
    console.log("슬래시 명령 등록 완료");
  }catch(e){console.error("명령 등록 실패",e);}
}

////////////////////////////////////////////////////////////////////////////////
// interactionCreate
////////////////////////////////////////////////////////////////////////////////
client.on("interactionCreate", async interaction=>{
  if(!interaction.isChatInputCommand()) return;
  const cmd=interaction.commandName;
  const uid=interaction.user.id;
  try{
    // 돈줘
    if(cmd==="돈줘"){
      const user=await getUser(uid);
      const now=Date.now();
      const dayMs=24*60*60*1000;
      if(now-(user.last_claim||0)<dayMs){ await interaction.reply({content:"이미 24시간 내 지급됨",ephemeral:true}); return; }
      await db.run("UPDATE users SET balance = balance + ?, last_claim = ? WHERE id = ?",DEFAULT_STARTING,now,uid);
      await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)",uid,DEFAULT_STARTING,"daily_claim",now);
      await interaction.reply({content:`기본금 ${DEFAULT_STARTING} 지급 완료`,ephemeral:true});
      return;
    }

    // 잔고
    if(cmd==="잔고"){
      const user=await getUser(uid);
      await interaction.reply({content:`잔고: ${user.balance}포인트`,ephemeral:true});
      return;
    }

    // 슬롯
    if(cmd==="슬롯"){
      const bet=Number(interaction.options.getInteger("배팅")??SLOT_DEFAULT_BET);
      if(bet<=0){await interaction.reply({content:"배팅은 양수여야 합니다",ephemeral:true});return;}
      const user=await getUser(uid);
      if(user.balance<bet){await interaction.reply({content:"잔고 부족",ephemeral:true});return;}
      await changeBalance(uid,-bet,"slot_bet");
      const spin=spinSlot();
      if(spin.multiplier>0) await changeBalance(uid,bet*spin.multiplier,"slot_win");
      const newBal=(await getUser(uid)).balance;
      await interaction.reply({content:`슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n${spin.multiplier>0?`승리! 배수: ${spin.multiplier}`:`꽝!`}\n현재 잔고: ${newBal}`});
      return;
    }

    // 복권구매
    if(cmd==="복권구매"){
      const qty=Number(interaction.options.getInteger("수량")??1);
      if(qty<=0){await interaction.reply({content:"1장 이상 구매하세요",ephemeral:true});return;}
      const price=qty*1000;
      const user=await getUser(uid);
      if(user.balance<price){await interaction.reply({content:"잔고 부족",ephemeral:true});return;}
      for(let i=0;i<qty;i++){
        const ticket=Math.random().toString(36).slice(2,10).toUpperCase();
        await db.run("INSERT INTO lottery_tickets(user_id, ticket_number, ts) VALUES(?,?,?)",uid,ticket,Date.now());
      }
      await changeBalance(uid,-price,"lottery_buy");
      await interaction.reply({content:`${qty}장 구매 완료 (총 ${price}포인트 차감)`});
      return;
    }

    // 복권상태
    if(cmd==="복권상태"){
      const cntRow=await db.get("SELECT COUNT(*) as c FROM lottery_tickets");
      const cnt=cntRow?Number(cntRow.c||0):0;
      await interaction.reply({content:`현재 복권 판매량: ${cnt}장`,ephemeral:true});
      return;
    }

    // 관리자지급
    if(cmd==="관리자지급"){
      if(!isAdmin(uid)){await interaction.reply({content:"관리자 전용",ephemeral:true});return;}
      const target=interaction.options.getUser("대상");
      const amount=Number(interaction.options.getInteger("금액")||0);
      if(!target){await interaction.reply({content:"대상 지정 필요",ephemeral:true});return;}
      await changeBalance(target.id,amount,"admin_adjust");
      await interaction.reply({content:`<@${target.id}>에게 ${amount}포인트 적용 완료`});
      return;
    }

    // 골라
    if(cmd==="골라"){
      await interaction.deferReply();
      const raw=(interaction.options.getString("option")||"").trim();
      let count=Number(interaction.options.getInteger("count")||1);
      if(!raw){await interaction.editReply("옵션을 입력하세요.");return;}
      const parts=raw.split(/\s*,\s*|\s*\/\s*|\s+or\s+|\r?\n|[,;]\s*|\s+/i).map(s=>s.trim()).filter(Boolean);
      if(parts.length===0){await interaction.editReply("유효한 옵션이 없습니다.");return;}
      if(!Number.isInteger(count)||count<1) count=1;
      if(count>parts.length) count=parts.length;
      const shuffled=parts.sort(()=>Math.random()-0.5);
      const picks=shuffled.slice(0,count);
      const content=count===1?`✅ 선택: **${picks[0]}**\n(총 ${parts.length}개 옵션 중)`: `✅ ${count}개 선택: ${picks.map(p=>`**${p}**`).join(", ")}\n(총 ${parts.length}개 옵션 중)`;
      await interaction.editReply(content);
      return;
    }

    // 경마
    if(cmd==="경마"){
      await interaction.deferReply();
      const number=interaction.options.getInteger("번호")-1;
      const bet=interaction.options.getInteger("배팅")||100;
      if(number<0||number>=horses.length){await interaction.editReply("번호는 1~7 사이여야 합니다.");return;}
      const user=await getUser(uid);
      if(user.balance<bet){await interaction.editReply("잔고 부족");return;}
      await changeBalance(uid,-bet,"race_bet");
      const bettors=new Map();
      bettors.set(uid,{horseIndex:number,bet});
      const winnerIdx=await startRace(interaction.channel,bettors);
      const newBal=(await getUser(uid)).balance;
      await interaction.editReply(`🏁 경마 종료! 현재 잔고: ${newBal}`);
      return;
    }

    // 블랙잭
    if(cmd==="블랙잭"){
      await interaction.deferReply();
      const bet=interaction.options.getInteger("배팅")||100;
      const user=await getUser(uid);
      if(bet<=0||user.balance<bet){await interaction.editReply("배팅 금액 오류 또는 잔고 부족");return;}
      await changeBalance(uid,-bet,"blackjack_bet");
      const deck=createDeck(), draw=()=>deck.pop();
      const playerCards=[draw(),draw()], dealerCards=[draw(),draw()];
      let playerTotal=calcBlackjackHandValue(playerCards), dealerTotal=calcBlackjackHandValue(dealerCards);
      while(playerTotal<17){playerCards.push(draw());playerTotal=calcBlackjackHandValue(playerCards);}
      while(dealerTotal<17){dealerCards.push(draw());dealerTotal=calcBlackjackHandValue(dealerCards);}
      let text=`🃏 블랙잭 결과 🃏\n플레이어: ${playerCards.join(",")} (${playerTotal})\n딜러: ${dealerCards.join(",")} (${dealerTotal})\n`;
      if(playerTotal>21) text+="❌ 버스트! 패배\n";
      else if(dealerTotal>21||playerTotal>dealerTotal){ await changeBalance(uid,bet*2,"blackjack_win"); text+="✅ 승리!\n"; }
      else if(playerTotal===dealerTotal){ await changeBalance(uid,bet,"blackjack_draw"); text+="🤝 무승부\n"; }
      else text+="❌ 딜러 승리\n";
      text+=`잔고: ${(await getUser(uid)).balance}`;
      await interaction.editReply(text);
      return;
    }

    // 바카라
    if(cmd==="바카라"){
      await interaction.deferReply();
      const side=interaction.options.getString("배팅방향")||"플레이어";
      const bet=interaction.options.getInteger("배팅")||100;
      if(!["플레이어","뱅커","무승부"].includes(side)){await interaction.editReply("배팅 방향 오류");return;}
      const user=await getUser(uid);
      if(user.balance<bet){await interaction.editReply("잔고 부족");return;}
      await changeBalance(uid,-bet,"baccarat_bet");
      const deck=createDeck(), draw=()=>deck.pop();
      const playerCards=[draw(),draw()], bankerCards=[draw(),draw()];
      const baccaratValue=c=>c==="A"?1:["J","Q","K","10"].includes(c)?0:Number(c);
      const calcTotal=cards=>cards.reduce((a,c)=>a+baccaratValue(c),0)%10;
      const playerTotal=calcTotal(playerCards), bankerTotal=calcTotal(bankerCards);
      let winner=playerTotal>bankerTotal?"플레이어":bankerTotal>playerTotal?"뱅커":"무승부";
      let payout=0,text=`🎴 바카라 결과 🎴\n플레이어: ${playerCards.join(",")} (${playerTotal})\n뱅커: ${bankerCards.join(",")} (${bankerTotal})\n`;
      if(side===winner){
        if(winner==="플레이어") payout=bet*2;
        else if(winner==="뱅커") payout=Math.floor(bet*1.95);
        else payout=bet*9;
        await changeBalance(uid,payout,"baccarat_win");
        text+=`✅ 승리! 상금 ${payout} 지급\n`;
      } else text+=`❌ 패배. 배팅액 ${bet} 차감\n`;
      text+=`잔고: ${(await getUser(uid)).balance}`;
      await interaction.editReply(text);
      return;
    }

  }catch(e){ console.error(e); try{ if(interaction.deferred||interaction.replied) await interaction.editReply("⚠️ 오류 발생"); else await interaction.reply({content:"⚠️ 오류 발생",ephemeral:true}); }catch(_){} }
});

////////////////////////////////////////////////////////////////////////////////
// ready
////////////////////////////////////////////////////////////////////////////////
client.once("ready", async()=>{
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  await registerCommands();
  if(GUILD_ID){
    const guild=await client.guilds.fetch(GUILD_ID).catch(()=>null);
    if(guild&&guild.systemChannelId) scheduleLottery(guild.systemChannelId);
    else scheduleLottery(null);
  } else scheduleLottery(null);
  console.log("봇 준비 완료");
});

////////////////////////////////////////////////////////////////////////////////
// 로그인
////////////////////////////////////////////////////////////////////////////////
client.login(TOKEN);
