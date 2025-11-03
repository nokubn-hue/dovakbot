import { getUser, updateBalance, canClaimDaily, updateClaim } from './db.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { startRace } from './race.js';
import { drawLotteryAndAnnounce } from './lottery.js';

export async function handleOtherCommands(interaction, client) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  const userData = await getUser(user.id);

  // 🧩 유저 데이터 유효성 검사
  if (!userData || typeof userData.balance !== 'number') {
    console.error(`⚠️ 유저 데이터 오류: ${user.id}`);
    await interaction.reply({ content: '⚠️ 유저 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.', flags: 64 });
    return;
  }


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

  switch (commandName) {
    case '잔고': {
      await interaction.reply({
        content: `💰 ${user.globalName || user.username}님의 잔고: ${userData.balance.toLocaleString()}원`,
        flags: 64,
      });
      break;
    }

    case '돈줘': {
      if (!(await canClaimDaily(user.id))) {
        await interaction.reply({ content: '⏰ 이미 오늘의 기본금을 받았습니다. 내일 다시 시도해주세요.', flags: 64 });
        return;
      }

      const reward = 1000;
      const newBalance = await updateBalance(user.id, reward, '일일 기본금');
      await updateClaim(user.id);

      await interaction.reply({
        content: `💸 오늘의 기본금 ${reward.toLocaleString()}원을 받았습니다!\n현재 잔고: ${newBalance.toLocaleString()}원`,
        flags: 64,
      });
      break;
    }

    case '복권구매': {
      await interaction.deferReply({ flags: 64 });
      await drawLotteryAndAnnounce(client, interaction);
      break;
    }

    case '블랙잭': {
      const bet = interaction.options.getInteger('베팅');
      await runBlackjackManual(interaction, userData, bet);
      break;
    }

    case '바카라': {
      const bet = interaction.options.getInteger('베팅');
      const choice = interaction.options.getString('선택');
      await runBaccaratManual(interaction, userData, bet, choice);
      break;
    }

    case '경마': {
      const bet = interaction.options.getInteger('베팅');
      const horseNum = interaction.options.getInteger('말번호');
      await startRace(interaction, userData, bet, horseNum);
      break;
    }

    default:
      await interaction.reply({ content: '❓ 알 수 없는 명령어입니다.', flags: 64 });
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

