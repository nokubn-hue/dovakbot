// commands/lotteryBuy.js
import { SlashCommandBuilder } from 'discord.js';

export const command = new SlashCommandBuilder()
  .setName('복권구매')
  .setDescription('복권을 구매합니다. 번호를 입력하지 않으면 자동으로 생성됩니다.')
  .addStringOption(option =>
    option.setName('번호')
      .setDescription('복권 번호를 쉼표로 구분해 입력 (예: 1,2,3,4,5,6)')
      .setRequired(false));

export async function execute(interaction, db, updateBalance, userData) {
  const user = interaction.user;
  const input = interaction.options.getString('번호');

  let nums;
  if (input) {
    nums = input.split(',').map(n => parseInt(n.trim()));
    if (nums.length !== 6 || nums.some(n => isNaN(n) || n < 1 || n > 45)) {
      return interaction.reply('⚠️ 번호는 1~45 사이의 숫자 6개를 쉼표로 구분해 입력하세요. (예: 3,7,12,22,34,45)');
    }
  } else {
    const available = Array.from({ length: 45 }, (_, i) => i + 1);
    nums = [];
    for (let i = 0; i < 6; i++) {
      const randIndex = Math.floor(Math.random() * available.length);
      nums.push(available.splice(randIndex, 1)[0]);
    }
    nums.sort((a, b) => a - b);
  }

  const today = new Date().toISOString().split('T')[0];
  const exist = await db.get('SELECT * FROM lottery_tickets WHERE user_id = ? AND draw_date = ?', user.id, today);
  if (exist) return interaction.reply('🎟️ 이미 오늘 복권을 구매했습니다.');
  if (userData.balance < 100) return interaction.reply('💸 잔고가 부족합니다. (필요 금액: 100)');

  await updateBalance(user.id, -100, '복권 구매');
  await db.run('INSERT INTO lottery_tickets(user_id, numbers, draw_date) VALUES(?, ?, ?)', user.id, nums.join(','), today);

  return interaction.reply(`🎟️ 복권 구매 완료!\n번호: ${nums.join(', ')}`);
}
