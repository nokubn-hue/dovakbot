// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== SQLite DB 초기화 =====
let db;

export async function initDB() {
  db = await open({
    filename: path.join(__dirname, 'data.sqlite'),
    driver: sqlite3.Database,
  });

  // users 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0
    );
  `);

  // transactions 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount INTEGER,
      reason TEXT,
      timestamp INTEGER
    );
  `);

  // lottery_tickets 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      numbers TEXT,
      draw_date TEXT
    );
  `);

  console.log('✅ SQLite DB 초기화 완료');
}

// ===== 안전 DB 실행 함수 =====
export async function safeDBRun(query, ...params) {
  try {
    return await db.run(query, ...params);
  } catch (err) {
    console.error('💥 DB 실행 에러:', query, params, err);
    throw err;
  }
}

export async function safeDBGet(query, ...params) {
  try {
    return await db.get(query, ...params);
  } catch (err) {
    console.error('💥 DB 조회 에러:', query, params, err);
    throw err;
  }
}

export async function safeDBAll(query, ...params) {
  try {
    return await db.all(query, ...params);
  } catch (err) {
    console.error('💥 DB 전체 조회 에러:', query, params, err);
    throw err;
  }
}

// ===== 유틸: 사용자 가져오기/생성 =====
export async function getUser(userId) {
  let user = await safeDBGet('SELECT * FROM users WHERE id = ?', userId);
  if (!user) {
    await safeDBRun('INSERT INTO users (id, balance) VALUES (?, ?)', userId, 1000);
    user = { id: userId, balance: 1000, last_claim: 0 };
  }
  return user;
}

// ===== 유틸: 잔고 업데이트 =====
export async function updateBalance(userId, amount, reason = '') {
  await safeDBRun('BEGIN TRANSACTION');
  try {
    const user = await getUser(userId);
    const newBalance = Math.max(0, user.balance + amount);

    await safeDBRun('UPDATE users SET balance=? WHERE id=?', newBalance, userId);
    await safeDBRun(
      'INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?, ?, ?, ?)',
      userId,
      amount,
      reason,
      Date.now()
    );

    await safeDBRun('COMMIT');
    console.log(`💰 [${reason}] ${userId}: ${amount > 0 ? '+' : ''}${amount}원`);
    return newBalance;
  } catch (err) {
    await safeDBRun('ROLLBACK');
    console.error('💥 Balance 업데이트 에러:', err);
    throw err;
  }
}
