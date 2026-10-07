// =====================================================================
// 포인트 → 디스코드에 실제로 반영 (역할 주고 빼기 + 별명 끝 숫자)
// ---------------------------------------------------------------------
// 포인트가 기록되거나(/포인트추가 등) 구간이 바뀌면(/포인트역할) 이 함수가 불린다.
// 한 사람씩 "지금 포인트라면 어떤 역할·별명이어야 하나" 를 계산해서 다른 부분만 고친다.
//
// 디스코드가 거절하는 경우 (오류로 모아 관리자에게 알려 준다, 봇은 멈추지 않음)
//  - 봇 역할보다 높은 역할은 주거나 뺄 수 없다 → 서버 설정에서 봇 역할을 위로 올려야 함
//  - 서버 주인, 또는 봇보다 높은 역할을 가진 사람의 별명은 바꿀 수 없다
// =====================================================================
const { db } = require('./db');
const { getBalance } = require('./points');
const { desiredRoles, managedRoles, stageFor } = require('./rules');
const { suffixFor, computeNick } = require('./nick');

// 디스코드 감사 로그에 남는 사유
const REASON = '포인트 구간 자동 적용';

// 봇이 이 사람 별명 끝에 붙여 둔 숫자 (없으면 '')
async function getSuffix(guildId, userId) {
  const row = db.prepare('SELECT suffix FROM nick_suffix WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  return row ? row.suffix : '';
}

// 붙인 숫자 기억해 두기 ('' 이면 기록을 지움)
function saveSuffix(guildId, userId, suffix) {
  if (!suffix) {
    db.prepare('DELETE FROM nick_suffix WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
    return;
  }
  db.prepare(`
    INSERT INTO nick_suffix (guild_id, user_id, suffix) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET suffix = excluded.suffix
  `).run(guildId, userId, suffix);
}

// 한 사람에게 그 서버(guild) 포인트에 맞는 역할·별명을 적용한다.
//
// 인자
//   guild         : discord.js Guild
//   userId        : 대상 유저 ID
//   rules         : listRules(guild.id) 결과 (여러 명을 처리할 때 한 번만 읽으려고 밖에서 받는다).
//                   역할과 별명 숫자(구간 단계 번호) 모두 이걸로 정한다
//   nicknameOwner : 'bot' | 'uri'. uri 봇 닉네임 양식이 {PT} 를 쓰면 'uri' → 별명은 건드리지 않음
//   extraManaged  : 방금 구간에서 빠진 역할들. 규칙에는 더 없지만 가진 사람에게서 회수해야 한다
//
// 반환
//   { points, added[], removed[], nick, errors[] }
//     nick: undefined = 그대로 둠, null = 서버 별명 지움, 문자열 = 새 별명
//   또는 { skipped: 'not-in-guild' } (서버에 없는 사람 — 포인트 기록은 그대로 남는다)
async function syncMember(guild, userId, { rules, nicknameOwner = 'bot', extraManaged = [] }) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { skipped: 'not-in-guild' };
  const points = await getBalance(guild.id, userId);
  const errors = [];

  // ---- 1) 역할 ----
  const want = desiredRoles(rules, points);   // 지금 포인트로 가져야 할 역할
  const managed = managedRoles(rules);        // 봇이 관리하는 역할 전체
  for (const id of extraManaged) managed.add(id);
  const has = member.roles.cache;             // 지금 가진 역할

  // 봇이 실제로 다룰 수 있는 역할인지 (지워진 역할·봇보다 높은 역할은 오류로 남기고 건너뜀)
  const usable = (id) => {
    const role = guild.roles.cache.get(id);
    if (!role) errors.push(`역할 ${id} 없음(삭제됨)`);
    else if (!role.editable) errors.push(`<@&${id}> 은(는) 봇 역할보다 높아 줄 수 없음`);
    return Boolean(role?.editable);
  };
  const added = [...want].filter((id) => !has.has(id) && usable(id));                   // 없는데 가져야 함
  const removed = [...managed].filter((id) => has.has(id) && !want.has(id) && usable(id)); // 있는데 구간 밖
  if (added.length) await member.roles.add(added, REASON).catch((e) => errors.push(`역할 추가 실패: ${e.message}`));
  if (removed.length) await member.roles.remove(removed, REASON).catch((e) => errors.push(`역할 회수 실패: ${e.message}`));

  // ---- 2) 별명 끝 숫자 (구간 단계 번호) ----
  let nick;
  if (nicknameOwner !== 'uri') {
    const prevSuffix = await getSuffix(guild.id, userId);
    const suffix = suffixFor(stageFor(rules, points));
    nick = computeNick({
      nickname: member.nickname,                                   // 서버 별명 (없으면 null)
      fallback: member.user.globalName ?? member.user.username,   // 서버 별명이 없을 때 보이는 이름
      prevSuffix,
      suffix,
    });
    if (nick === undefined) {
      // 별명은 이미 맞음. 기억해 둔 숫자만 맞춰 둔다
      if (prevSuffix !== suffix) saveSuffix(guild.id, userId, suffix);
    } else if (guild.ownerId === userId || !member.manageable) {
      errors.push('별명: 서버 주인이거나 봇보다 역할이 높아 바꿀 수 없음');
      nick = undefined;
    } else {
      try {
        await member.setNickname(nick, REASON);
        saveSuffix(guild.id, userId, suffix); // 바꾸는 데 성공했을 때만 기억
      } catch (e) {
        errors.push(`별명 변경 실패: ${e.message}`);
        nick = undefined;
      }
    }
  }
  return { points, added, removed, nick, errors };
}

module.exports = { syncMember, getSuffix };
