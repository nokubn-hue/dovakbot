// casinoGames_manual.js
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getUser, updateBalance } = require('./db.js');

// ===== 카드/핸드 관련 =====
function createDeck() {
  const suits=['♠','♥','♦','♣'], ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck=[]; for(const s of suits) for(const r of ranks) deck.push({rank:r,suit:s});
  for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
function cardValue(c){ if(['J','Q','K'].includes(c.rank)) return 10; if(c.rank==='A') return 11; return parseInt(c.rank,10);}
function calcHandValue(h){ let v=h.reduce((sum,c)=>sum+cardValue(c),0); let ac=h.filter(c=>c.rank==='A').length; while(v>21&&ac>0){v-=10;ac--;} return v; }

// ===== 블랙잭 수동 =====
async function runBlackjackManual(interaction){
  if(!interaction.isChatInputCommand()||interaction.commandName!=='블랙잭') return;
  const user=interaction.user, options=interaction.options;
  const userData=await getUser(user.id);
  const bet=options.getInteger('베팅');
  const memberName = interaction.member ? interaction.member.displayName : user.username;

  if(!bet||bet<=0||bet>userData.balance) return interaction.reply('❌ 베팅 금액 오류.');
  await updateBalance(user.id,-bet,'블랙잭 베팅');

  const deck=createDeck(), playerHand=[], dealerHand=[];
  let finished=false, reward=0;

  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('player_hit').setLabel('플레이어 Hit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('player_stand').setLabel('플레이어 Stand').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dealer_hit').setLabel('딜러 Hit').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('dealer_stand').setLabel('딜러 Stand').setStyle(ButtonStyle.Secondary)
  );

  const buildEmbed=()=>new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle('🃏 블랙잭 수동 진행')
    .setDescription(`👤 **${memberName}님** vs 딜러\n\n**플레이어:** ${playerHand.map(c=>`${c.rank}${c.suit}`).join(' ')} (${calcHandValue(playerHand)})\n**딜러:** ${dealerHand.map(c=>`${c.rank}${c.suit}`).join(' ')} (${calcHandValue(dealerHand)})\n\n👉 버튼으로 플레이어와 딜러를 직접 진행하세요.`);

  const msg=await interaction.reply({ embeds:[buildEmbed()], components:[row], fetchReply:true });

  const collector=msg.createMessageComponentCollector({ filter:i=>i.user.id===user.id, time:120000 });
  collector.on('collect', async i=>{
    if(i.customId==='player_hit'){ playerHand.push(deck.pop()); if(calcHandValue(playerHand)>21){ finished=true; await i.update({ embeds:[buildEmbed().setTitle('💀 플레이어 버스트!')], components:[] }); collector.stop(); return;} await i.update({ embeds:[buildEmbed()] }); }
    if(i.customId==='player_stand'){ await i.update({ content:'플레이어 Stand. 딜러 진행하세요.', embeds:[buildEmbed()] }); }
    if(i.customId==='dealer_hit'){ dealerHand.push(deck.pop()); if(calcHandValue(dealerHand)>21){ finished=true; reward=bet*2; await updateBalance(user.id,reward,'블랙잭 승리'); await i.update({ embeds:[buildEmbed().setTitle('🎉 딜러 버스트! 플레이어 승리')], components:[] }); collector.stop(); return;} await i.update({ embeds:[buildEmbed()] }); }
    if(i.customId==='dealer_stand'){ finished=true; const pVal=calcHandValue(playerHand), dVal=calcHandValue(dealerHand); let result; if(dVal>21||pVal>dVal){ reward=bet*2; result='🎉 플레이어 승리!';} else if(pVal===dVal){ reward=bet; result='⚖️ 무승부';} else result='😢 딜러 승리'; if(reward>0) await updateBalance(user.id,reward,'블랙잭 결과'); const balance=(await getUser(user.id)).balance; await i.update({ embeds:[buildEmbed().setTitle('🃏 블랙잭 결과').setDescription(`${result}\n💰 현재 잔고: ${balance}원`)], components:[] }); collector.stop();}
  });
  collector.on('end', async ()=>{ if(!finished
