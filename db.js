// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

/**
 * DB 초기화
 */
export async function initDB() {
  db = await open({
    filename: './casino.db',
    driver: sqlite3.Database,
  });

  // ===== users 테이블 =====
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0
    );
  `);

  // last_lottery 컬럼 자동 추가 (없는 경우)
  try {
    const columns = await db.all("PRAGMA table_info(users)");
    const hasLastLottery = columns.some(c => c.name === 'last_lottery');
    if (!hasLastLottery) {
      await db.exec('ALTER TABLE users ADD COLUMN last_lottery INTEGER DEFAULT 0;');
      console.log('✅ users 테이블에 last_lottery 컬럼 추가 완료');
    }
  } catch (err) {
    console.error('⚠️ last_lottery 컬럼 체크 실패:', err);
  }

  // ===== transactions 테이블 =====
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount INTEGER,
      reason TEXT,
      timestamp INTEGER
    );
  `);

  // ===== lottery_tickets 테이블 =====
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

/**
 * DB 객체 export
 */
export { db };

/**
 * 안전하게 DB 쿼리 실행
 */
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

/**
 * 사용자 정보 가져오기
 * 존재하지 않으면 자동 생성
 */
export async function getUser(id) {
  let user = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    await db.run(
      'INSERT INTO users (id, balance, last_claim, last_lottery) VALUES (?, ?, ?, ?)',
      id,
      1000,
      0,
      0
    );
    user = { id, balance: 1000, last_claim: 0, last_lottery: 0 };
  } else if (user.last_lottery === undefined) {
    user.last_lottery = 0;
  }
  return user;
}

/**
 * 잔고 업데이트
 */
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

/**
 * 하루 1회 기본금/무료복권 체크용 함수
 */
export async function canClaimDaily(userId) {
  const user = await getUser(userId);
  const last = user.last_claim || 0;
  const today = new Date();
  const lastDate = new Date(last);

  return !(
    lastDate.getUTCFullYear() === today.getUTCFullYear() &&
    lastDate.getUTCMonth() === today.getUTCMonth() &&
    lastDate.getUTCDate() === today.getUTCDate()
  );
}

/**
 * 하루 1회 claim 기록 갱신
 */
export async function updateClaim(userId) {
  const now = Date.now();
  await db.run('UPDATE users SET last_claim = ? WHERE id = ?', now, userId);
}

/**
 * 하루 1회 복권 구매 기록 갱신
 */
export async function updateLastLottery(userId) {
  const now = Date.now();
  await db.run('UPDATE users SET last_lottery = ? WHERE id = ?', now, userId);
}

/**
 * 사용자가 오늘 복권 구매 가능한지 체크
 */
export async function canBuyLottery(userId) {
  const user = await getUser(userId);
  const last = user.last_lottery || 0;
  const today = new Date();
  const lastDate = new Date(last);

  return !(
    lastDate.getUTCFullYear() === today.getUTCFullYear() &&
    lastDate.getUTCMonth() === today.getUTCMonth() &&
    lastDate.getUTCDate() === today.getUTCDate()
  );
}
