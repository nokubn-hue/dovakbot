// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

export async function initDB() {
  db = await open({
    filename: './casino.db',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount INTEGER,
      reason TEXT,
      timestamp INTEGER
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      numbers TEXT,
      draw_date TEXT
    );
  `);

  console.log('✅ DB 초기화 완료');
}

export { db };

export async function safeDBRun(query, ...params) {
  try {
    return await db.run(query, ...params);
  } catch (err) {
    console.error('💥 DB 실행 에러:', err);
  }
}

export async function safeDBGet(query, ...params) {
  try {
    return await db.get(query, ...params);
  } catch (err) {
    console.error('💥 DB 조회 에러:', err);
  }
}

export async function safeDBAll(query, ...params) {
  try {
    return await db.all(query, ...params);
  } catch (err) {
    console.error('💥 DB 전체 조회 에러:', err);
  }
}

export async function getUser(id) {
  let user = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    await db.run('INSERT INTO users (id, balance) VALUES (?, ?)', id, 1000);
    user = { id, balance: 1000, last_claim: 0 };
  }
  return user;
}

export async function updateBalance(userId, amount, reason) {
  await db.run('BEGIN TRANSACTION');
  try {
    const user = await getUser(userId);
    const newBalance = Math.max(0, user.balance + amount);
    await db.run('UPDATE users SET balance = ? WHERE id = ?', newBalance, userId);
    await db.run(
      'INSERT INTO transactions (user_id, amount, reason, timestamp) VALUES (?, ?, ?, ?)',
      userId,
      amount,
      reason,
      Date.now()
    );
    await db.run('COMMIT');
    return newBalance;
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('💥 Balance update error:', err);
    throw err;
  }
}
