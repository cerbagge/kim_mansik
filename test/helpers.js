// 테스트 공용 도구.
// 운영 DB 파일을 건드리지 않도록 db.js 를 불러오기 전에 메모리 DB 로 고정한다.
// (node --test 는 테스트 파일마다 따로 프로세스를 띄우므로 파일끼리도 섞이지 않는다)
process.env.DB_FILE = ':memory:';

const { db: sqlite, migrate } = require('../src/db');

// 각 테스트 전에 표를 비우고 자동 번호(id)도 1부터 다시
async function reset() {
  migrate();
  sqlite.exec(`
    DELETE FROM balances; DELETE FROM point_ledger; DELETE FROM role_rules;
    DELETE FROM settings; DELETE FROM nick_suffix; DELETE FROM sqlite_sequence;
  `);
}

// 테스트 파일 끝에 DB 닫기
const db = { close: () => sqlite.close() };

// 디스코드 서버 흉내: 역할 추가·회수, 별명 변경을 기록한다
function fakeGuild({ id = '101', ownerId = '999', roles = { r1: true, r2: true, r3: true } } = {}) {
  const members = new Map();
  const guild = {
    id,
    ownerId,
    roles: { cache: new Map(Object.entries(roles).map(([id, editable]) => [id, { id, editable }])) },
    members: { fetch: async (id) => { if (!members.has(id)) throw new Error('Unknown Member'); return members.get(id); } },
    addMember(id, { nickname = null, username = `user${id}`, globalName = null, roleIds = [], manageable = true } = {}) {
      const held = new Set(roleIds);
      const m = {
        id, nickname, manageable, user: { username, globalName },
        roles: {
          cache: held,
          add: async (ids) => ids.forEach((r) => held.add(r)),
          remove: async (ids) => ids.forEach((r) => held.delete(r)),
        },
        setNickname: async (n) => { m.nickname = n; },
      };
      members.set(id, m);
      return m;
    },
  };
  return guild;
}

module.exports = { db, reset, fakeGuild };
