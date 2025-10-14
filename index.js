// index.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } from "discord.js";
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

  // promisify
  db.runAsync = promisify(db.run.bind(db));
  db.getAsync = promisify(db.get.bind(db));
  db.allAsync = promisify(db.all.bind(db));
}

// -------------------
// 유틸
// -------------------
function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

async function getUser(userId) {
  let row = await db.getAsync("SELECT * FROM users WHERE id=?", userId);
  if (!row) {
    await db.runAsync("INSERT INTO users(id,balance,last_claim) VALUES(?,?,?)", userId, 0, 0);
    row = await db.getAsync("SELECT * FROM users WHERE id=?", userId);
  }
  return row;
}

async function changeBalance(userId, delta, reason="adjust") {
  await getUser(userId);
  await db.run("UPDATE users SET balance=? WHERE id=?", 100, uid);
  await db.runAsync("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", userId, delta, reason, Date.now());
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
// 게임 상태 저장
// -------------------
const activeBlackjacks = new Map();
const activeBaccarat = new Map();
const HORSES = ["🐎","🐎","🐎","🐎","🐎","🐎","🐎"];
client.racePending = null;

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
function createDeck(){
  const faces = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck=[];
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
  const tickets = await db.allAsync("SELECT * FROM lottery_tickets");
  if(tickets.length===0){ if(channel) channel.send("오늘 복권 참여자가 없습니다."); return; }
  const winnerTicket = tickets[Math.floor(Math.random()*tickets.length)];
  const winnerId = winnerTicket.user_id;
  const prize = tickets.length*100;
  await changeBalance(winnerId, prize, "lottery_prize");
  await db.runAsync("DELETE FROM lottery_tickets");
  if(channel) channel.send({ content: `<@${winnerId}> 님이 복권에 당첨되었습니다! 상금: ${prize}포인트 🎉`});
}

function scheduleLottery(channelId){
  cron.schedule("0 0 21 * * *", async ()=>{
    const channel = channelId ? await client.channels.fetch(channelId).catch(()=>null) : null;
    await runLotteryDraw(channel);
  }, { timezone:"Asia/Seoul" });
}

// -------------------
// 경마 헬퍼
// -------------------
function generateRaceMessage(positions){
  return positions.map((p,i)=>`${HORSES[i]} |${"·".repeat(p)}🏁`).join("\n");
}

async function runRace(channelId){
  const race = client.racePending;
  if(!race || race.channelId!==channelId) return;
  const bettors = race.bettors;
  client.racePending=null;
  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;

  let positions = Array(HORSE_COUNT).fill(0);
  const msg = await channel.send("경주 시작 준비...");
  let finished=false;

  const interval = setInterval(async ()=>{
    for(let i=0;i<HORSE_COUNT;i++){
      positions[i]+=Math.random()<0.5?0:Math.floor(Math.random()*3);
      if(positions[i]>=30) positions[i]=30;
    }
    await msg.edit(generateRaceMessage(positions));
    const winners=positions.map((p,i)=>p>=30?i:null).filter(x=>x!==null);
    if(winners.length>0){
      finished=true;
      clearInterval(interval);
      const winnerIdx=winners[0];
      for(const [uid,b] of bettors.entries()){
        if(b.horseIndex===winnerIdx) await changeBalance(uid,b.bet*5,"horse_win");
      }
      await channel.send(`경주 종료! 우승 말: ${HORSES[winnerIdx]} (번호 ${winnerIdx+1})`);
    }
  },1000);

  setTimeout(()=>{ if(!finished){ clearInterval(interval); msg.reply("경주가 시간초과로 종료되었습니다."); } },40000);
}

// -------------------
// interactionCreate
// -------------------
client.on("interactionCreate", async interaction=>{
  if(!interaction.isChatInputCommand()) return;
  const uid = interaction.user.id;
  const cmd = interaction.commandName;

  if(cmd==="돈줘"){
    const user = await getUser(uid);
    const now = Date.now();
    const dayMs = 24*60*60*1000;
    if(now - (user.last_claim||0) < dayMs) return interaction.reply({ content:"이미 24시간 내에 지급받았습니다.", ephemeral:true });
    await db.runAsync("UPDATE users SET balance=balance+?, last_claim=? WHERE id=?", DEFAULT_STARTING, now, uid);
    await db.runAsync("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", uid, DEFAULT_STARTING, "daily_claim", now);
    return interaction.reply({ content:`기본금 ${DEFAULT_STARTING}포인트 지급 완료!`, ephemeral:true });
  }

  if(cmd==="잔고"){
    const user = await getUser(uid);
    return interaction.reply({ content:`잔고: ${user.balance}포인트`, ephemeral:true });
  }

  if(cmd==="슬롯"){
    const bet = interaction.options.getInteger("배팅") ?? SLOT_DEFAULT_BET;
    if(bet<=0) return interaction.reply({ content:"배팅은 양수여야 합니다.", ephemeral:true });
    const user = await getUser(uid);
    if(user.balance<bet) return interaction.reply({ content:"잔고 부족", ephemeral:true });
    const spin = spinSlot();
    const delta = spin.payout>0 ? bet*spin.payout : -bet;
    await changeBalance(uid, delta, "slot");
    const newBal = (await getUser(uid)).balance;
    return interaction.reply({ content:`슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n배팅 ${bet}, 결과 ${delta>0?`승리 +${delta}`:`패배 ${-delta}`}\n잔고: ${newBal}` });
  }

  if(cmd==="복권구매"){
    const qty = interaction.options.getInteger("수량") ?? 1;
    if(qty<=0) return interaction.reply({ content:"1장 이상 구매하세요.", ephemeral:true });
    const price = qty*100;
    const user = await getUser(uid);
    if(user.balance<price) return interaction.reply({ content:"잔고 부족", ephemeral:true });
    for(let i=0;i<qty;i++){
      const ticket = Math.random().toString(36).slice(2,10).toUpperCase();
      await db.runAsync("INSERT INTO lottery_tickets(user_id, ticket_number, ts) VALUES(?,?,?)", uid, ticket, Date.now());
    }
    await changeBalance(uid, -price, "lottery_buy");
    return interaction.reply({ content:`${qty}장 구매 완료 (총 ${price}포인트 차감)` });
  }

  if(cmd==="복권상태"){
    const cnt = (await db.getAsync("SELECT COUNT(*) as c FROM lottery_tickets")).c;
    return interaction.reply({ content:`현재 복권 판매량: ${cnt}장`, ephemeral:true });
  }

  if(cmd==="관리자지급"){
    if(!isAdmin(uid)) return interaction.reply({ content:"관리자 전용", ephemeral:true });
    const target = interaction.options.getUser("대상");
    const amount = interaction.options.getInteger("금액");
    if(!target) return interaction.reply({ content:"대상을 지정하세요.", ephemeral:true });
    await changeBalance(target.id, amount, "admin_adjust");
    return interaction.reply({ content:`<@${target.id}> 에게 ${amount}포인트 적용 완료.` });
  }

  // -------------------
  // 블랙잭
  // -------------------
  if(cmd==="블랙잭"){
    await interaction.deferReply();
    let bet = interaction.options.getInteger("배팅") ?? TABLE_MIN_BET;
    const channelId = interaction.channelId;
    if(bet<TABLE_MIN_BET) return interaction.editReply(`최소 배팅: ${TABLE_MIN_BET}`);
    const user = await getUser(uid);
    if(user.balance<bet) return interaction.editReply("잔고 부족");

    let game = activeBlackjacks.get(channelId);
    if(!game){
      game = { players:new Map(), dealer:{hand:[],score:0}, state:"waiting" };
      activeBlackjacks.set(channelId, game);
      setTimeout(()=>{ if(activeBlackjacks.get(channelId)===game) activeBlackjacks.delete(channelId); },2*60*1000);
    }
    if(game.state!=="waiting") return interaction.editReply("이미 진행중");
    if(game.players.has(uid)) return interaction.editReply("이미 참가함");

    game.players.set(uid, { bet, hand:[], stood:false, busted:false });
    await changeBalance(uid, -bet, "blackjack_lock");
    interaction.editReply(`블랙잭 참가: ${bet}포인트, 참가자 수:${game.players.size}`);

    if(game.players.size>=1) setTimeout(()=>startBlackjack(channelId),5000);
  }

  // -------------------
  // 바카라
  // -------------------
  if(cmd==="바카라"){
    await interaction.deferReply();
    let bet = interaction.options.getInteger("배팅") ?? TABLE_MIN_BET;
    const channelId = interaction.channelId;
    if(bet<TABLE_MIN_BET) return interaction.editReply(`최소 배팅: ${TABLE_MIN_BET}`);
    const user = await getUser(uid);
    if(user.balance<bet) return interaction.editReply("잔고 부족");

    let game = activeBaccarat.get(channelId);
    if(!game){
      game={ players:new Map(), state:"waiting" };
      activeBaccarat.set(channelId, game);
      setTimeout(()=>{ if(activeBaccarat.get(channelId)===game) activeBaccarat.delete(channelId); },2*60*1000);
    }
    if(game.state!=="waiting") return interaction.editReply("이미 진행중");
    if(game.players.has(uid)) return interaction.editReply("이미 참가함");

    const side = interaction.options.getString("배팅방향") ?? "플레이어";
    game.players.set(uid,{ bet, side });
    await changeBalance(uid, -bet, "baccarat_lock");
    interaction.editReply(`바카라 ${side} 배팅: ${bet}포인트, 참가자 수:${game.players.size}`);

    if(game.players.size>=1) setTimeout(()=>startBaccarat(channelId),5000);
  }

  // -------------------
  // 경마
  // -------------------
  if(cmd==="경마"){
    await interaction.deferReply();
    const horseIndex = interaction.options.getInteger("번호")-1;
    const bet = interaction.options.getInteger("배팅") ?? TABLE_MIN_BET;
    const channelId = interaction.channelId;
    if(horseIndex<0 || horseIndex>=HORSE_COUNT) return interaction.editReply("올바른 번호 선택");
    const user = await getUser(uid);
    if(user.balance<bet) return interaction.editReply("잔고 부족");

    if(!client.racePending) client.racePending={ channelId, bettors:new Map() };
    client.racePending.bettors.set(uid,{ horseIndex, bet });
    await changeBalance(uid, -bet, "horse_lock");
    interaction.editReply(`${HORSES[horseIndex]}에 ${bet}포인트 배팅 완료`);

    if(client.racePending.bettors.size>=1) setTimeout(()=>runRace(channelId),5000);
  }
});

// -------------------
// 블랙잭 자동 진행
// -------------------
async function startBlackjack(channelId){
  const game = activeBlackjacks.get(channelId);
  if(!game) return;
  game.state="playing";
  const deck = createDeck();
  game.dealer.hand=[deck.pop(),deck.pop()];
  game.dealer.score=calcBlackjack(game.dealer.hand);

  for(const [uid,p] of game.players.entries()){
    p.hand=[deck.pop(),deck.pop()];
    p.score=calcBlackjack(p.hand);
  }

  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;

  for(const [uid,p] of game.players.entries()){
    const bust = p.score>21;
    if(bust){ p.busted=true; await channel.send(`<@${uid}> 블랙잭: ${p.hand.join(",")} - 버스트!`); }
    else await channel.send(`<@${uid}> 블랙잭: ${p.hand.join(",")} - 점수 ${p.score}`);
  }

  // 딜러 점수 계산
  while(game.dealer.score<17){
    game.dealer.hand.push(deck.pop());
    game.dealer.score=calcBlackjack(game.dealer.hand);
  }
  await channel.send(`딜러 카드: ${game.dealer.hand.join(",")} 점수:${game.dealer.score}`);

  for(const [uid,p] of game.players.entries()){
    let delta=0;
    if(p.busted) delta=-p.bet;
    else if(game.dealer.score>21 || p.score>game.dealer.score) delta=p.bet*2;
    else if(p.score===game.dealer.score) delta=p.bet;
    else delta=-p.bet;
    if(delta!==0) await changeBalance(uid, delta, "blackjack_result");
    await channel.send(`<@${uid}> 결과: ${delta>0?`승리 +${delta}`:`패배 ${-delta}`}`);
  }
  activeBlackjacks.delete(channelId);
}

// -------------------
// 바카라 자동 진행
// -------------------
async function startBaccarat(channelId){
  const game = activeBaccarat.get(channelId);
  if(!game) return;
  game.state="playing";

  const deck=createDeck();
  let player=[deck.pop(),deck.pop()];
  let banker=[deck.pop(),deck.pop()];
  const score = arr=> (arr.map(c=>["J","Q","K"].includes(c)?0:c==="A"?1:Number(c)).reduce((a,b)=>a+b,0))%10;

  const playerScore=score(player);
  const bankerScore=score(banker);
  const channel=await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;

  await channel.send(`플레이어: ${player.join(",")} 점수:${playerScore}\n뱅커: ${banker.join(",")} 점수:${bankerScore}`);

  for(const [uid,p] of game.players.entries()){
    let delta=0;
    const winner=playerScore>bankerScore?"플레이어":playerScore<bankerScore?"뱅커":"무승부";
    if(p.side===winner) delta=p.bet*(winner==="무승부"?8:2);
    else if(winner==="무승부") delta=0;
    else delta=-p.bet;
    if(delta!==0) await changeBalance(uid, delta, "baccarat_result");
    await channel.send(`<@${uid}> 결과: ${delta>0?`승리 +${delta}`:`패배 ${-delta}`}`);
  }
  activeBaccarat.delete(channelId);
}

// -------------------
// 슬래시 명령 등록
// -------------------
const commandList = [
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 지급"),
  new SlashCommandBuilder().setName("잔고").setDescription("잔고 조회"),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("복권구매").setDescription("복권 구매").addIntegerOption(o=>o.setName("수량").setDescription("구매 장 수").setRequired(false)),
  new SlashCommandBuilder().setName("복권상태").setDescription("복권 판매 현황"),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 포인트 조정")
    .addUserOption(o=>o.setName("대상").setDescription("대상 유저").setRequired(true))
    .addIntegerOption(o=>o.setName("금액").setDescription("양수=지급, 음수=회수").setRequired(true)),
  new SlashCommandBuilder().setName("블랙잭").setDescription("블랙잭 게임").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("바카라").setDescription("바카라 게임")
    .addStringOption(o=>o.setName("배팅방향").setDescription("플레이어/뱅커/무승부").setRequired(false))
    .addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("경마").setDescription("경마 게임")
    .addIntegerOption(o=>o.setName("번호").setDescription("1~7번 선택").setRequired(true))
    .addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false))
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

