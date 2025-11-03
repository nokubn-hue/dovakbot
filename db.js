// db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let db;

/**
 * DB 초기화
 */
export async function initDB() {
  db = await open({
    filename: './casino.db', // DB 파일 경로
    driver: sqlite3.Database,
  });

  // ===== users 테이블 =====
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 1000,
      last_claim INTEGER DEFAULT 0,     -- 하루 기본금/복권 공유 타임스탬프
      last_lottery INTEGER DEFAULT 0    -- 마지막 무료 복권 구매 시간 (별도 체크용)
    );
  `);

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
  if (!db) await initDB();
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
    console.log(`🆕 새 유저 등록: ${id}`);
  }
  return user;
}

/**
 * 잔고 업데이트
 * 트랜잭션 처리로 안전하게 업데이트
 */
export async function updateBalance(userId, amount, reason) {
  if (!db) await initDB();
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
    console.log(`💰 [${userId}] 잔고 변경: ${user.balance} → ${newBalance} (${reason})`);
    return newBalance;
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('💥 Balance update error:', err);
    throw err;
  }
}

/**
 * 하루 1회 기본금 수령 또는 무료 복권 구매 가능 여부 체크
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
 * 무료 복권 1일 1회 체크용
 */
export async function canBuyFreeLottery(userId) {
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

/**
 * 무료 복권 구매 시간 갱신
 */
export async function updateFreeLotteryDate(userId) {
  const now = Date.now();
  await db.run('UPDATE users SET last_lottery = ? WHERE id = ?', now, userId);
}
