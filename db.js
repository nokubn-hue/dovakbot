// 📁 src/db.js
import fs from 'fs';
const filePath = './data/userData.json';

// 파일에서 유저 정보 읽기
export async function getUser(userId) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    data = {};
  }

  // 유저 정보가 없으면 기본값 생성
  if (!data[userId]) {
    data[userId] = { balance: 10000 }; // 기본 잔고 1만 원
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  return data[userId];
}

// 잔고 업데이트
export async function updateBalance(userId, amount, reason = '') {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    data = {};
  }

  if (!data[userId]) data[userId] = { balance: 10000 };

  data[userId].balance += amount;
  if (data[userId].balance < 0) data[userId].balance = 0;

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  console.log(`💰 [${reason}] ${userId}: ${amount > 0 ? '+' : ''}${amount}원`);
  return data[userId];
}
