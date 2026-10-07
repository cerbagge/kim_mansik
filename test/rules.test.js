const test = require('node:test');
const assert = require('node:assert/strict');
const { db, reset } = require('./helpers');
const rules = require('../src/rules');
const { UserError } = require('../src/points');

const G = '101';

test.beforeEach(reset);
test.after(() => db.close());

test('구간 형식: 0-100 은 양 끝 포함, 100 은 그 이상', () => {
  assert.deepEqual(rules.parseRange('0-100'), { min: 0, max: 100 });
  assert.deepEqual(rules.parseRange(' 100 '), { min: 100, max: null });
  assert.deepEqual(rules.parseRange('100 - 200'), { min: 100, max: 200 });
  for (const bad of ['', 'abc', '-5', '100-50', '1-2-3', '1.5']) assert.throws(() => rules.parseRange(bad), UserError, bad);
  assert.equal(rules.inRange({ min: 0, max: 100 }, 100), true);
  assert.equal(rules.inRange({ min: 0, max: 100 }, 101), false);
  assert.equal(rules.inRange({ min: 100, max: null }, 1e9), true);
  assert.equal(rules.rangeText({ min: 0, max: 100 }), '0~100P');
  assert.equal(rules.rangeText({ min: 300, max: null }), '300P 이상');
});

test('추가: 같은 구간이면 역할을 합치고, 목록은 낮은 구간부터', async () => {
  await rules.addRule(G, { min: 300, max: null }, ['r3']);
  await rules.addRule(G, { min: 100, max: 299 }, ['r1']);
  await rules.addRule(G, { min: 100, max: 299 }, ['r2', 'r1']);
  const list = await rules.listRules(G);
  assert.deepEqual(list.map((r) => [r.min, r.max, [...r.roleIds].sort()]), [[100, 299, ['r1', 'r2']], [300, null, ['r3']]]);
  await assert.rejects(rules.addRule(G, { min: 1, max: 2 }, []), UserError);
});

test('제거: 역할을 주면 그 역할만, 안 주면 구간 통째로', async () => {
  await rules.addRule(G, { min: 100, max: 299 }, ['r1', 'r2']);
  await rules.addRule(G, { min: 300, max: null }, ['r3']);
  assert.deepEqual(await rules.removeRule(G, { min: 100, max: 299 }, ['r2']), { rule: { id: 1, min: 100, max: 299, roleIds: ['r1'] }, removedRoleIds: ['r2'] });
  assert.deepEqual(await rules.removeRule(G, { min: 300, max: null }), { rule: null, removedRoleIds: ['r3'] });
  await assert.rejects(rules.removeRule(G, { min: 300, max: null }), /구간이 없습니다/);
  await assert.rejects(rules.removeRule(G, { min: 100, max: 299 }, ['r9']), /지정되지 않은 역할/);
  // 마지막 역할을 빼면 구간도 사라짐
  assert.equal((await rules.removeRule(G, { min: 100, max: 299 }, ['r1'])).rule, null);
  assert.deepEqual(await rules.listRules(G), []);
});

test('300 이상과 300-300 은 다른 구간', async () => {
  await rules.addRule(G, { min: 300, max: null }, ['r1']);
  await rules.addRule(G, { min: 300, max: 300 }, ['r2']);
  assert.equal((await rules.listRules(G)).length, 2);
});

test('가질 역할·관리 역할', () => {
  const list = [{ min: 0, max: 100, roleIds: ['a'] }, { min: 100, max: 199, roleIds: ['b'] }, { min: 200, max: null, roleIds: ['c', 'a'] }];
  assert.deepEqual([...rules.desiredRoles(list, 100)].sort(), ['a', 'b']);
  assert.deepEqual([...rules.desiredRoles(list, 150)], ['b']);
  assert.deepEqual([...rules.desiredRoles(list, 500)].sort(), ['a', 'c']);
  assert.deepEqual([...rules.managedRoles(list)].sort(), ['a', 'b', 'c']);
});

test('서버마다 따로: 구간', async () => {
  await rules.addRule('101', { min: 100, max: null }, ['r1']);
  await rules.addRule('102', { min: 100, max: null }, ['r2']); // 같은 구간도 서버가 다르면 별개
  assert.deepEqual((await rules.listRules('101')).map((r) => r.roleIds), [['r1']]);
  assert.deepEqual((await rules.listRules('102')).map((r) => r.roleIds), [['r2']]);
  await rules.removeRule('102', { min: 100, max: null });
  assert.equal((await rules.listRules('101')).length, 1);
  await assert.rejects(rules.removeRule('102', { min: 100, max: null }), /구간이 없습니다/);
});

test('단계 번호: 구간을 낮은 순으로 1, 2, 3 … 들어가는 가장 높은 단계', () => {
  const list = [{ min: 200, max: null, roleIds: [] }, { min: 0, max: 99, roleIds: [] }, { min: 100, max: 199, roleIds: [] }];
  assert.equal(rules.stageFor(list, 0), 1);
  assert.equal(rules.stageFor(list, 150), 2);
  assert.equal(rules.stageFor(list, 99999), 3);
  assert.equal(rules.stageFor([], 500), 0);                                    // 구간 없음
  const gap = [{ min: 100, max: 199, roleIds: [] }, { min: 300, max: null, roleIds: [] }];
  assert.equal(rules.stageFor(gap, 50), 0);                                    // 어느 구간에도 안 들어감
  assert.equal(rules.stageFor(gap, 250), 0);
  assert.equal(rules.stageFor(gap, 300), 2);
  // 겹치면 더 높은 단계 · 같은 시작점이면 끝이 짧은 쪽이 먼저, "이상" 은 맨 뒤
  const overlap = [{ min: 100, max: null, roleIds: [] }, { min: 100, max: 150, roleIds: [] }, { min: 0, max: 100, roleIds: [] }];
  assert.equal(rules.stageFor(overlap, 100), 3);
  assert.equal(rules.stageFor(overlap, 120), 3);
  assert.equal(rules.stageFor(overlap, 50), 1);
});
