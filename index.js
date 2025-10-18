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
const guilds = process.env.GUILD_IDS?.split(',') || [];
for (const guildId of guilds) {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: baseCommands });
}

const ADMIN_IDS = process.env.ADMIN_USER_IDS?.split(',') || [];

const app = express();
app.get('/', (_, res) => res.send('봇 실행 중'));
app.listen(3000, () => console.log('✅ 서버 실행됨'));

// ----- 클라이언트 초기화 -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
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
  console.log('✅ DB 초기화 완료');
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

// ----- 슬롯머신 -----
function spinSlot() {
  const symbols = ['🍒', '🍋', '🍇', '💎', '7️⃣'];
  return [0,1,2].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
}

// ----- 골라 -----
function pickRandomOption(raw, count = 1) {
  const parts = raw.split(/\s*,\s*|\s+or\s+|\s+\/\s+|\r?\n/).map(s => s.trim()).filter(Boolean);
  if(parts.length === 0) return null;
  if(count > parts.length) count = parts.length;
  return parts.sort(()=>Math.random()-0.5).slice(0,count);
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

// ----- 경마 -----
const horses = [
  { name:"썬더", emoji:"🐎" },
  { name:"스피드", emoji:"🐎" },
  { name:"라이트닝", emoji:"🐎" },
  { name:"블레이드", emoji:"🐎" },
  { name:"토네이도", emoji:"🐎" },
  { name:"스타", emoji:"🐎" },
  { name:"썬샤인", emoji:"🐎" }
];
async function startRace(channel, bettors) {
  let positions = Array(horses.length).fill(0);
  const trackLength = 30;
  const msg = await channel.send('🏁 경주 시작! 잠시만 기다려주세요...');
  return new Promise(resolve => {
    let finished = false;
    const interval = setInterval(async () => {
      for(let i=0;i<horses.length;i++){
        positions[i]+=Math.floor(Math.random()*3);
        if(positions[i]>trackLength) positions[i]=trackLength;
      }
      const raceMsg = positions.map((p,i)=>`${horses[i].emoji} ${horses[i].name.padEnd(8," ")} |${"·".repeat(p)}${" ".repeat(trackLength-p)}🏁`).join('\n');
      try { await msg.edit(`🏇 경주 중...\n\n${raceMsg}`); } catch {}
      const winnerIdx = positions.findIndex(p => p>=trackLength);
      if(winnerIdx !== -1){
        finished = true;
        clearInterval(interval);
        for(const [uid,b] of bettors.entries()){
          if(b.horseIndex===winnerIdx){
            const payout = Number(b.bet)*5;
            await updateBalance(uid,payout,'경마 승리');
          }
        }
        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].name} ${horses[winnerIdx].emoji}`);
        resolve(winnerIdx);
      }
    },1000);
    setTimeout(()=>{ if(!finished){ clearInterval(interval); msg.reply('⏱ 경주 시간초과 종료'); resolve(null);} },40000);
  });
}

// ----- 블랙잭 -----
const activeBlackjacks = new Map();
const suits = ["♠️","♥️","♦️","♣️"];
const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function createDeck(){ 
  const deck=[]; for(const s of suits) for(const r of ranks) deck.push({suit:s, rank:r}); 
  for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]];} 
  return deck;
}
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
async function startBlackjack(interaction, bet){
  const deck = createDeck();
  const playerHand = [drawCard(deck), drawCard(deck)];
  const dealerHand = [drawCard(deck), drawCard(deck)];
  activeBlackjacks.set(interaction.user.id,{deck,playerHand,dealerHand,bet});
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hit').setLabel('히트').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('stand').setLabel('스탠드').setStyle(ButtonStyle.Secondary)
  );
  const msg = await interaction.reply({content: renderBlackjack(interaction.user.username,playerHand,dealerHand,false), components:[row], fetchReply:true});
  const collector = msg.createMessageComponentCollector({time:60000});
  collector.on('collect', async btn => {
    if(btn.user.id!==interaction.user.id) return btn.reply({content:'❌ 당신의 게임이 아닙니다.',ephemeral:true});
    const game = activeBlackjacks.get(interaction.user.id);
    if(!game) return;
    if(btn.customId==='hit'){
      game.playerHand.push(drawCard(game.deck));
      const playerVal=calcHandValue(game.playerHand);
      if(playerVal>21){
        collector.stop('bust');
        await btn.update({content: renderBlackjack(interaction.user.username,game.playerHand,game.dealerHand,true,'버스트! 패배'), components:[]});
        await updateBalance(interaction.user.id,-game.bet,'블랙잭 패배');
        activeBlackjacks.delete(interaction.user.id);
        return;
      }
      await btn.update({content: renderBlackjack(interaction.user.username,game.playerHand,game.dealerHand,false), components:[row]});
    } else if(btn.customId==='stand'){ collector.stop('stand'); await dealerTurn(interaction,game);}
  });
  collector.on('end', async (_, reason) => {
    if(reason==='time'){ await interaction.editReply({content:'⏰ 시간 초과로 게임 종료', components:[]}); activeBlackjacks.delete(interaction.user.id);}
  });
}
function renderBlackjack(username, playerHand, dealerHand, revealDealer=false, resultText=null){
  const playerVal=calcHandValue(playerHand);
  const dealerVal=revealDealer?calcHandValue(dealerHand):'?';
  const dealerShow=revealDealer?dealerHand.map(c=>`${c.suit}${c.rank}`).join(' '):`${dealerHand[0].suit}${dealerHand[0].rank} ??`;
  return `🃏 **${username}의 블랙잭**\n딜러: ${dealerShow} (${dealerVal})\n플레이어: ${playerHand.map(c=>`${c.suit}${c.rank}`).join(' ')} (${playerVal})\n${resultText?`\n${resultText}`:''}`;
}
async function dealerTurn(interaction,game){
  while(calcHandValue(game.dealerHand)<17) game.dealerHand.push(drawCard(game.deck));
  const playerVal=calcHandValue(game.playerHand);
  const dealerVal=calcHandValue(game.dealerHand);
  let result='';
  if(dealerVal>21 || playerVal>dealerVal){ result=`🎉 승리! +${game.bet}`; await updateBalance(interaction.user.id, game.bet,'블랙잭 승리');}
  else if(playerVal===dealerVal) result='🤝 무승부! (베팅 반환)';
  else { result='💀 패배!'; await updateBalance(interaction.user.id,-game.bet,'블랙잭 패배');}
  await interaction.editReply({content: renderBlackjack(interaction.user.username, game.playerHand, game.dealerHand,true,result), components:[]});
  activeBlackjacks.delete(interaction.user.id);
}

// ----- 바카라 -----
function baccaratValue(cards){
  return cards.reduce((acc,c)=>{
    if(['J','Q','K','10'].includes(c.rank)) return acc;
    if(c.rank==='A') return acc+1;
    return acc+parseInt(c.rank);
  },0)%10;
}
async function startBaccarat(interaction,bet,side){
  const deck=createDeck();
  const player=[drawCard(deck),drawCard(deck)];
  const banker=[drawCard(deck),drawCard(deck)];
  const playerVal=baccaratValue(player);
  const bankerVal=baccaratValue(banker);
  let winSide='';
  if(playerVal>bankerVal) winSide='플레이어';
  else if(playerVal<bankerVal) winSide='뱅커';
  else winSide='타이';
  let result='';
  if(side===winSide){
    let payout=bet;
    if(side==='플레이어') payout=bet*2;
    else if(side==='뱅커') payout=bet*1.95;
    else payout=bet*8;
    await updateBalance(interaction.user.id,payout-bet,'바카라 승리');
    result=`🎉 ${winSide} 승리! +${Math.floor(payout-bet)}`;
  } else { await updateBalance(interaction.user.id,-bet,'바카라 패배'); result=`💀 ${winSide} 승리... 당신(${side}) 패배`; }
  await interaction.reply(`🎴 **바카라 결과**\n플레이어: ${player.map(c=>`${c.suit}${c.rank}`).join(' ')} (${playerVal})\n뱅커: ${banker.map(c=>`${c.suit}${c.rank}`).join(' ')} (${bankerVal})\n${result}`);
}

// ----- 명령어 등록 -----
const baseCommands=[
  new SlashCommandBuilder().setName('돈줘').setDescription('하루에 한 번 기본금을 받습니다.'),
  new SlashCommandBuilder().setName('잔고').setDescription('현재 잔고 확인'),
  new SlashCommandBuilder().setName('골라').setDescription('옵션 중 랜덤 선택').addStringOption(opt=>opt.setName('옵션들').setDescription('쉼표로 구분').setRequired(true)),
  new SlashCommandBuilder().setName('슬롯').setDescription('슬롯머신 돌리기').addIntegerOption(opt=>opt.setName('베팅').setDescription('베팅 금액')),
  new SlashCommandBuilder().setName('복권구매').setDescription('복권 구매').addStringOption(opt=>opt.setName('번호').setDescription('1~45 중 6개').setRequired(true)),
  new SlashCommandBuilder().setName('복권상태').setDescription('복권 상태 확인'),
  new SlashCommandBuilder().setName('경마').setDescription('경마 배팅').addIntegerOption(opt=>opt.setName('베팅').setDescription('금액').setRequired(true)).addIntegerOption(opt=>opt.setName('말번호').setDescription('1~7 선택').setRequired(true)),
  new SlashCommandBuilder().setName('관리자지급').setDescription('관리자 포인트 지급').addUserOption(opt=>opt.setName('대상').setDescription('유저 선택').setRequired(true)).addIntegerOption(opt=>opt.setName('금액').setDescription('지급 금액').setRequired(true)),
  new SlashCommandBuilder().setName('블랙잭').setDescription('블랙잭 플레이').addIntegerOption(opt=>opt.setName('베팅').setDescription('금액').setRequired(true)),
  new SlashCommandBuilder().setName('바카라').setDescription('바카라 플레이').addIntegerOption(opt=>opt.setName('베팅').setDescription('금액').setRequired(true)).addStringOption(opt=>opt.setName('선택').setDescription('플레이어/뱅커/타이').setRequired(true)),
];

const rest=new REST({version:'10'}).setToken(TOKEN);
(async()=>{try{ await rest.put(Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID),{body:baseCommands}); console.log('✅ 명령어 등록 완료'); } catch(e){console.error(e);} })();

// ----- 인터랙션 -----
client.on('interactionCreate', async interaction=>{
  if(!interaction.isChatInputCommand()) return;
  const {commandName,user,options} = interaction;
  const userData = await getUser(user.id);

  switch(commandName){
    case '돈줘':{
      const now=Date.now();
      if(now-userData.last_claim<86400000) return interaction.reply({content:'⏰ 오늘 이미 받았습니다.', ephemeral:true});
      await db.run('UPDATE users SET last_claim=? WHERE id=?', now, user.id);
      const newBal = await updateBalance(user.id,500,'기본금 지급');
      return interaction.reply(`💸 500원 지급. 현재 잔고: ${newBal}`);
    }
    case '잔고': return interaction.reply(`💰 ${user.username} 잔고: ${userData.balance}원`);
    case '골라':{
      const opts = options.getString('옵션들');
      const pick = pickRandomOption(opts);
      return interaction.reply(`🎯 선택: **${pick[0]}**`);
    }
    case '슬롯':{
      const bet = options.getInteger('베팅') ?? 100;
      if(bet<=0 || bet>userData.balance) return interaction.reply('❌ 베팅 금액 오류');
      await updateBalance(user.id,-bet,'슬롯 베팅');
      const result = spinSlot();
      let reward=0;
      if(new Set(result).size===1) reward=bet*10; else if(new Set(result).size===2) reward=bet*2;
      if(reward>0) await updateBalance(user.id,reward,'슬롯 당첨');
      return interaction.reply(`🎰 ${result.join(' | ')}\n${reward>0?`🎉 +${reward}`:'꽝'}\n💰 잔고: ${(await getUser(user.id)).balance}`);
    }
    case '복권구매':{
      const nums = options.getString('번호').split(',').map(n=>parseInt(n.trim()));
      if(nums.length!==6 || nums.some(n=>n<1||n>45)) return interaction.reply('⚠️ 1~45 중 6개 번호 입력');
      const today = new Date().toISOString().split('T')[0];
      const exist = await db.get('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      if(exist) return interaction.reply('🎫 오늘 이미 구매');
      if(userData.balance<100) return interaction.reply('💸 잔고 부족');
      await updateBalance(user.id,-100,'복권 구매');
      await db.run('INSERT INTO lottery_tickets(user_id,numbers,draw_date) VALUES(?,?,?)', user.id, nums.join(','), today);
      return interaction.reply(`🎟️ 구매 완료: ${nums.join(',')}`);
    }
    case '복권상태':{
      const today = new Date().toISOString().split('T')[0];
      const ticket = await db.get('SELECT * FROM lottery_tickets WHERE user_id=? AND draw_date=?', user.id, today);
      return interaction.reply(ticket?`🎟️ 오늘 번호: ${ticket.numbers}`:'❌ 오늘 복권 없음');
    }
    case '관리자지급':{
      if(!ADMIN_IDS.includes(user.id)) return interaction.reply('❌ 관리자만 가능');
      const target = options.getUser('대상');
      const amt = options.getInteger('금액');
      const newBal = await updateBalance(target.id, amt,'관리자 지급');
      return interaction.reply(`✅ ${target.username}에게 ${amt} 지급 (잔고: ${newBal})`);
    }
    case '경마':{
      const bet = options.getInteger('베팅');
      const num = options.getInteger('말번호')-1;
      if(bet<=0 || bet>userData.balance || num<0 || num>=horses.length) return interaction.reply('💸 베팅/말 번호 오류');
      await updateBalance(user.id,-bet,'경마 베팅');
      const bettors = new Map([[user.id,{bet,horseIndex:num}]]);
      return startRace(interaction.channel, bettors);
    }
    case '블랙잭':{
      const bet = options.getInteger('베팅');
      if(bet<=0||bet>userData.balance) return interaction.reply('💸 베팅 오류');
      await updateBalance(user.id,-bet,'블랙잭 베팅');
      return startBlackjack(interaction,bet);
    }
    case '바카라':{
      const bet = options.getInteger('베팅');
      const choice = options.getString('선택');
      if(bet<=0||bet>userData.balance) return interaction.reply('💸 베팅 오류');
      await updateBalance(user.id,-bet,'바카라 베팅');
      const side = choice==='플레이어'?'플레이어':choice==='뱅커'?'뱅커':'타이';
      return startBaccarat(interaction,bet,side);
    }
  }
});

client.once('ready',()=>console.log(`🤖 로그인됨: ${client.user.tag}`));
initDB().then(()=>client.login(TOKEN));

