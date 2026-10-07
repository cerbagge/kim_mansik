// 디스코드 없이 가짜 interaction 으로 명령 핸들러를 끝까지 돌려 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, reset, fakeGuild } = require('./helpers');
const { getBalance, UserError } = require('../src/points');
const rules = require('../src/rules');
const settings = require('../src/settings');
const { syncMember } = require('../src/sync');
const commands = require('../src/commands');

test.beforeEach(reset);
test.after(() => db.close());

function fake(commandName, opts = {}, userId = '9', guildId = '101') {
  const calls = { reply: [], defer: [], edit: [] };
  const get = (k, required) => {
    if (opts[k] === undefined && required) throw new Error(`필수 옵션 ${k}`);
    return opts[k] ?? null;
  };
  return {
    calls,
    commandName,
    guildId,
    channelId: 'here',
    user: { id: userId },
    options: {
      getUser: (k, r) => (get(k, r) ? { id: get(k, r), bot: get(k, r) === 'bot' } : null),
      getInteger: get,
      getString: get,
      getRole: (k) => (opts[k] ? { id: opts[k] } : null),
      getChannel: (k) => (opts[k] ? { id: opts[k] } : null),
      getBoolean: get,
    },
    reply: async (x) => calls.reply.push(x),
    deferReply: async (x) => calls.defer.push(x),
    editReply: async (x) => calls.edit.push(x),
  };
}

// 실제 syncMember 를 가짜 서버(들)로 돌리는 ctx — index.js 의 ctx 와 같은 모양
function makeCtx(...guilds) {
  const sent = [];
  const byId = (gid) => guilds.find((g) => g.id === gid);
  const ctx = {
    sent,
    sync: async (gid, id) => syncMember(byId(gid), id, { rules: await rules.listRules(gid) }),
    resyncAll: async (gid, extra) => {
      const { allBalances } = require('../src/points');
      const all = await allBalances(gid);
      for (const { userId } of all) await syncMember(byId(gid), userId, { rules: await rules.listRules(gid), extraManaged: extra });
      return { count: all.length };
    },
    send: async (ch, msg) => sent.push([ch, msg]),
  };
  return ctx;
}

test('명령어 정의 6개, 모두 서버 전용, 관리자 명령은 서버 관리 권한', () => {
  const names = commands.data.map((c) => c.name);
  assert.deepEqual(names, ['포인트', '포인트추가', '포인트제거', '포인트지정', '포인트역할', '포인트알림']);
  for (const c of commands.data) {
    assert.deepEqual(c.contexts, [0]);
    if (c.name !== '포인트') assert.equal(c.default_member_permissions, '32');
  }
  const notify = commands.data.find((c) => c.name === '포인트알림');
  assert.deepEqual(notify.options.map((o) => o.name), ['채널', '끄기', '역할']); // 알림 역할은 1개
  const role = commands.data.find((c) => c.name === '포인트역할');
  assert.deepEqual(role.options.map((o) => o.name), ['기능', '포인트', '역할', '역할2', '역할3', '역할4', '역할5']);
});

test('구간 역할 추가 → 포인트추가 → 역할·별명·알림 → 포인트 조회', async () => {
  const g = fakeGuild();
  const m = g.addMember('1', { nickname: '철수' });
  const ctx = makeCtx(g);

  const r1 = fake('포인트역할', { 기능: 'add', 포인트: '100-199', 역할: 'r1' });
  await commands.handleCommand(r1, ctx);
  assert.match(r1.calls.edit.at(-1).content, /100~199P → <@&r1>\n✅ 0명에게 적용 완료/);
  await commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '200', 역할: 'r2', 역할2: 'r3' }), ctx);

  const list = fake('포인트역할', { 기능: 'list' });
  await commands.handleCommand(list, ctx);
  assert.equal(list.calls.reply[0].content, '100~199P → <@&r1>\n200P 이상 → <@&r2>, <@&r3>');

  await commands.handleCommand(fake('포인트알림', { 채널: 'ch1', 역할: 'staff' }), ctx);

  const add = fake('포인트추가', { 유저: '1', 숫자: 150, 사유: '이벤트 1등' });
  await commands.handleCommand(add, ctx);
  assert.equal(add.calls.edit[0].content, '<@1> 포인트 추가 +150P — 0P → **150P**\n역할 추가: <@&r1>\n별명 → 철수 1');
  assert.deepEqual([...m.roles.cache], ['r1']);
  assert.equal(ctx.sent.length, 1);
  const [ch, msg] = ctx.sent[0];
  assert.equal(ch, 'ch1');
  // 0P → 150P: 1단계(100~199P)로 올라섬 → 유저 + 알림 역할(staff) 멘션
  assert.equal(msg.content, '📝 <@9> → <@1> 포인트 추가 +150P · 0P → **150P** (사유: 이벤트 1등)\n🎉 <@&staff> <@1> 님이 **1단계**(100~199P)에 올라섰습니다! (받은 역할: <@&r1>)');
  assert.deepEqual(msg.allowedMentions, { users: ['1'], roles: ['staff'] });

  const set = fake('포인트지정', { 유저: '1', 숫자: 320 });
  await commands.handleCommand(set, ctx);
  // 구간 2개(100~199P = 1단계, 200P 이상 = 2단계) → 320P 는 2단계
  assert.match(set.calls.edit[0].content, /포인트 지정 320P 로 — 150P → \*\*320P\*\*\n역할 추가: <@&r2>, <@&r3>\n역할 회수: <@&r1>\n별명 → 철수 2/);

  // 150P → 320P: 2단계로 올라섬 → 다시 역할 멘션
  const up2 = ctx.sent.at(-1)[1];
  assert.match(up2.content, /\n🎉 <@&staff> <@1> 님이 \*\*2단계\*\*\(200P 이상\)에 올라섰습니다! \(받은 역할: <@&r2>, <@&r3>\)$/);
  assert.deepEqual(up2.allowedMentions.roles, ['staff']);

  const rm = fake('포인트제거', { 유저: '1', 숫자: 20 });
  await commands.handleCommand(rm, ctx);
  assert.match(rm.calls.edit[0].content, /-20P — 320P → \*\*300P\*\*$/); // 구간 그대로라 변화 없음
  // 단계 그대로(2단계) → 🎉 없음, 역할 멘션 없이 유저만
  assert.equal(ctx.sent.at(-1)[1].content.includes('🎉'), false);
  assert.deepEqual(ctx.sent.at(-1)[1].allowedMentions, { users: ['1'], roles: [] });

  const view = fake('포인트', {}, '1');
  await commands.handleCommand(view, ctx);
  const lines = view.calls.reply[0].content.split('\n');
  assert.equal(lines[0], '<@1> **300P**');
  assert.match(lines[2], /^<t:\d+:d> 제거 -20P → 300P$/);
  assert.match(lines[4], /^<t:\d+:d> 추가 \+150P → 150P · 이벤트 1등$/);
});

test('구간 제거 → 기록된 사람에게서 역할 회수', async () => {
  const g = fakeGuild();
  const m = g.addMember('1');
  const ctx = makeCtx(g);
  await commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '100', 역할: 'r1', 역할2: 'r2' }), ctx);
  await commands.handleCommand(fake('포인트추가', { 유저: '1', 숫자: 100 }), ctx);
  assert.deepEqual([...m.roles.cache].sort(), ['r1', 'r2']);

  const rm = fake('포인트역할', { 기능: 'remove', 포인트: '100', 역할: 'r2' });
  await commands.handleCommand(rm, ctx);
  assert.match(rm.calls.edit.at(-1).content, /100P 이상 에서 <@&r2> 뺌 → 남은 역할 <@&r1>\n✅ 1명에게 적용 완료/);
  assert.deepEqual([...m.roles.cache], ['r1']);

  const all = fake('포인트역할', { 기능: 'remove', 포인트: '100' });
  await commands.handleCommand(all, ctx);
  assert.match(all.calls.edit.at(-1).content, /100P 이상 구간 삭제/);
  assert.deepEqual([...m.roles.cache], []);
});

test('겹치는 구간은 경고', async () => {
  const ctx = makeCtx(fakeGuild());
  await commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '0-100', 역할: 'r1' }), ctx);
  const r = fake('포인트역할', { 기능: 'add', 포인트: '100-200', 역할: 'r2' });
  await commands.handleCommand(r, ctx);
  assert.match(r.calls.edit.at(-1).content, /⚠️ 겹치는 구간: 0~100P/);
});

test('포인트 없이 추가·제거, 잘못된 구간은 안내', async () => {
  const ctx = makeCtx(fakeGuild());
  const a = fake('포인트역할', { 기능: 'add', 역할: 'r1' });
  await commands.handleCommand(a, ctx);
  assert.match(a.calls.reply[0].content, /구간을 적어 주세요/);
  await assert.rejects(commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '1~2', 역할: 'r1' }), ctx), UserError);
});

test('알림: 채널 없이 쓰면 그 채널, 끄기:True 면 끄고 채널에 안 올림', async () => {
  const g = fakeGuild();
  g.addMember('1');
  const ctx = makeCtx(g);
  const here = fake('포인트알림', { 역할: 'staff' });
  await commands.handleCommand(here, ctx);
  assert.deepEqual(await settings.getNotify('101'), { channelId: 'here', roleIds: ['staff'] });
  assert.equal(here.calls.reply[0].content, '알림 채널: <#here>\n· 포인트 기록마다: 해당 유저 멘션\n· 구간을 넘으면: 해당 유저 + <@&staff> 멘션');
  await commands.handleCommand(fake('포인트알림', { 채널: 'ch1' }), ctx);
  assert.deepEqual(await settings.getNotify('101'), { channelId: 'ch1', roleIds: [] });
  const off = fake('포인트알림', { 끄기: true });
  await commands.handleCommand(off, ctx);
  assert.equal(off.calls.reply[0].content, '알림을 껐습니다.');
  await commands.handleCommand(fake('포인트추가', { 유저: '1', 숫자: 5 }), ctx);
  assert.equal(ctx.sent.length, 0);
});

test('보유보다 많이 제거는 UserError (잔액 그대로), 봇은 거절', async () => {
  const ctx = makeCtx(fakeGuild());
  await assert.rejects(commands.handleCommand(fake('포인트제거', { 유저: '1', 숫자: 5 }), ctx), UserError);
  assert.equal(await getBalance('101', '1'), 0);
  const b = fake('포인트추가', { 유저: 'bot', 숫자: 5 });
  await commands.handleCommand(b, ctx);
  assert.match(b.calls.reply[0].content, /봇에게는/);
});

test('서버에 없는 사람도 기록은 됨', async () => {
  const ctx = makeCtx(fakeGuild());
  const a = fake('포인트추가', { 유저: '77', 숫자: 5 });
  await commands.handleCommand(a, ctx);
  assert.match(a.calls.edit[0].content, /서버에 없는 사람이라/);
  assert.equal(await getBalance('101', '77'), 5);
});

test('서버마다 따로: 다른 서버에서 쓴 명령은 그 서버 포인트·구간·알림만', async () => {
  const g1 = fakeGuild({ id: '101' });
  const g2 = fakeGuild({ id: '102' });
  const a = g1.addMember('1', { nickname: '철수' });
  const b = g2.addMember('1', { nickname: '철수' });
  const ctx = makeCtx(g1, g2);
  await commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '100', 역할: 'r1' }, '9', '101'), ctx);
  await commands.handleCommand(fake('포인트알림', { 채널: 'ch-101' }, '9', '101'), ctx);
  await commands.handleCommand(fake('포인트추가', { 유저: '1', 숫자: 300 }, '9', '101'), ctx);
  await commands.handleCommand(fake('포인트추가', { 유저: '1', 숫자: 100 }, '9', '102'), ctx);

  assert.deepEqual([a.nickname, [...a.roles.cache]], ['철수 1', ['r1']]); // 101 은 구간 1개(100 이상) → 1단계
  assert.deepEqual([b.nickname, [...b.roles.cache]], ['철수', []]);       // 102 에는 구간이 없음 → 숫자 없음
  assert.equal(ctx.sent.length, 1); // g2 는 알림 꺼짐
  assert.equal(ctx.sent[0][0], 'ch-101');

  const v1 = fake('포인트', {}, '1', '101');
  const v2 = fake('포인트', {}, '1', '102');
  await commands.handleCommand(v1, ctx);
  await commands.handleCommand(v2, ctx);
  assert.match(v1.calls.reply[0].content, /^<@1> \*\*300P\*\*/);
  assert.match(v2.calls.reply[0].content, /^<@1> \*\*100P\*\*/);
  const list2 = fake('포인트역할', { 기능: 'list' }, '9', '102');
  await commands.handleCommand(list2, ctx);
  assert.equal(list2.calls.reply[0].content, '지정된 구간이 없습니다.');
});

test('알림: 내려가거나 구간 밖이면 축하·역할 멘션 없음', async () => {
  const g = fakeGuild();
  g.addMember('1');
  const ctx = makeCtx(g);
  await commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '100-199', 역할: 'r1' }), ctx);
  await commands.handleCommand(fake('포인트역할', { 기능: 'add', 포인트: '200', 역할: 'r2' }), ctx);
  await commands.handleCommand(fake('포인트알림', { 채널: 'ch1', 역할: 'staff' }), ctx);
  await commands.handleCommand(fake('포인트지정', { 유저: '1', 숫자: 50 }), ctx);   // 구간 밖 → 단계 0
  await commands.handleCommand(fake('포인트지정', { 유저: '1', 숫자: 250 }), ctx);  // 0 → 2단계 (건너뛰어도 한 번)
  await commands.handleCommand(fake('포인트지정', { 유저: '1', 숫자: 150 }), ctx);  // 2 → 1단계 (내려감)
  const [a, b, c] = ctx.sent.map(([, m]) => m);
  assert.equal(a.content.includes('🎉'), false);
  assert.match(b.content, /🎉 <@&staff> <@1> 님이 \*\*2단계\*\*\(200P 이상\)에 올라섰습니다!/);
  assert.equal(c.content.includes('🎉'), false);
  assert.deepEqual([a.allowedMentions.roles, b.allowedMentions.roles, c.allowedMentions.roles], [[], ['staff'], []]);
});
