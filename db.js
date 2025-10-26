// db.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname 정의 (ESM에서 필요)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, 'userData.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export async function getUser(userId) {
  const data = loadData();
  if (!data[userId]) data[userId] = { balance: 10000 };
  saveData(data);
  return data[userId];
}

export async function updateBalance(userId, amount, reason = '') {
  const data = loadData();
  if (!data[userId]) data[userId] = { balance: 10000 };
  data[userId].balance += amount;
  if (data[userId].balance < 0) data[userId].balance = 0;
  saveData(data);
  console.log(`💰 [${reason}] ${userId}: ${amount > 0 ? '+' : ''}${amount}원`);
  return data[userId];
}
