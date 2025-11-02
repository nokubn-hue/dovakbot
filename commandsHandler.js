// handleOtherCommands.js
import { safeDBRun, updateBalance, getUser } from './db.js';
import { drawLotteryAndAnnounce } from './lottery.js';

// ===== 경마 관련 상수 =====
export const RACE_PAYOUT_MULTIPLIER = 5;
export const horses = [
  { name: '실버 쉽', emoji: '🐎' },
  { name: '언내추럴 위크', emoji: '🐎' },
  { name: '루즈 티켓', emoji: '🐎' },
  { name: '나리타 카나', emoji: '🐎' },
  { name: '싱글코어 터보', emoji: '🐎' },
  { name: '로쿠도 캡', emoji: '🐎' },
  { name: '럭키 카구야', emoji: '🐎' },
];
export const activeRaces = new Map();

// -------------------
// 경마 게임 함수
// -------------------
export async function startRace(channel, bettors) {
  let positions = new Array(horses.length).fill(0);
  const msg = await channel.send("🏁 경주 시작! 잠시만 기다려주세요...");

  return new Promise((resolve) => {
    let finished = false;
    const trackLength = 30;

    const interval = setInterval(async () => {
      for (let i = 0; i < horses.length; i++) {
        positions[i] += Math.random() < 0.6 ? 0 : Math.floor(Math.random() * 3);
        if (positions[i] >= trackLength) positions[i] = trackLength;
      }

      const raceMsg = positions
        .map((p, i) => `|${"·".repeat(p)}${horses[i].emoji} ${horses[i].name}${"·".repeat(trackLength - p)}🏁`)
        .join("\n");

      await msg.edit(`🏇 경주 중...\n\n${raceMsg}`);

      const winners = positions.map((p, i) => (p >= trackLength ? i : null)).filter(x => x !== null);
      if (winners.length > 0) {
        finished = true;
        clearInterval(interval);
        const winnerIdx = winners[0];

        for (const [uid, b] of bettors.entries()) {
          if (b.horseIndex === winnerIdx) {
            await updateBalance(uid, b.bet * RACE_PAYOUT_MULTIPLIER, "race_win");
          }
        }

        await channel.send(`🏆 경주 종료! 우승 말: ${horses[winnerIdx].emoji} ${horses[winnerIdx].name} (번호 ${winnerIdx + 1})`);
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
// 명령어 처리
// -------------------
export async function handleOtherCommands(interaction, client, userData) {
  const { commandName, user, options } = interaction;

  // ----- 돈줘 -----
  if (commandName === '돈줘') {
    const now = Date.now();
    if (now - userData.last_claim < 86400000) {
      return interaction.reply({ content: '⏰ 이미 오늘 받았습니다.', ephemeral: true });
    }
    await safeDBRun('UPDATE users SET last_claim=? WHERE id=?', now, user.id);
    const newBal = await updateBalance(user.id, 1000, '기본금 지급');
    return interaction.reply(`💸 기본금 1000원 지급. 현재 잔고: ${newBal}원`);
  }

  // ----- 잔고 -----
  if (commandName === '잔고') {
    const nickname = interaction.member?.displayName || user.username;
    return interaction.reply(`💰 ${nickname}님의 잔고: ${userData.balance}원`);
  }

  // ----- 골라 -----
  if (commandName === '골라') {
    const opts = options.getString('옵션들').split(',').map(x => x.trim()).filter(Boolean);
    if (opts.length < 2) return interaction.reply('⚠️ 2개 이상 입력해주세요.');
    const choice = opts[Math.floor(Math.random() * opts.length)];
    return interaction.reply(`🎯 선택된 항목: **${choice}**`);
  }

  // ----- 슬롯 -----
  if (commandName === '슬롯') {
    const bet = options.getInteger('베팅') ?? 100;
    if (bet <= 0 || bet > userData.balance) return interaction.reply('❌ 베팅 금액 오류.');
    await updateBalance(user.id, -bet, '슬롯 베팅');
    const result = spinSlot();

    let reward = 0, patternText = '', sevenText = '', penaltyText = '';
    const cherryCount = result.filter(s => s === '🍒').length;
    if (cherryCount === 2) { reward -= 500; penaltyText = '💥 체리 2개! 500코인 차감!'; }
    else if (cherryCount === 3) { reward -= 2000; penaltyText = '💀 체리 3개! 2000코인 차감!'; }

    if (!penaltyText) {
      const unique = new Set(result);
      if (unique.size === 1) { reward = bet * 10; patternText = '🎉 세 개 동일 심볼! x10 당첨!'; }
      else if (unique.size === 2) { reward = bet * 2; patternText = '✨ 두 개 동일 심볼! x2 당첨!'; }
      else patternText = '꽝...';

      const sevenCount = result.filter(s => s === '7️⃣').length;
      if (sevenCount === 2) { reward += bet * 5; sevenText = '🔥 7️⃣ 2개! x5배 추가!'; }
      else if (sevenCount === 3) { reward += bet * 20; sevenText = '💥 7️⃣ 3개! x20배 추가!'; }
    }

    if (reward !== 0) await updateBalance(user.id, reward, '슬롯 결과');
    const balance = (await getUser(user.id)).balance;

    return interaction.reply(
      `🎰 슬롯 결과: ${result.join(' | ')}\n` +
      `${patternText}\n${sevenText ? sevenText+'\n':''}${penaltyText ? penaltyText+'\n':''}` +
      `💰 최종 잔고: ${balance}원\n` +
      `${reward > 0 ? `🎉 보상: +${reward}` : reward < 0 ? `💸 손실: ${reward}` : ''}`
    );
  }

}
