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
// 슬래시 명령어 등록(시작 시 등록)
const commands = [
  new SlashCommandBuilder().setName("돈줘").setDescription("기본금 1000포인트를 24시간마다 받을 수 있습니다."),
  new SlashCommandBuilder().setName("잔고").setDescription("내 포인트를 보여줍니다."),
  new SlashCommandBuilder().setName("슬롯").setDescription("슬롯머신을 돌립니다.").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("블랙잭").setDescription("블랙잭 게임에 참여하거나 시작합니다.").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("바카라").setDescription("바카라 게임 시작/참여").addIntegerOption(o=>o.setName("배팅").setDescription("배팅 금액").setRequired(false)),
  new SlashCommandBuilder().setName("경마").setDescription("경마를 시작합니다. (베팅 후 시작)"),
  new SlashCommandBuilder().setName("복권구매").setDescription("복권을 구매합니다. (1장당 100)").addIntegerOption(o=>o.setName("수량").setDescription("구매할 장 수").setRequired(false)),
  new SlashCommandBuilder().setName("복권상태").setDescription("이번 복권의 구매자 수를 보여줍니다."),
  new SlashCommandBuilder().setName("관리자지급").setDescription("관리자 전용: 포인트를 지급/회수합니다.")
    .addUserOption(o=>o.setName("대상").setDescription("대상 유저").setRequired(true))
    .addIntegerOption(o=>o.setName("금액").setDescription("양수는 지급, 음수는 회수").setRequired(true)),
].map(cmd => cmd.toJSON());

// register commands (guild if GUILD_ID provided, otherwise global)
async function registerCommands(){
  if(!CLIENT_ID || !TOKEN) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try{
    if(GUILD_ID){
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("Registered guild commands");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("Registered global commands");
    }
  }catch(e){ console.error("Failed reg commands", e); }
}

// 슬롯머신 로직 (간단)
function spinSlot(){
  const reels = ["🍒","🍋","🍊","🔔","⭐","7️⃣"];
  const r1 = reels[Math.floor(Math.random()*reels.length)];
  const r2 = reels[Math.floor(Math.random()*reels.length)];
  const r3 = reels[Math.floor(Math.random()*reels.length)];
  // 페이아웃 간단히 정의
  let payout = 0;
  if(r1===r2 && r2===r3){
    if(r1==="7️⃣") payout = 10;
    else if(r1==="⭐") payout = 6;
    else payout = 4;
  } else if(r1===r2 || r2===r3 || r1===r3){
    payout = 2;
  }
  return {r1,r2,r3,payout};
}

// Blackjack, Baccarat은 단순 구현 (멀티플레이 기본 틀 제공)
const activeBlackjacks = new Map(); // channelId -> game state
const activeBaccarat = new Map();

// 경마: 7마리, 이모지, 애니메이션
const horses = ["🐎","🏇","🐴","🦄","🐎","🐎","🐎"]; // 7마리 (이모지 사용)
function generateRaceMessage(positions){
  const lines = positions.map((p,i)=>`${horses[i]} |${"·".repeat(p)}🏁`);
  return lines.join("\n");
}

// 복권: 매일 09:00 KST에 자동 추첨
async function runLotteryDraw(channel){
  // 모든 티켓 읽기
  const tickets = await db.all("SELECT * FROM lottery_tickets");
  if(tickets.length===0){
    if(channel) channel.send("오늘 복권 참여자가 없습니다. 당첨자 없음.");
    return;
  }
  // 단순 무작위 당첨자(1명). 티켓 수 비례
  const winIndex = Math.floor(Math.random()*tickets.length);
  const winnerTicket = tickets[winIndex];
  const winnerId = winnerTicket.user_id;
  // 상금: 티켓당 100 포인트
  const prize = tickets.length * 100;
  await changeBalance(winnerId, prize, "lottery_prize");
  // DB 티켓 초기화
  await db.exec("DELETE FROM lottery_tickets");
  if(channel){
    channel.send({ content: `<@${winnerId}> 님이 복권에 당첨되었습니다! 상금: ${prize}포인트 🎉`});
  }
}

// 스케줄러 세팅 (KST 기준 매일 09:00)
function scheduleLottery(channelIdForAnnounce){
  // node-cron uses server timezone unless tz option provided. 사용할 tz는 "Asia/Seoul"
  // Cron expression for 09:00 every day: "0 0 9 * * *" (second, minute, hour, ...)
  cron.schedule("0 0 9 * * *", async () => {
    const channel = channelIdForAnnounce ? await client.channels.fetch(channelIdForAnnounce).catch(()=>null) : null;
    await runLotteryDraw(channel);
  }, { timezone: "Asia/Seoul" });
}

// 이벤트 핸들링
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  await registerCommands();
  // 스케줄러: 공지 채널 ID(예: GUILD_ID의 default 채널)을 넣어두면 편함.
  // 여기선 GUILD_ID가 있으면 그 서버의 systemChannel에 등록
  if(GUILD_ID){
    const guild = await client.guilds.fetch(GUILD_ID).catch(()=>null);
    if(guild && guild.systemChannelId){
      scheduleLottery(guild.systemChannelId);
      console.log("Lottery scheduled to announce in system channel");
    } else {
      scheduleLottery(null);
      console.log("Lottery scheduled but no announce channel");
    }
  } else {
    scheduleLottery(null);
    console.log("Lottery scheduled without announce channel");
  }
});

// 명령어 처리
client.on("interactionCreate", async (interaction) => {
  if(!interaction.isChatInputCommand()) return;
  const uid = interaction.user.id;
  const cmd = interaction.commandName;

  if(cmd==="돈줘"){
    await interaction.deferReply({ ephemeral: true });
    const user = await getUser(uid);
    const now = Date.now();
    const last = user.last_claim || 0;
    const dayMs = 24*60*60*1000;
    if(now - last < dayMs){
      const rem = Math.ceil((dayMs - (now-last))/1000);
      return interaction.editReply(`이미 24시간 이내에 지급받았습니다. 남은 시간(초): ${rem}`);
    }
    await db.run("UPDATE users SET balance = balance + ?, last_claim = ? WHERE id = ?", DEFAULT_STARTING, now, uid);
    await db.run("INSERT INTO transactions(user_id, delta, reason, ts) VALUES(?,?,?,?)", uid, DEFAULT_STARTING, "daily_claim", now);
    return interaction.editReply(`기본금 ${DEFAULT_STARTING}포인트 지급 완료!`);
  }

  if(cmd==="잔고"){
    const user = await getUser(uid);
    return interaction.reply({ content: `<@${uid}> 님의 잔고: ${user.balance}포인트`, ephemeral: true });
  }

  if(cmd==="슬롯"){
    await interaction.deferReply();
    let bet = interaction.options.getInteger("배팅") ?? SLOT_DEFAULT_BET;
    if(bet<=0) return interaction.editReply("배팅은 양수여야 합니다.");
    const user = await getUser(uid);
    if(user.balance < bet) return interaction.editReply("잔고가 부족합니다.");
    const spin = spinSlot();
    // 결과 계산
    const multiplier = spin.payout;
    const win = bet * multiplier;
    const delta = multiplier>0 ? win : -bet;
    await changeBalance(uid, delta, "slot");
    let txt = `슬롯 결과: ${spin.r1} ${spin.r2} ${spin.r3}\n`;
    if(multiplier>0) txt += `축하합니다! 승리! 배수: ${multiplier} => ${win}포인트 획득\n`;
    else txt += `꽝! 배팅액 ${bet}포인트 차감\n`;
    const newBal = (await getUser(uid)).balance;
    txt += `현재 잔고: ${newBal}포인트`;
    return interaction.editReply(txt);
  }

  if(cmd==="블랙잭"){
    // 간단 멀티 플레이 틀: 채널별로 게임 생성/참여, 기본 배팅 TABLE_MIN_BET
    await interaction.deferReply();
    let bet = interaction.options.getInteger("배팅") ?? TABLE_MIN_BET;
    const channelId = interaction.channelId;
    if(bet < TABLE_MIN_BET) return interaction.editReply(`최소 배팅은 ${TABLE_MIN_BET} 입니다.`);
    const user = await getUser(uid);
    if(user.balance < bet) return interaction.editReply("잔고가 부족합니다.");
    // 게임 없으면 생성하고 참가자 등록
    let game = activeBlackjacks.get(channelId);
    if(!game){
      game = {
        players: new Map(), // userId -> {bet, hand, stood, busted}
        dealer: { hand: [], score: 0 },
        state: "waiting" // waiting -> playing -> finished
      };
      activeBlackjacks.set(channelId, game);
      // auto-expire after 2 minutes if not started
      setTimeout(()=>{ if(activeBlackjacks.get(channelId)===game) activeBlackjacks.delete(channelId); }, 2*60*1000);
    }
    if(game.state !== "waiting") return interaction.editReply("이미 진행중인 게임입니다. 다음 게임을 기다려주세요.");
    if(game.players.has(uid)) return interaction.editReply("이미 참가하셨습니다.");
    // 참가자 기록 (배팅은 나중에 차감)
    game.players.set(uid, { bet, hand: [], stood:false, busted:false, joinedAt: Date.now() });
    await changeBalance(uid, -bet, "blackjack_lock");
    interaction.editReply(`블랙잭에 참가했습니다. 배팅 ${bet}포인트. 현재 참가자 수: ${game.players.size}\n명령어로 시작하려면 /블랙잭 시작(관리자 혹은 참가자 중 한 명)`);

    // 간단: 만약 참가자가 1명 이상이면 자동 시작(예시: 10초 대기 후 시작)
    if(game.players.size >= 1){
      setTimeout(()=> startBlackjack(channelId), 10000);
    }
  }

  if(cmd==="바카라"){
    await interaction.deferReply();
    let bet = interaction.options.getInteger("배팅") ?? TABLE_MIN_BET;
    const channelId = interaction.channelId;
    if(bet < TABLE_MIN_BET) return interaction.editReply(`최소 배팅은 ${TABLE_MIN_BET} 입니다.`);
    const user = await getUser(uid);
    if(user.balance < bet) return interaction.editReply("잔고가 부족합니다.");
    let game = activeBaccarat.get(channelId);
    if(!game){
      game = { players: new Map(), state: "waiting" };
      activeBaccarat.set(channelId, game);
      setTimeout(()=>{ if(activeBaccarat.get(channelId)===game) activeBaccarat.delete(channelId); }, 2*60*1000);
    }
    if(game.state !== "waiting") return interaction.editReply("이미 진행중인 게임입니다.");
    if(game.players.has(uid)) return interaction.editReply("이미 참가하셨습니다.");
    game.players.set(uid, { bet });
    await changeBalance(uid, -bet, "baccarat_lock");
    interaction.editReply(`바카라에 참가했습니다. 배팅 ${bet}포인트. 참가자 수: ${game.players.size}. 10초 후 자동 진행됩니다.`);
    setTimeout(()=> startBaccarat(channelId), 10000);
  }

  if(cmd==="경마"){
    await interaction.deferReply();
    // 간단 구현: 참가자는 blackjack/baccarat처럼 베팅하고, 10초 뒤 레이스 실행
    const channelId = interaction.channelId;
    // 참가자 선택 및 베팅을 간단화: 모든 참가자 동일 배팅 100
    const bet = 100;
    const user = await getUser(uid);
    if(user.balance < bet) return interaction.editReply("잔고가 부족합니다.");
    // 임시 저장: 채널별로 slot
    if(client.racePending && client.racePending.channelId !== channelId){
      return interaction.editReply("이미 다른 채널에서 경마가 진행 중입니다.");
    }
    if(!client.racePending) client.racePending = { channelId, bettors: new Map() };
    const race = client.racePending;
    if(race.bettors.has(uid)) return interaction.editReply("이미 베팅하셨습니다.");
    race.bettors.set(uid, { horseIndex: Math.floor(Math.random()*7), bet });
    await changeBalance(uid, -bet, "race_lock");
    interaction.editReply(`경마에 베팅 완료! 배팅 ${bet}포인트. 말은 자동 배정됩니다. 10초 후 경주 시작.`);
    setTimeout(()=> runRace(channelId), 10000);
  }

  if(cmd==="복권구매"){
    await interaction.deferReply();
    const qty = interaction.options.getInteger("수량") ?? 1;
    if(qty <= 0) return interaction.editReply("1장 이상 구매하세요.");
    const price = qty * 100;
    const user = await getUser(uid);
    if(user.balance < price) return interaction.editReply("잔고가 부족합니다.");
    for(let i=0;i<qty;i++){
      const ticketNum = Math.random().toString(36).slice(2,10).toUpperCase();
      await db.run("INSERT INTO lottery_tickets(user_id, ticket_number, ts) VALUES(?,?,?)", uid, ticketNum, Date.now());
    }
    await changeBalance(uid, -price, "lottery_buy");
    return interaction.editReply(`${qty}장 구매 완료! (총 ${price}포인트 차감)`);
  }

  if(cmd==="복권상태"){
    const cnt = (await db.get("SELECT COUNT(*) as c FROM lottery_tickets")).c;
    return interaction.reply({ content: `현재 복권 판매량: ${cnt}장`, ephemeral: true });
  }

  if(cmd==="관리자지급"){
    await interaction.deferReply();
    if(!isAdmin(uid)) return interaction.editReply("관리자 전용 명령입니다.");
    const target = interaction.options.getUser("대상");
    const amount = interaction.options.getInteger("금액");
    if(!target) return interaction.editReply("대상을 지정하세요.");
    await changeBalance(target.id, amount, "admin_adjust");
    return interaction.editReply(`<@${target.id}> 에게 ${amount}포인트 적용 완료.`);
  }
});

// Blackjack 시작(간단)
async function startBlackjack(channelId){
  const game = activeBlackjacks.get(channelId);
  if(!game) return;
  if(game.state !== "waiting") return;
  game.state = "playing";
  // 덱 생성
  const deck = createDeck();
  // deal 2 to dealer and to players
  for(const [uid, p] of game.players.entries()){
    p.hand = [deck.pop(), deck.pop()];
    p.stood = false;
    p.busted = false;
  }
  game.dealer.hand = [deck.pop(), deck.pop()];
  game.deck = deck;
  // send initial embed and action buttons for each player (간단: 플레이어는 DM으로 조작을 하게 만들거나, 채널에서 버튼으로 조작)
  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;
  let desc = "블랙잭 시작!\n";
  for(const [uid,p] of game.players.entries()){
    const score = calcBlackjack(p.hand);
    desc += `<@${uid}>: ${p.hand.join(", ")} (합계: ${score})\n`;
    if(score>21) p.busted = true;
  }
  desc += `딜러: ${game.dealer.hand[0]}, ??`;
  await channel.send(desc);

  // 턴별로 플레이어에게 DM 또는 채널에서 순차 진행 — 여기서는 채널에서 간단히 자동 처리: 각 플레이어는 17이하이면 히트, 아니면 스탠드(자동)
  for(const [uid,p] of game.players.entries()){
    let score = calcBlackjack(p.hand);
    while(score < 17){
      p.hand.push(game.deck.pop());
      score = calcBlackjack(p.hand);
      if(score>21){ p.busted = true; break; }
    }
    p.stood = true;
  }
  // 딜러 플레이
  let dscore = calcBlackjack(game.dealer.hand);
  while(dscore < 17){
    game.dealer.hand.push(game.deck.pop());
    dscore = calcBlackjack(game.dealer.hand);
  }
  // 결과정산
  const results = [];
  for(const [uid,p] of game.players.entries()){
    const pscore = calcBlackjack(p.hand);
    let outcome = "패배";
    if(p.busted) outcome = "버스트(패)";
    else if(dscore>21) outcome = "승리";
    else if(pscore> dscore) outcome = "승리";
    else if(pscore===dscore) outcome = "무승부";
    else outcome = "패배";
    // 정산: 승리 -> 배팅 *2 (원금 회수 + 동일금액 이익), 무승부 -> 배팅 환불, 패배 -> 이미 잠금으로 차감(손실)
    if(outcome==="승리"){
      await changeBalance(uid, p.bet*2, "blackjack_win"); // 이미 -bet 했으므로 +2*bet 해줌 => net +bet
    } else if(outcome==="무승부"){
      await changeBalance(uid, p.bet, "blackjack_push");
    }
    results.push({ uid, hand: p.hand, pscore, outcome });
  }
  // 메시지 전송
  let resTxt = `딜러 핸드: ${game.dealer.hand.join(", ")} (합계: ${dscore})\n`;
  for(const r of results){
    resTxt += `<@${r.uid}>: ${r.hand.join(", ")} (합계: ${r.pscore}) -> ${r.outcome}\n`;
  }
  await channel.send(resTxt);
  activeBlackjacks.delete(channelId);
}
function createDeck(){
  const faces = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for(let i=0;i<4;i++){
    for(const f of faces) deck.push(f);
  }
  // shuffle
  for(let i=deck.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]] = [deck[j],deck[i]];
  }
  return deck;
}
function calcBlackjack(hand){
  let total = 0;
  let aces = 0;
  for(const c of hand){
    if(c==="A"){ aces++; total += 11; }
    else if(["J","Q","K"].includes(c)) total += 10;
    else total += Number(c);
  }
  while(total>21 && aces>0){
    total -= 10; aces--;
  }
  return total;
}

// Baccarat 간단 구현 (플레이어 vs 뱅커 랜덤규칙에 따름)
async function startBaccarat(channelId){
  const game = activeBaccarat.get(channelId);
  if(!game) return;
  if(game.state !== "waiting") return;
  game.state = "playing";
  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;
  // 각 참여자에 대해 무작위 결과 결정 (간단): 플레이어/뱅커/무승부 확률 계산
  for(const [uid, p] of game.players.entries()){
    const rand = Math.random();
    let outcome;
    if(rand < 0.45) outcome = "플레이어";
    else if(rand < 0.9) outcome = "뱅커";
    else outcome = "무승부";
    // 정산: 플레이어/뱅커 승리시 배당: 2x (원금 포함) , 무승부 8x
    if(outcome === "플레이어" || outcome==="뱅커"){
      await changeBalance(uid, p.bet*2, "baccarat_win");
    } else {
      await changeBalance(uid, p.bet*8, "baccarat_tie");
    }
    await channel.send(`<@${uid}>: 결과 = ${outcome}`);
  }
  activeBaccarat.delete(channelId);
}

// 경마 레이스 실행 (애니메이션: 메시지 편집으로 위치 업데이트)
async function runRace(channelId){
  const race = client.racePending;
  if(!race || race.channelId !== channelId) return;
  const bettors = race.bettors;
  client.racePending = null;
  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;
  // 초기 positions
  let positions = new Array(7).fill(0);
  const msg = await channel.send("경주 시작 준비...");
  // 애니메이션: 20스텝 내에 랜덤으로 전진
  let finished = false;
  const interval = setInterval(async ()=>{
    for(let i=0;i<7;i++){
      positions[i] += Math.random() < 0.5 ? 0 : Math.floor(Math.random()*3);
      if(positions[i] >= 30) positions[i] = 30;
    }
    await msg.edit(generateRaceMessage(positions));
    // 체크 우승자
    const winners = positions.map((p,i)=>p>=30?i:null).filter(x=>x!==null);
    if(winners.length>0){
      finished = true;
      clearInterval(interval);
      const winnerIdx = winners[0];
      // 모든 베터 중에서 자신의 말이 우승했는지 확인하여 정산
      for(const [uid, b] of bettors.entries()){
        if(b.horseIndex === winnerIdx){
          // 우승자에게 5배 지급 (간단)
          await changeBalance(uid, b.bet*5, "horse_win");
        }
      }
      await channel.send(`경주 종료! 우승 말: ${horses[winnerIdx]} (번호 ${winnerIdx+1})`);
    }
  }, 1000);
  // 타임아웃 방지: 40초 후 강제 종료
  setTimeout(()=>{ if(!finished){ clearInterval(interval); msg.reply("경주가 시간초과로 종료되었습니다."); } }, 40000);
}

// 로그인
client.login(TOKEN);
