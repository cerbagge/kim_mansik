// =====================================================================
// 서버별 설정 저장소 (settings 표, 값은 JSON)
// ---------------------------------------------------------------------
// 지금은 알림 설정(/포인트알림) 하나만 쓴다. 새 설정이 생기면 key 만 하나 더 쓰면 된다.
// =====================================================================
const { db } = require('./db');

// 설정 읽기. 없으면 def(기본값)
function get(guildId, key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE guild_id = ? AND key = ?').get(guildId, key);
  return row ? JSON.parse(row.value) : def;
}

// 설정 저장 (있으면 덮어씀)
function set(guildId, key, value) {
  db.prepare(`
    INSERT INTO settings (guild_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value
  `).run(guildId, key, JSON.stringify(value));
}

// 알림 설정: { channelId, roleIds }
//  - channelId 가 null 이면 알림 꺼짐
//  - roleIds = 구간을 넘었을 때 해당 유저와 함께 멘션할 역할 (지금은 /포인트알림 에서 1개만 고른다)
const getNotify = async (guildId) => get(guildId, 'notify', { channelId: null, roleIds: [] });
const setNotify = async (guildId, channelId, roleIds = []) => set(guildId, 'notify', { channelId, roleIds });

module.exports = { getNotify, setNotify };
