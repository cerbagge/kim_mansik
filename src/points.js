// =====================================================================
// 포인트 잔액·기록 (서버별)
// ---------------------------------------------------------------------
// 이 봇의 포인트는 디스코드 활동으로 쌓이지 않는다. 관리자가 명령으로 직접 기록한다.
//   /포인트추가  → record(..., 'add')
//   /포인트제거  → record(..., 'remove')
//   /포인트지정  → record(..., 'set')
// 모든 기록은 point_ledger 에 남아 나중에 /포인트 로 볼 수 있다.
// =====================================================================
const { db, tx } = require('./db');

// 사용자에게 메시지를 그대로 보여 줘도 되는 실패 (예: 잔액 부족).
// index.js 가 이 오류는 "오류가 발생했습니다" 대신 message 를 그대로 답한다.
class UserError extends Error {}

// 기록 종류 → 화면에 보일 이름
const LABEL = { add: '추가', remove: '제거', set: '지정' };

// 관리자 수동 기록 한 건.
//   guildId: 기록할 서버, userId: 대상, mode: add | remove | set,
//   amount: 수량(지정이면 새 잔액), adminId: 기록한 관리자, note: 사유(선택)
// 반환: { before: 기록 전 잔액, after: 기록 후 잔액, delta: 변화량 }
// (DB 는 동기지만 함수는 async 로 둔다 — 부르는 쪽이 await 로 쓰고, 실패는 Promise 거절로 받는다)
async function record(guildId, userId, mode, amount, adminId, note = null) {
  if (!LABEL[mode]) throw new Error(`알 수 없는 기록 종류: ${mode}`);
  // 추가·제거는 1 이상, 지정은 0 이상만 허용
  if (!Number.isInteger(amount) || amount < 0 || (mode !== 'set' && amount === 0)) {
    throw new UserError('수량이 올바르지 않습니다.');
  }
  // 잔액 읽기 → 계산 → 잔액·장부 쓰기를 한 트랜잭션으로 (중간에 실패하면 아무것도 안 바뀜)
  return tx(() => {
    const row = db.prepare('SELECT balance FROM balances WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    const before = row ? row.balance : 0; // 처음 기록되는 사람은 0P 에서 시작
    const after = mode === 'add' ? before + amount : mode === 'remove' ? before - amount : amount;
    if (after < 0) throw new UserError(`보유 포인트(${before}P)보다 많이 제거할 수 없습니다.`);

    // 잔액 저장 (없으면 새로 만들고, 있으면 덮어씀)
    db.prepare(`
      INSERT INTO balances (guild_id, user_id, balance, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at
    `).run(guildId, userId, after);

    // 장부에 한 줄 추가
    db.prepare(`
      INSERT INTO point_ledger (guild_id, user_id, delta, balance_after, reason, note, admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, userId, after - before, after, mode, note, adminId);

    return { before, after, delta: after - before };
  });
}

// 그 서버에서의 현재 포인트. 한 번도 기록되지 않은 사람은 0.
async function getBalance(guildId, userId) {
  const row = db.prepare('SELECT balance FROM balances WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  return row ? row.balance : 0;
}

// 최근 기록 몇 건 (최신이 먼저). /포인트 화면에 쓴다.
async function recentLedger(guildId, userId, limit = 5) {
  return db.prepare(`
    SELECT delta, balance_after, reason, note, admin_id, created_at
    FROM point_ledger WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?
  `).all(guildId, userId, limit).map((r) => ({
    delta: r.delta, after: r.balance_after, reason: r.reason,
    note: r.note, adminId: r.admin_id, createdAt: r.created_at,
  }));
}

// 그 서버에 한 번이라도 기록된 모든 사람과 잔액.
// 구간을 바꿨을 때 전원 다시 적용하거나, uri 봇에 값을 한꺼번에 보낼 때 쓴다.
async function allBalances(guildId) {
  return db.prepare('SELECT user_id, balance FROM balances WHERE guild_id = ? ORDER BY user_id')
    .all(guildId).map((r) => ({ userId: r.user_id, balance: r.balance }));
}

module.exports = { UserError, LABEL, record, getBalance, recentLedger, allBalances };
