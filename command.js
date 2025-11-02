import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

export const commands = [
  new SlashCommandBuilder().setName('돈줘').setDescription('하루 한 번 기본금을 받습니다.'),
  new SlashCommandBuilder().setName('잔고').setDescription('현재 잔고 확인'),
  new SlashCommandBuilder().setName('슬롯').setDescription('슬롯머신 플레이')
    .addIntegerOption(opt => opt.setName('베팅').setDescription('베팅 금액').setRequired(false)),
  new SlashCommandBuilder().setName('복권구매').setDescription('복권을 구매합니다.'),
  new SlashCommandBuilder().setName('복권상태').setDescription('오늘의 복권 상태 확인'),
  new SlashCommandBuilder().setName('복권결과').setDescription('오늘의 복권 결과 발표 (관리자 전용)'),
  new SlashCommandBuilder().setName('경마').setDescription('경마를 플레이합니다.')
    .addIntegerOption(o => o.setName('베팅').setRequired(true))
    .addIntegerOption(o => o.setName('말번호').setRequired(true)),
  new SlashCommandBuilder().setName('블랙잭').setDescription('블랙잭 게임'),
  new SlashCommandBuilder().setName('바카라').setDescription('바카라 게임'),
  new SlashCommandBuilder().setName('관리자지급').setDescription('관리자 지급')
    .addUserOption(o => o.setName('대상').setRequired(true))
    .addIntegerOption(o => o.setName('금액').setRequired(true)),
];

export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
    body: commands.map(c => c.toJSON()),
  });
  console.log('✅ 명령어 등록 완료');
}
