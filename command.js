// ===== commands.js =====
import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

// ===== 환경 변수 =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ===== 기본 명령어 정의 =====
export const baseCommands = [
  new SlashCommandBuilder()
    .setName('돈줘')
    .setDescription('하루에 한 번 기본금을 받습니다.'),
  
  new SlashCommandBuilder()
    .setName('잔고')
    .setDescription('현재 잔고를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('골라')
    .setDescription('여러 옵션 중 하나를 무작위로 선택합니다.')
    .addStringOption(opt =>
      opt.setName('옵션들')
        .setDescription('쉼표로 구분된 옵션')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('슬롯머신을 돌립니다.')
    .addIntegerOption(opt =>
      opt.setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('복권구매')
    .setDescription('복권을 무료로 구매합니다. (1일 1회)')
    .addStringOption(opt =>
      opt.setName('번호')
        .setDescription('자동 생성 가능')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('복권상태')
    .setDescription('오늘의 복권 구매 상태를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('복권결과')
    .setDescription('오늘의 복권 결과를 발표합니다.'),

  new SlashCommandBuilder()
    .setName('경마')
    .setDescription('랜덤 경마를 진행합니다.')
    .addIntegerOption(opt =>
      opt.setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('말번호')
        .setDescription('1~7 중 하나 선택')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('관리자지급')
    .setDescription('관리자가 유저에게 포인트를 지급합니다.')
    .addUserOption(opt =>
      opt.setName('대상')
        .setDescription('유저 선택')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('금액')
        .setDescription('지급할 금액')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('블랙잭을 플레이합니다.')
    .addIntegerOption(opt =>
      opt.setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('바카라')
    .setDescription('바카라를 플레이합니다.')
    .addIntegerOption(opt =>
      opt.setName('베팅')
        .setDescription('베팅 금액')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('선택')
        .setDescription('플레이어 / 뱅커 / 타이')
        .setRequired(true)
    ),
];

// ===== 명령어 등록 함수 =====
export async function registerCommands() {
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error('💥 DISCORD_TOKEN, CLIENT_ID, GUILD_ID 중 하나가 설정되지 않았습니다.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('🔹 슬래시 명령어 등록 시작...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: baseCommands.map(cmd => cmd.toJSON()) }
    );
    console.log('✅ 슬래시 명령어 등록 완료');
  } catch (err) {
    console.error('💥 명령어 등록 에러:', err);
  }
}
