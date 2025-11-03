// commandsHandler.js
import { getUser, updateBalance, canClaimDaily, updateClaim, safeDBRun } from './db.js';
import { runBlackjackManual, runBaccaratManual } from './casinoGames_manual.js';
import { drawLotteryAndAnnounce } from './lottery.js';

// ===== 경마 관련 =====
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

// 경마 게임 함수
export async function runRace(channel, bettors) {
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
        .map((p, i) => `|${'·'.repeat(p)}${horses[i].emoji} ${horses[i].name}${'·'.repeat(trackLength - p)}🏁`)
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

// ==========================
// 명령어 처리
// ==========================
export async function handleCommands(interaction, client) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, options, channel } = interaction;
  const userData = await getUser(user.id);

  // 🧩 유저 데이터 유효성 체크
  if (!userData || typeof userData.balance !== 'number') {
    console.error(`⚠️ 유저 데이터 오류: ${user.id}`);
    await interaction.reply({ content: '⚠️ 유저 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.', flags: 64 });
    return;
  }

  // ----- 돈줘 / 기본금 -----
  if (commandName === '돈줘') {
    if (!(await canClaimDaily(user.id))) {
      return interaction.reply({ content: '⏰ 이미 오늘의 기본금을 받으셨습니다. 내일 다시 시도해주세요.', flags: 64 });
    }
    const reward = 1000;
    const newBal = await updateBalance(user.id, reward, '일일 기본금');
    await updateClaim(user.id);
    return interaction.reply({ content: `💸 오늘의 기본금 ${reward.toLocaleString()}원을 받으셨습니다.\n현재 잔고: ${newBal.toLocaleString()}원`, flags: 64 });
  }

  // ----- 잔고 확인 -----
  if (commandName === '잔고') {
    return interaction.reply({ content: `💰 ${user.globalName || user.username}님의 잔고: ${userData.balance.toLocaleString()}원`, flags: 64 });
  }

  // ----- 복권 -----
  if (commandName === '복권구매') {
    await interaction.deferReply({ flags: 64 });
    await drawLotteryAndAnnounce(client, interaction);
    return;
  }

  // ----- 블랙잭 -----
  if (commandName === '블랙잭') {
    const bet = options.getInteger('베팅');
    await runBlackjackManual(interaction, userData, bet);
    return;
  }

  // ----- 바카라 -----
  if (commandName === '바카라') {
    const bet = options.getInteger('베팅');
    const choice = options.getString('선택');
    await runBaccaratManual(interaction, userData, bet, choice);
    return;
  }

  // ----- 경마 -----
  if (commandName === '경마') {
    const bet = options.getInteger('베팅');
    const horseNum = options.getInteger('말번호');
    const bettors = new Map();
    bettors.set(user.id, { bet, horseIndex: horseNum - 1 });
    await runRace(channel, bettors);
    return;
  }

  // ----- 슬롯 -----
  if (commandName === '슬롯') {
    const bet = options.getInteger('베팅') ?? 100;
    if (bet <= 0 || bet > userData.balance) return interaction.reply('❌ 베팅 금액 오류.');
    await updateBalance(user.id, -bet, '슬롯 베팅');
    const result = spinSlot(); // spinSlot 함수는 기존 그대로 유지

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

  // ----- 알 수 없는 명령어 -----
  return interaction.reply({ content: '❓ 알 수 없는 명령어입니다.', flags: 64 });
}
