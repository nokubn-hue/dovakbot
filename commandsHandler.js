import { getUser, updateBalance, safeDBRun } from './db.js';
import { spinSlot } from './games.js';
import { handleLotteryPurchase } from './lottery.js';
import { handleOtherCommands } from './otherCommands.js';

export async function handleCommand(interaction, client) {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user } = interaction;
  const userData = await getUser(user.id);

  try {
    if (commandName === '돈줘') {
      const now = Date.now();
      if (now - userData.last_claim < 86400000) {
        return interaction.reply('⏰ 오늘은 이미 받으셨습니다.');
      }
      await safeDBRun('UPDATE users SET last_claim=? WHERE id=?', now, user.id);
      const newBal = await updateBalance(user.id, 1000, '기본금 지급');
      return interaction.reply(`💸 1000코인 지급! 현재 잔고 ${newBal}원`);
    }

    if (commandName === '잔고') {
      const name = interaction.member?.displayName || interaction.user.username;
      return interaction.reply(`💰 ${name}님의 잔고: ${userData.balance}원`);
    }

    if (commandName === '슬롯') {
      const bet = interaction.options.getInteger('베팅') ?? 100;
      if (bet <= 0 || bet > userData.balance) return interaction.reply('❌ 베팅 금액 오류');
      await updateBalance(user.id, -bet, '슬롯 베팅');
      const result = spinSlot();
      const same = new Set(result).size === 1;
      const reward = same ? bet * 5 : 0;
      if (reward > 0) await updateBalance(user.id, reward, '슬롯 당첨');
      const balance = (await getUser(user.id)).balance;
      return interaction.reply(`🎰 ${result.join(' | ')} ${same ? '🎉 당첨!' : '꽝...'} (잔고: ${balance})`);
    }

    if (commandName === '복권구매') return handleLotteryPurchase(interaction, userData);
    return handleOtherCommands(interaction, client, userData);
  } catch (err) {
    console.error('명령 처리 오류:', err);
    if (!interaction.replied) interaction.reply('⚠️ 오류 발생');
  }
}
