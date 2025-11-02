// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

// ===== DB 초기화 =====
export async function initDB() {
  db = await open({
    filename: './database.sqlite',
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

  console.log('✅ 데이터베이스 초기화 완료');
}

// ===== 안전한 쿼리 실행 =====
export async function safeDBRun(sql, params = []) {
  try {
    return await db.run(sql, params);
  } catch (err) {
    console.error('❌ DB 오류:', err);
    throw err;
  }
}

// ===== 유저 조회 =====
export async function getUser(id) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) {
    await db.run('INSERT INTO users (id, balance) VALUES (?, ?)', [id, 1000]);
    return { id, balance: 1000, last_claim: 0 };
  }
  return user;
}

// ===== 잔고 업데이트 =====
export async function updateBalance(id, amount, reason = '기타') {
  const user = await getUser(id);
  const newBalance = user.balance + amount;
  await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, id]);
  await db.run(
    'INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?, ?, ?, ?)',
    [id, amount, reason, Date.now()]
  );
  return newBalance;
}
