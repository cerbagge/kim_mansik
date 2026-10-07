const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, verify } = require('../src/linkAuth');

const secret = 's3cret';
const body = Buffer.from('{"type":"member_join","event_id":"e1"}');
const now = 1_790_000_000;
const ts = String(now);

test('올바른 서명·시각은 통과', () => {
  assert.deepEqual(verify(secret, { timestamp: ts, signature: sign(secret, ts, body) }, body, now), { ok: true });
  // 문자열 본문도 같은 결과
  assert.deepEqual(verify(secret, { timestamp: ts, signature: sign(secret, ts, body.toString()) }, body, now), { ok: true });
});

test('알려진 값과 일치 (uri 쪽 구현 대조용)', () => {
  // printf '1790000000.{"a":1}' | openssl dgst -sha256 -hmac s3cret
  assert.equal(sign(secret, '1790000000', '{"a":1}'), 'sha256=' + require('crypto')
    .createHmac('sha256', secret).update('1790000000.{"a":1}').digest('hex'));
});

test('허용 오차 ±300초', () => {
  const sig = sign(secret, ts, body);
  assert.equal(verify(secret, { timestamp: ts, signature: sig }, body, now + 300).ok, true);
  assert.deepEqual(verify(secret, { timestamp: ts, signature: sig }, body, now + 301), { ok: false, why: 'stale' });
  assert.deepEqual(verify(secret, { timestamp: ts, signature: sig }, body, now - 301), { ok: false, why: 'stale' });
});

test('본문·시각·비밀값이 다르면 거절', () => {
  const sig = sign(secret, ts, body);
  assert.equal(verify(secret, { timestamp: ts, signature: sig }, Buffer.from('{}'), now).why, 'bad-signature');
  // 시각만 새로 바꿔 재전송해도 서명이 안 맞음
  assert.equal(verify(secret, { timestamp: String(now + 10), signature: sig }, body, now + 10).why, 'bad-signature');
  assert.equal(verify('other', { timestamp: ts, signature: sig }, body, now).why, 'bad-signature');
  assert.equal(verify(secret, { timestamp: ts, signature: 'sha256=00' }, body, now).why, 'bad-signature');
});

test('헤더 누락·형식 오류·비밀값 미설정', () => {
  assert.equal(verify(secret, { timestamp: ts }, body, now).why, 'missing-header');
  assert.equal(verify(secret, { signature: 'x' }, body, now).why, 'missing-header');
  assert.equal(verify(secret, { timestamp: '12a', signature: 'x' }, body, now).why, 'bad-timestamp');
  assert.equal(verify('', { timestamp: ts, signature: 'x' }, body, now).why, 'no-secret');
});
