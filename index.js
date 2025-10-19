// ===== 안정화 코드: 가장 상단 =====

// 전역 예외 처리
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception 발생:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Unhandled Rejection 발생:', reason));

// 안전한 Interval Wrapper
async function safeInterval(callback, intervalMs) {
  return setInterval(async () => {
    try { await callback(); } catch (err) { console.error('💥 Interval 에러:', err); }
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

if (KEEPALIVE_URL) setInterval(() => { fetch(KEEPALIVE_URL).then(()=>console.log('🔁 Keep-alive ping')).catch(()=>{}); }, 1000*60*4);

// ===== Discord 클라이언트 초기화 =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

let db;

// ===== DB 초기화 =====
async function initDB() {
  db = await open({ filename: './data.sqlite', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, balance INTEGER DEFAULT 1000, last_claim INTEGER DEFAULT 0);`);
  await db.exec(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, amount INTEGER, reason TEXT, timestamp INTEGER);`);
  await db.exec(`CREATE TABLE IF NOT EXISTS lottery_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, numbers TEXT, draw_date TEXT);`);
  console.log('✅ 데이터베이스 초기화 완료');
}

// ===== 안전 DB 함수 =====
async function safeDBRun(query, ...params){ try{ return await db.run(query,...params); }catch(err){ console.error('💥 DB 실행 에러:', err, query, params); throw err; } }
async function safeDBGet(query, ...params){ try{ return await db.get(query,...params); }catch(err){ console.error('💥 DB 조회 에러:', err, query, params); throw err; } }
async function safeDBAll(query, ...params){ try{ return await db.all(query,...params); }catch(err){ console.error('💥 DB 전체 조회 에러:', err, query, params); throw err; } }

// ===== 유틸 함수 =====
async function getUser(id) {
  let user = await safeDBGet('SELECT * FROM users WHERE id=?', id);
  if(!user){ await safeDBRun('INSERT INTO users (id,balance) VALUES (?,?)', id, 1000); user={id,balance:1000,last_claim:0}; }
  return user;
}

async function updateBalance(userId, amount, reason){
  await safeDBRun('BEGIN TRANSACTION');
  try{
    const user = await getUser(userId);
    const newBalance = Math.max(0,user.balance+amount);
    await safeDBRun('UPDATE users SET balance=? WHERE id=?', newBalance, userId);
    await safeDBRun('INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?,?,?,?)', userId, amount, reason, Date.now());
    await safeDBRun('COMMIT');
    return newBalance;
  } catch(err){
    await safeDBRun('ROLLBACK'); throw err;
  }
}

// ===== 슬롯머신 =====
function spinSlot(){
  const symbols=['🍒','🍋','🍇','💎','7️⃣'];
  return [0,1,2].map(()=>symbols[Math.floor(Math.random()*symbols.length)]);
}

// ===== 경마/블랙잭/바카라 관련 데이터 =====
const RACE_PAYOUT_MULTIPLIER=5;
const horses=[
  {name:'썬더',emoji:'🐎'},{name:'스피드',emoji:'🐎'},{name:'라이트닝',emoji:'🐎'},
  {name:'블레이드',emoji:'🐎'},{name:'토네이도',emoji:'🐎'},{name:'스타',emoji:'🐎'},{name:'썬샤인',emoji:'🐎'}
];
const suits=['♠️','♥️','♦️','♣️'];
const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function drawCard(deck){ return deck.pop(); }
function calcHandValue(hand){
  let value=0, aces=0;
  for(const c of hand){
    if(['J','Q','K'].includes(c.rank)) value+=10;
    else if(c.rank==='A'){ value+=11; aces++; }
    else value+=parseInt(c.rank);
  }
  while(value>21 && aces>0){ value-=10; aces--; }
  return value;
}
function createDeck(){
  const deck=[]; for(const s of suits) for(const r of ranks) deck.push({suit:s,rank:r});
  for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
function baccaratValue(hand){ return hand.map(c=>['J','Q','K'].includes(c.rank)?0:c.rank==='A'?1:parseInt(c.rank)).reduce((a,b)=>a+b)%10; }

// ===== 복권 채널 탐색 =====
async function findLotteryChannel(client){
  for(const guild of client.guilds.cache.values()){
    const channel=guild.channels.cache.find(c=>c.type===ChannelType.GuildText && (c.name.includes('복권')||c.name.toLowerCase().includes('lottery')));
    if(channel) return channel;
  }
  return null;
}

// ===== 복권 결과 계산 & 발표 =====
async function drawLotteryAndAnnounce(client, db, updateBalance, manual=false, interaction=null){
  const today=new Date().toISOString().split('T')[0];
  const tickets = await safeDBAll('SELECT * FROM lottery_tickets WHERE draw_date=?', today);
  if(!tickets.length){
    const msg='📭 오늘은 구매한 복권이 없습니다.';
    if(manual && interaction) return interaction.reply(msg);
    console.log(msg); return;
  }
  const available=Array.from({length:45},(_,i)=>i+1); const winning=[];
  for(let i=0;i<6;i++){ const idx=Math.floor(Math.random()*available.length); winning.push(available.splice(idx,1)[0]); }
  winning.sort((a,b)=>a-b);

  const results=[];
  for(const ticket of tickets){
    const nums=ticket.numbers.split(',').map(n=>parseInt(n.trim()));
    const matches=nums.filter(n=>winning.includes(n)).length;
    const reward=matches===6?5000:0;
    if(reward>0) await updateBalance(ticket.user_id,reward,`복권 ${matches}개 일치 보상`);
    let displayName=ticket.user_id;
    for(const guild of client.guilds.cache.values()){
      try{ const member=await guild.members.fetch(ticket.user_id); if(member){ displayName=member.displayName??member.user.username; break; } }catch{}
    }
    if(reward>0) results.push(`${displayName} ➜ ${matches}개 일치 🎉 (${reward}코인)`);
  }

  const resultText=[
    '🎰 **오늘의 복권 당첨 결과** 🎰',
    `📅 날짜: ${today}`,
    `🏆 당첨번호: **${winning.join(', ')}**`,
    '',
    results.length?results.join('\n'):'😢 이번 회차에는 당첨자가 없습니다.'
  ].join('\n');

  if(manual && interaction) return interaction.reply(resultText);
  const channel = await findLotteryChannel(client);
  if(channel) await channel.send(resultText);
  else console.warn('⚠️ 복권 결과 채널 없음');
}

// ===== 매일 오후 9시 자동 발표 =====
cron.schedule('0 21 * * *', async()=>{
  try{ await drawLotteryAndAnnounce(client, db, updateBalance); }catch(err){ console.error('💥 Cron 자동 발표 에러:', err); }
},{ timezone:'Asia/Seoul' });

// ===== 명령어 정의 =====
const baseCommands=[
  new SlashCommandBuilder().setName('돈줘').setDescription('하루에 한 번 기본금을 받습니다.'),
  new SlashCommandBuilder().setName('잔고').setDescription('현재 잔고를 확인합니다.'),
  new SlashCommandBuilder().setName('골라').setDescription('옵션 중 하나 선택').addStringOption(opt=>opt.setName('옵션들').setDescription('쉼표로 구분').setRequired(true)),
  new SlashCommandBuilder().setName('슬롯').setDescription('슬롯머신').addIntegerOption(opt=>opt.setName('베팅').setDescription('베팅 금액')),
  new SlashCommandBuilder().setName('복권구매').setDescription('복권 구매').addStringOption(opt=>opt.setName('번호').setDescription('예: 1,2,3,4,5,6')),
  new SlashCommandBuilder().setName('복권상태').setDescription('오늘 구매 상태 확인'),
  new SlashCommandBuilder().setName('복권결과').setDescription('오늘 복권 결과 발표'),
  new SlashCommandBuilder().setName('경마').setDescription('경마 진행').addIntegerOption(opt=>opt.setName('베팅').setDescription('금액').setRequired(true)).addIntegerOption(opt=>opt.setName('말번호').setDescription('1~7 선택').setRequired(true)),
  new SlashCommandBuilder().setName('관리자지급').setDescription('관리자 포인트 지급').addUserOption(opt=>opt.setName('대상').setRequired(true)).addIntegerOption(opt=>opt.setName('금액').setRequired(true)),
  new SlashCommandBuilder().setName('블랙잭').setDescription('블랙잭 플레이').addIntegerOption(opt=>opt.setName('베팅').setRequired(true)),
  new SlashCommandBuilder().setName('바카라').setDescription('바카라 플레이').addIntegerOption(opt=>opt.setName('베팅').setRequired(true)).addStringOption(opt=>opt.setName('선택').setRequired(true).setDescription('플레이어/뱅커/타이')),
];

// ===== 명령어 등록 =====
const rest = new REST({version:'10'}).setToken(TOKEN);
(async()=>{
  try{ await rest.put(Routes.applicationCommands(CLIENT_ID), {body: baseCommands.map(c=>c.toJSON())}); console.log('✅ 글로벌 명령어 등록 완료'); }
  catch(err){ console.error('⚠️ 명령어 등록 실패:',err); }
})();

// ===== Discord interaction 처리 =====
client.on('interactionCreate', async(interaction)=>{
  if(!interaction.isChatInputCommand()) return;
  const {commandName,user,options}=interaction;
  const userData=await getUser(user.id);

  try{
    // ----- 돈줘 -----
    if(commandName==='돈줘'){
      const now=Date.now();
      if(now-userData.last_claim<86400000) return interaction.reply({content:'⏰ 이미 오늘 받았습니다.',ephemeral:true});
      await safeDBRun('UPDATE users SET last_claim=? WHERE id=?',now,user.id);
      const newBal=await updateBalance(user.id,1000,'기본금 지급');
      return interaction.reply(`💸 기본금 1000원 지급. 현재 잔고: ${newBal}원`);
    }

    // ----- 잔고 -----
    if(commandName==='잔고') return interaction.reply(`💰 ${user.username}님의 잔고: ${userData.balance}원`);

    // ----- 골라 -----
    if(commandName==='골라'){
      const opts=options.getString('옵션들').split(',').map(x=>x.trim()).filter(Boolean);
      if(opts.length<2) return interaction.reply('⚠️ 2개 이상 입력해주세요.');
      const choice=opts[Math.floor(Math.random()*opts.length)];
      return interaction.reply(`🎯 선택된 항목: **${choice}**`);
    }

    // ----- 슬롯 -----
    if(commandName==='슬롯'){
      const bet=options.getInteger('베팅')??100;
      if(bet<=0 || bet>userData.balance) return interaction.reply('❌ 베팅 금액 오류');
      await updateBalance(user.id,-bet,'슬롯 베팅');
      const result=spinSlot(); let reward=0, penaltyText='';
      const uniqueSymbols=new Set(result);
      if(uniqueSymbols.size===1) reward=bet*10;
      else if(uniqueSymbols.size===2) reward=bet*2;
      const cherryCount=result.filter(s=>'🍒'===s).length;
      if(cherryCount===2){ reward-=500; penaltyText='💥 체리 2개! 500코인 차감!'; }
      else if(cherryCount===3){ reward-=2000; penaltyText='💀 체리 3개! 2000코인 차감!'; }
      if(reward!==0) await updateBalance(user.id,reward,'슬롯 결과');
      const balance=(await getUser(user.id)).balance;
      return interaction.reply({content:`🎰 ${result.join(' | ')}\n${reward>0?`🎉 +${reward}`:reward<0?`💸 ${reward}`:'꽝...'}${penaltyText?`\n${penaltyText}`:''}\n💰 잔고: ${balance}`});
    }

    // ----- 복권구매 -----
    if(commandName==='복권구매'){
      let nums; const input=options.getString('번호');
      if(input){ nums=input.split(',').map(n=>parseInt(n.trim())); if(nums.length!==6||nums.some(n=>isNaN(n)||n<1||n>45)) return interaction.reply('⚠️ 번호는 1~45 사이 6개'); }
      else{ const available=Array.from({length:45},(_,i)=>i+1); nums=[]; for(let i=0;i<6;i++){ const idx=Math.floor(Math.random()*available.length); nums.push(available.splice(idx,1)[0]); } nums.sort((a,b)=>a-b);}
      const today=new Date().toISOString().split('T')[0];
      if(await safeDBGet('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id,today)) return interaction.reply('🎟️ 이미 구매했습니다.');
      if(userData.balance<1000) return interaction.reply('💸 잔고 부족 (1000 필요)');
      await updateBalance(user.id,-1000,'복권 구매');
      await safeDBRun('INSERT INTO lottery_tickets(user_id,numbers,draw_date) VALUES(?,?,?)',user.id,nums.join(','),today);
      return interaction.reply(`🎟️ 복권 구매 완료!\n번호: ${nums.join(',')}`);
    }

    // ----- 복권상태 -----
    if(commandName==='복권상태'){
      const today=new Date().toISOString().split('T')[0];
      const ticket=await safeDBGet('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      return interaction.reply(ticket?`🎟️ 오늘 구매 번호: ${ticket.numbers}`:'❌ 오늘 구매하지 않음');
    }

    // ----- 복권결과 -----
    if(commandName==='복권결과') return drawLotteryAndAnnounce(client, db, updateBalance, true, interaction);

    // ----- 관리자지급 -----
    if(commandName==='관리자지급'){
      if(!ADMIN_IDS.includes(user.id)) return interaction.reply('❌ 관리자만 사용 가능');
      const target=options.getUser('대상'); const amt=options.getInteger('금액');
      const newBal=await updateBalance(target.id,amt,'관리자 지급');
      return interaction.reply(`✅ ${target.username}에게 ${amt}원 지급 (잔고: ${newBal})`);
    }

    // ----- 경마 -----
    if(commandName==='경마'){
      const bet=options.getInteger('베팅'); const horseNum=options.getInteger('말번호');
      if(bet<=0||bet>userData.balance) return interaction.reply('💸 베팅 금액 오류');
      if(horseNum<1 || horseNum>horses.length) return interaction.reply('❌ 말 번호 오류');
      await updateBalance(user.id,-bet,'경마 베팅');
      const bettors=new Map([[user.id,{bet,horseIndex:horseNum-1}]]);
      return startRace(interaction.channel,bettors);
    }

    // ----- 블랙잭 -----
    if(commandName==='블랙잭'){
      const bet=options.getInteger('베팅');
      if(bet<=0||bet>userData.balance) return interaction.reply('💸 베팅 금액 오류');
      await updateBalance(user.id,-bet,'블랙잭 베팅');
      return startBlackjack(interaction,bet);
    }

    // ----- 바카라 -----
    if(commandName==='바카라'){
      const bet=options.getInteger('베팅'); const choice=options.getString('선택');
      if(bet<=0||bet>userData.balance) return interaction.reply('💸 베팅 금액 오류');
      const side=choice==='플레이어'?'플레이어':choice==='뱅커'?'뱅커':'타이';
      await updateBalance(user.id,-bet,'바카라 베팅');
      return startBaccarat(interaction,bet,side);
    }

  } catch(err){
    console.error('❌ 인터랙션 오류:',err);
    try{ if(!interaction.replied) interaction.reply('⚠️ 명령어 처리 중 오류'); }catch{}
  }
});

// ===== 경마 함수 =====
async function startRace(channel,bettors){
  let positions=Array(horses.length).fill(0);
  const trackLength=30;
  const msg=await channel.send('🏁 경주 시작! 잠시만 기다려주세요...');
  return new Promise(resolve=>{
    let finished=false;
    const interval=setInterval(async()=>{
      for(let i=0;i<horses.length;i++){ positions[i]+=Math.floor(Math.random()*3); if(positions[i]>trackLength) positions[i]=trackLength; }
      const raceMsg=positions.map((p,i)=>`${horses[i].emoji} ${horses[i].name.padEnd(8,' ')} |${'·'.repeat(p)}${' '.repeat(trackLength-p)}🏁`).join('\n');
      try{ await msg.edit(`🏇 경주 중...\n\n${raceMsg}`); }catch{}
      const winnerIdx=positions.findIndex(p=>p>=trackLength);
      if(winnerIdx!==-1){
        finished=true; clearInterval(interval);
        for(const [uid,b] of bettors.entries()){ if(b.horseIndex===winnerIdx) await updateBalance(uid,Number(b.bet)*RACE_PAYOUT_MULTIPLIER,'경마 승리'); }
        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} ${horses[winnerIdx].emoji}`);
        resolve(winnerIdx);
      }
    },1000);
    setTimeout(()=>{ if(!finished){ clearInterval(interval); msg.reply('⏱ 경주 시간초과 종료'); resolve(null); } },40000);
  });
}

// ===== 블랙잭 =====
async function startBlackjack(interaction, bet){
  const deck=createDeck();
  const playerHand=[drawCard(deck),drawCard(deck)];
  const dealerHand=[drawCard(deck),drawCard(deck)];
  const msg=await interaction.reply({content:`🃏 블랙잭 시작!\n플레이어: ${playerHand.map(c=>`${c.suit}${c.rank}`).join(' ')}\n딜러: ${dealerHand[0].suit}${dealerHand[0].rank} ❓`,
    components:[new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hit').setLabel('히트').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('stand').setLabel('스탠드').setStyle(ButtonStyle.Danger)
    )],
    fetchReply:true
  });
  const collector=msg.createMessageComponentCollector({time:60000});
  collector.on('collect', async i=>{
    if(i.user.id!==interaction.user.id) return i.reply({content:'❌ 당신의 버튼이 아닙니다.',ephemeral:true});
    if(i.customId==='hit'){
      playerHand.push(drawCard(deck));
      const val=calcHandValue(playerHand);
      if(val>21){ collector.stop('bust'); await i.update({content:`💀 버스트! 패배!\n플레이어: ${playerHand.map(c=>`${c.suit}${c.rank}`).join(' ')}\n딜러: ${dealerHand.map(c=>`${c.suit}${c.rank}`).join(' ')} (${calcHandValue(dealerHand)})`,components:[]}); return; }
      await i.update({content:`🃏 블랙잭 진행중\n플레이어: ${playerHand.map(c=>`${c.suit}${c.rank}`).join(' ')}\n딜러: ${dealerHand[0].suit}${dealerHand[0].rank} ❓`});
    }else if(i.customId==='stand'){
      let dealerVal=calcHandValue(dealerHand);
      while(dealerVal<17){ dealerHand.push(drawCard(deck)); dealerVal=calcHandValue(dealerHand); }
      const playerVal=calcHandValue(playerHand);
      let resultText='';
      if(dealerVal>21||playerVal>dealerVal){ await updateBalance(interaction.user.id,bet*2,'블랙잭 승리'); resultText=`🎉 승리! +${bet}`; }
      else if(playerVal===dealerVal){ await updateBalance(interaction.user.id,bet,'블랙잭 무승부'); resultText='🤝 무승부'; }
      else resultText=`💀 패배! -${bet}`;
      collector.stop();
      await i.update({content:`🃏 블랙잭 결과\n딜러: ${dealerHand.map(c=>`${c.suit}${c.rank}`).join(' ')} (${dealerVal})\n플레이어: ${playerHand.map(c=>`${c.suit}${c.rank}`).join(' ')} (${playerVal})\n${resultText}`,components:[]});
    }
  });
}

// ===== 바카라 =====
async function startBaccarat(interaction, bet, choice){
  const deck=createDeck(); const player=[drawCard(deck),drawCard(deck)]; const banker=[drawCard(deck),drawCard(deck)];
  const pVal=baccaratValue(player), bVal=baccaratValue(banker);
  let winSide=pVal>bVal?'플레이어':pVal<bVal?'뱅커':'타이';
  let payout=0,result='';
  if(choice===winSide){ payout=winSide==='플레이어'?bet*2:winSide==='뱅커'?Math.floor(bet*1.95):bet*8; await updateBalance(interaction.user.id,payout,'바카라 승리'); result=`🎉 ${winSide} 승리! +${payout}코인`; }
  else result=`💀 ${winSide} 승리... 선택(${choice}) 패배`;
  await interaction.reply(`🎴 바카라 결과\n플레이어: ${player.map(c=>`${c.suit}${c.rank}`).join(' ')} (${pVal})\n뱅커: ${banker.map(c=>`${c.suit}${c.rank}`).join(' ')} (${bVal})\n${result}`);
}

// ===== 절대 안꺼지게 (가벼운 루프 유지) =====
setInterval(()=>{},60*1000);

// ===== Discord 로그인 자동 재시도 =====
async function loginBot(){
  try{ await client.login(TOKEN); console.log(`🤖 로그인 성공: ${client.user.tag}`); }
  catch(err){ console.error('💥 로그인 실패. 5초 후 재시도:',err); setTimeout(loginBot,5000); }
}

// ===== 시작 =====
initDB().then(()=>loginBot()).catch(e=>console.error('DB 초기화 실패:',e));
client.once('ready',()=>console.log(`🤖 로그인됨: ${client.user.tag}`));
