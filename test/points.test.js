const test = require('node:test');
const assert = require('node:assert/strict');
const { db, reset } = require('./helpers');
const { record, getBalance, recentLedger, allBalances, UserError } = require('../src/points');

const G = '101';

test.beforeEach(reset);
test.after(() => db.close());

test('추가·제거·지정이 잔액과 기록에 남는다', async () => {
  assert.deepEqual(await record(G, '1', 'add', 150, '9', '이벤트'), { before: 0, after: 150, delta: 150 });
  assert.deepEqual(await record(G, '1', 'remove', 50, '9'), { before: 150, after: 100, delta: -50 });
  assert.deepEqual(await record(G, '1', 'set', 30, '9', '정정'), { before: 100, after: 30, delta: -70 });
  assert.equal(await getBalance(G, '1'), 30);
  const led = await recentLedger(G, '1');
  assert.deepEqual(led.map((e) => [e.reason, e.delta, e.after, e.note, e.adminId]), [
    ['set', -70, 30, '정정', '9'], ['remove', -50, 100, null, '9'], ['add', 150, 150, '이벤트', '9'],
  ]);
});

test('보유보다 많이 제거하면 거절하고 아무것도 안 바뀜', async () => {
  await record(G, '1', 'add', 10, '9');
  await assert.rejects(record(G, '1', 'remove', 11, '9'), (e) => e instanceof UserError && /보유 포인트\(10P\)/.test(e.message));
  assert.equal(await getBalance(G, '1'), 10);
  assert.equal((await recentLedger(G, '1')).length, 1);
});

test('지정 0 은 허용, 추가 0·음수는 거절', async () => {
  await record(G, '1', 'add', 10, '9');
  assert.equal((await record(G, '1', 'set', 0, '9')).after, 0);
  await assert.rejects(record(G, '1', 'add', 0, '9'), UserError);
  await assert.rejects(record(G, '1', 'add', -5, '9'), UserError);
});

test('기록 없는 사람은 0P, allBalances 는 기록된 사람만', async () => {
  assert.equal(await getBalance(G, '5'), 0);
  await record(G, '2', 'add', 5, '9');
  await record(G, '1', 'set', 0, '9');
  assert.deepEqual(await allBalances(G), [{ userId: '1', balance: 0 }, { userId: '2', balance: 5 }]);
});

test('동시 추가도 잃어버리지 않는다', async () => {
  await Promise.all(Array.from({ length: 10 }, () => record(G, '1', 'add', 7, '9')));
  assert.equal(await getBalance(G, '1'), 70);
});

test('서버마다 따로: 같은 사람도 서버별 잔액·기록', async () => {
  await record('101', '1', 'add', 100, '9');
  await record('102', '1', 'add', 7, '9');
  await record('102', '2', 'set', 3, '9');
  assert.equal(await getBalance('101', '1'), 100);
  assert.equal(await getBalance('102', '1'), 7);
  assert.deepEqual((await recentLedger('102', '1')).map((e) => e.after), [7]);
  assert.deepEqual(await allBalances('101'), [{ userId: '1', balance: 100 }]);
  assert.deepEqual((await allBalances('102')).map((b) => b.userId), ['1', '2']);
  await assert.rejects(record('102', '1', 'remove', 8, '9'), UserError); // g1 잔액은 상관없음
});
