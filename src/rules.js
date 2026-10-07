// =====================================================================
// 포인트 구간 → 자동 역할 (서버별)
// ---------------------------------------------------------------------
// /포인트역할 기능:추가 포인트:0-100 역할:@A  → 0~100P 인 사람에게 @A 를 준다
// /포인트역할 기능:추가 포인트:300   역할:@B  → 300P 이상인 사람에게 @B 를 준다
//
// 규칙
//  - "0-100" 은 양 끝 포함(0 이상 100 이하), "300" 은 300 이상(끝 없음).
//  - 구간이 겹치면 겹치는 구간의 역할을 모두 받는다.
//  - 구간을 벗어나면 그 구간 역할은 회수한다(현재 잔액 기준).
//  - 실제로 역할을 주고 빼는 건 sync.js. 여기는 구간 저장·계산만 한다.
// =====================================================================
const { db, tx } = require('./db');
const { UserError } = require('./points');

// 관리자가 적은 글을 구간으로 바꾼다.
//   "0-100" → { min: 0, max: 100 },  "100" → { min: 100, max: null }
// 공백은 무시한다("100 - 200" 도 됨). 형식이 틀리면 UserError.
function parseRange(text) {
  const m = String(text ?? '').replace(/\s+/g, '').match(/^(\d{1,15})(?:-(\d{1,15}))?$/);
  if (!m) throw new UserError('포인트는 `0-100`(구간) 또는 `100`(그 이상) 형식으로 적어 주세요.');
  const min = Number(m[1]);
  const max = m[2] === undefined ? null : Number(m[2]);
  if (max !== null && max < min) throw new UserError('구간의 끝이 시작보다 작습니다.');
  return { min, max };
}

// 구간을 사람이 읽는 글로: "0~100P" / "300P 이상"
const rangeText = ({ min, max }) => (max === null ? `${min}P 이상` : `${min}~${max}P`);

// 이 포인트가 구간 안인가 (양 끝 포함)
const inRange = ({ min, max }, points) => points >= min && (max === null || points <= max);

// DB 한 줄 → { id, min, max, roleIds[] }
function rowToRule(r) {
  return { id: r.id, min: r.min_points, max: r.max_points, roleIds: JSON.parse(r.role_ids) };
}

// 같은 구간 한 줄 찾기 (max 가 NULL 인 "이상" 구간도 정확히 찾도록 IS 로 비교)
function findRule(guildId, range) {
  const row = db.prepare('SELECT * FROM role_rules WHERE guild_id = ? AND min_points = ? AND max_points IS ?')
    .get(guildId, range.min, range.max);
  return row ? rowToRule(row) : null;
}

// 그 서버의 모든 구간 (낮은 구간부터, "이상" 구간은 같은 시작점 중 맨 뒤)
async function listRules(guildId) {
  return db.prepare('SELECT * FROM role_rules WHERE guild_id = ? ORDER BY min_points, max_points NULLS LAST')
    .all(guildId).map(rowToRule);
}

// 구간에 역할 추가. 같은 구간이 이미 있으면 역할을 합친다(중복 제거).
// 반환: 저장된 구간
async function addRule(guildId, range, roleIds) {
  if (roleIds.length === 0) throw new UserError('역할을 하나 이상 지정해 주세요.');
  return tx(() => {
    const cur = findRule(guildId, range);
    if (cur) {
      const merged = [...new Set([...cur.roleIds, ...roleIds])];
      db.prepare('UPDATE role_rules SET role_ids = ? WHERE id = ?').run(JSON.stringify(merged), cur.id);
      return { ...cur, roleIds: merged };
    }
    const info = db.prepare('INSERT INTO role_rules (guild_id, min_points, max_points, role_ids) VALUES (?, ?, ?, ?)')
      .run(guildId, range.min, range.max, JSON.stringify(roleIds));
    return { id: Number(info.lastInsertRowid), min: range.min, max: range.max, roleIds };
  });
}

// 구간에서 역할 빼기.
//  - roleIds 를 주면 그 역할만 빼고, 안 주면 구간을 통째로 지운다.
//  - 마지막 역할까지 빠지면 구간도 지운다.
// 반환: { rule: 남은 구간(없으면 null), removedRoleIds: 뺀 역할들 }
//  → 부르는 쪽(commands.js)은 removedRoleIds 를 사람들에게서 회수해야 한다(더는 규칙에 없으므로).
async function removeRule(guildId, range, roleIds = []) {
  return tx(() => {
    const rule = findRule(guildId, range);
    if (!rule) throw new UserError(`${rangeText(range)} 구간이 없습니다. /포인트역할 목록 으로 확인해 주세요.`);
    const removed = roleIds.length ? rule.roleIds.filter((id) => roleIds.includes(id)) : rule.roleIds;
    if (removed.length === 0) throw new UserError('그 구간에 지정되지 않은 역할입니다.');
    const left = rule.roleIds.filter((id) => !removed.includes(id));
    if (left.length === 0) {
      db.prepare('DELETE FROM role_rules WHERE id = ?').run(rule.id);
      return { rule: null, removedRoleIds: removed };
    }
    db.prepare('UPDATE role_rules SET role_ids = ? WHERE id = ?').run(JSON.stringify(left), rule.id);
    return { rule: { ...rule, roleIds: left }, removedRoleIds: removed };
  });
}

// 이 포인트에서 가져야 할 역할들 (겹치는 구간이면 모두)
function desiredRoles(rules, points) {
  return new Set(rules.filter((r) => inRange(r, points)).flatMap((r) => r.roleIds));
}

// 단계 번호 = 별명 끝 숫자 (uri 연계 변수 {PT} 값도 같다).
// 구간을 낮은 순(시작점, 같으면 끝점, "이상" 은 맨 뒤)으로 1, 2, 3 … 번호를 매기고,
// 이 포인트가 들어가는 구간 중 가장 높은 단계 번호를 돌려준다. 어느 구간에도 안 들어가면 0(숫자 없음).
//   예) 0-99 → 1단계, 100-199 → 2단계, 200 이상 → 3단계  ⇒  150P = 2, 500P = 3
function stageFor(rules, points) {
  const ordered = [...rules].sort((a, b) => a.min - b.min || (a.max ?? Infinity) - (b.max ?? Infinity));
  let stage = 0;
  ordered.forEach((r, i) => { if (inRange(r, points)) stage = i + 1; });
  return stage;
}

// 봇이 관리하는 모든 역할 (어느 구간에든 들어 있는 역할).
// 이 목록에 없는 역할은 봇이 절대 건드리지 않는다(관리자가 따로 준 역할 보호).
function managedRoles(rules) {
  return new Set(rules.flatMap((r) => r.roleIds));
}

module.exports = { parseRange, rangeText, inRange, listRules, addRule, removeRule, stageFor, desiredRoles, managedRoles };
