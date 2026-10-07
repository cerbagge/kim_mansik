const test = require('node:test');
const assert = require('node:assert/strict');
const { suffixFor, computeNick } = require('../src/nick');

test('붙일 글자 = 단계 번호 (0 이면 없음)', () => {
  assert.equal(suffixFor(0), '');
  assert.equal(suffixFor(1), '1');
  assert.equal(suffixFor(12), '12');
});

test('별명 없으면 보이는 이름 뒤에 붙이고, 숫자가 없어지면 별명을 지움', () => {
  assert.equal(computeNick({ nickname: null, fallback: '철수', prevSuffix: '', suffix: '1' }), '철수 1');
  assert.equal(computeNick({ nickname: '철수 1', fallback: '철수', prevSuffix: '1', suffix: '' }), null);
  assert.equal(computeNick({ nickname: null, fallback: '철수', prevSuffix: '', suffix: '' }), undefined);
});

test('전에 붙인 숫자를 떼고 새 숫자를 붙임, 같으면 그대로', () => {
  assert.equal(computeNick({ nickname: '영희 2', fallback: 'u', prevSuffix: '2', suffix: '3' }), '영희 3');
  assert.equal(computeNick({ nickname: '영희 3', fallback: 'u', prevSuffix: '3', suffix: '3' }), undefined);
  assert.equal(computeNick({ nickname: '영희 3', fallback: 'u', prevSuffix: '3', suffix: '' }), '영희');
});

test('사람이 별명을 바꿔 숫자가 사라졌으면 새 별명 뒤에 붙임', () => {
  assert.equal(computeNick({ nickname: '새이름', fallback: 'u', prevSuffix: '2', suffix: '2' }), '새이름 2');
});

test('32자를 넘으면 앞부분을 줄이고 숫자는 남김 (이모지 안 깨짐)', () => {
  const long = '가'.repeat(31) + '😀';
  const n = computeNick({ nickname: long, fallback: 'u', prevSuffix: '', suffix: '12' });
  assert.equal(n, '가'.repeat(29) + ' 12');
  assert.ok(Array.from(n).length <= 32);
  const emoji = '😀'.repeat(32);
  const e = computeNick({ nickname: emoji, fallback: 'u', prevSuffix: '', suffix: '1' });
  assert.equal(e, '😀'.repeat(30) + ' 1');
});
