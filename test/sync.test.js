const test = require('node:test');
const assert = require('node:assert/strict');
const { db, reset, fakeGuild } = require('./helpers');
const { record } = require('../src/points');
const rules = require('../src/rules');
const { syncMember, getSuffix } = require('../src/sync');

test.beforeEach(reset);
test.after(() => db.close());

const RULES = [{ min: 100, max: 199, roleIds: ['r1'] }, { min: 200, max: null, roleIds: ['r2'] }];

test('포인트가 오르면 역할 추가·이전 구간 회수·별명 숫자 교체', async () => {
  const g = fakeGuild();
  const m = g.addMember('1', { nickname: '철수' });
  await record('101', '1', 'set', 150, '9');
  let r = await syncMember(g, '1', { rules: RULES });
  assert.deepEqual([r.added, r.removed, r.nick, r.errors], [['r1'], [], '철수 1', []]);
  assert.deepEqual([...m.roles.cache], ['r1']);
  assert.equal(await getSuffix('101', '1'), '1');

  await record('101', '1', 'add', 100, '9');
  r = await syncMember(g, '1', { rules: RULES });
  assert.deepEqual([r.added, r.removed, r.nick], [['r2'], ['r1'], '철수 2']);
  assert.deepEqual([...m.roles.cache], ['r2']);

  // 그대로면 아무것도 안 바뀜
  r = await syncMember(g, '1', { rules: RULES });
  assert.deepEqual([r.added, r.removed, r.nick], [[], [], undefined]);

  await record('101', '1', 'set', 0, '9');
  r = await syncMember(g, '1', { rules: RULES });
  assert.deepEqual([r.removed, r.nick], [['r2'], '철수']);
  assert.equal(m.nickname, '철수');
  assert.equal(await getSuffix('101', '1'), '');
});

test('규칙에 없는 역할(관리자가 따로 준 것)은 건드리지 않음, 방금 뺀 구간 역할은 회수', async () => {
  const g = fakeGuild({ roles: { r1: true, r2: true, other: true } });
  const m = g.addMember('1', { roleIds: ['other', 'r1'] });
  await record('101', '1', 'set', 50, '9');
  const r = await syncMember(g, '1', { rules: [], extraManaged: ['r1'] });
  assert.deepEqual(r.removed, ['r1']);
  assert.deepEqual([...m.roles.cache], ['other']);
});

test('uri 가 별명 담당이면 별명은 건드리지 않음', async () => {
  const g = fakeGuild();
  const m = g.addMember('1', { nickname: '철수' });
  await record('101', '1', 'set', 300, '9');
  const r = await syncMember(g, '1', { rules: RULES, nicknameOwner: 'uri' });
  assert.equal(r.nick, undefined);
  assert.equal(m.nickname, '철수');
  assert.deepEqual(r.added, ['r2']);
});

test('서버 주인·봇보다 높은 사람·봇보다 높은 역할은 오류로 알려 줌', async () => {
  const g = fakeGuild({ ownerId: '1', roles: { r1: false, r2: true } });
  const m = g.addMember('1', { nickname: '주인' });
  await record('101', '1', 'set', 150, '9');
  const r = await syncMember(g, '1', { rules: RULES });
  assert.deepEqual(r.added, []);
  assert.equal(r.nick, undefined);
  assert.equal(m.nickname, '주인');
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /봇 역할보다 높아/);
  assert.match(r.errors[1], /서버 주인/);
  assert.equal(await getSuffix('101', '1'), ''); // 못 바꿨으니 기록 안 함
});

test('서버에 없는 사람은 건너뜀', async () => {
  const g = fakeGuild();
  await record('101', '1', 'set', 150, '9');
  assert.deepEqual(await syncMember(g, '1', { rules: RULES }), { skipped: 'not-in-guild' });
});

test('DB 규칙으로도 동작 (listRules 결과 그대로)', async () => {
  await rules.addRule('101', { min: 100, max: null }, ['r3']);
  const g = fakeGuild();
  const m = g.addMember('1', { username: 'kim' });
  await record('101', '1', 'set', 100, '9');
  const r = await syncMember(g, '1', { rules: await rules.listRules('101') });
  assert.deepEqual([r.added, r.nick, m.nickname], [['r3'], 'kim 1', 'kim 1']);
});

test('서버마다 따로: 다른 서버 포인트·숫자는 안 섞임', async () => {
  const g1 = fakeGuild({ id: '101' });
  const g2 = fakeGuild({ id: '102' });
  const a = g1.addMember('1', { nickname: '철수' });
  const b = g2.addMember('1', { nickname: '철수' });
  await record('101', '1', 'set', 250, '9');
  await record('102', '1', 'set', 120, '9');
  await syncMember(g1, '1', { rules: RULES });
  await syncMember(g2, '1', { rules: RULES });
  assert.deepEqual([a.nickname, [...a.roles.cache]], ['철수 2', ['r2']]);
  assert.deepEqual([b.nickname, [...b.roles.cache]], ['철수 1', ['r1']]);
  assert.equal(await getSuffix('101', '1'), '2');
  assert.equal(await getSuffix('102', '1'), '1');
});
