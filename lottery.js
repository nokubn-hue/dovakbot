import cron from 'node-cron';
import { ChannelType } from 'discord.js';

export async function findLotteryChannel(client) {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name.includes('복권') || c.name.toLowerCase().includes('lottery'))
    );
    if (channel) return channel;
  }
  return null;
}

export async function drawLotteryAndAnnounce(client, db, updateBalance, manual = false, interaction = null) {
  const today = new Date().toISOString().split('T')[0];
  const tickets = await db.all('SELECT * FROM lottery_tickets WHERE draw_date=?', today);

  if (!tickets.length) {
    const msg = '📭 오늘은 구매한 복권이 없습니다.';
    if (manual && interaction) return interaction.reply(msg);
    return console.log(msg);
  }

  const available = Array.from({ length: 40 }, (_, i) => i + 1);
  const winning = [];
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * available.length);
    winning.push(available.splice(idx, 1)[0]);
  }
  winning.sort((a, b) => a - b);

  const results = [];
  for (const ticket of tickets) {
    const nums = ticket.numbers.split(',').map(n => parseInt(n.trim()));
    const matches = nums.filter(n => winning.includes(n)).length;
    const reward = matches === 5 ? 5000 : 0;
    if (reward > 0) {
      await updateBalance(ticket.user_id, reward, `복권 ${matches}개 일치 보상`);

      let displayName = ticket.user_id;
      for (const guild of client.guilds.cache.values()) {
        try {
          const member = await guild.members.fetch(ticket.user_id);
          if (member) {
            displayName = member.displayName ?? member.user.username;
            break;
          }
        } catch {}
      }

      results.push(`${displayName} ➜ ${matches}개 일치 🎉 (${reward}코인)`);
    }
  }

  const resultText = [
    '🎰 **오늘의 복권 당첨 결과** 🎰',
    `📅 날짜: ${today}`,
    `🏆 당첨번호: **${winning.join(', ')}**`,
    '',
    results.length ? results.join('\n') : '😢 이번 회차에는 당첨자가 없습니다.',
  ].join('\n');

  if (manual && interaction) return interaction.reply(resultText);

  const channel = await findLotteryChannel(client);
  if (channel) await channel.send(resultText);
  else console.warn('⚠️ 복권 결과 채널 없음');
}

export function scheduleDailyLottery(client, db, updateBalance) {
  cron.schedule(
    '0 21 * * *',
    async () => {
      try { await drawLotteryAndAnnounce(client, db, updateBalance); }
      catch (err) { console.error('💥 Cron 자동 발표 에러:', err); }
    },
    { timezone: 'Asia/Seoul' }
  );
  console.log('🕘 매일 오후 9시에 자동 복권 발표 스케줄러 등록 완료');
}
