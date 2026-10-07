const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { db, reset } = require('./helpers');
const { record } = require('../src/points');
const rules = require('../src/rules');
const { verify } = require('../src/linkAuth');
const link = require('../src/link');

test.beforeEach(reset);
test.after(() => db.close());

const SECRET = 's3cret';
const G1 = '111';
const G2 = '222';

// 진짜 HTTP 로 받아 서명을 검사하는 가짜 uri 대시보드
async function fakeUri(handler) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const auth = verify(SECRET, { timestamp: req.headers['x-uri-link-timestamp'], signature: req.headers['x-uri-link-signature'] }, raw);
      const body = JSON.parse(raw.toString());
      got.push({ path: req.url, auth, body });
      const [status, out] = handler(req.url, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${server.address().port}/dashboard/api/link`;
  return { got, apiUrl, close: () => new Promise((r) => server.close(r)) };
}

const opts = (apiUrl, state) => ({ apiUrl, linkId: 'kimmansik', secret: SECRET, state, clientId: '42', variable: 'PT' });
const st = (guild_id, connected, inUse = []) => ({ guild_id, connected, features: [], variables_in_use: inUse });

test('하트비트: 서버마다 별명 담당이 따로', async (t) => {
  let states = [st(G1, true, ['PT']), st(G2, true, [])];
  const uri = await fakeUri(() => [200, { ok: true, states }]);
  t.after(uri.close);
  const state = new link.LinkState();
  const r = await link.sendHeartbeat(opts(uri.apiUrl, state));
  assert.deepEqual(r, { ok: true, connected: [G1, G2], released: [] });
  assert.deepEqual(uri.got[0].auth, { ok: true });
  assert.deepEqual(uri.got[0].body, { link_id: 'kimmansik', client_id: '42', features: [] });
  assert.equal(state.nicknameOwner(G1), 'uri');
  assert.equal(state.nicknameOwner(G2), 'bot');
  assert.equal(state.nicknameOwner('333'), 'bot'); // 모르는 서버

  // G1 양식에서 {PT} 를 뺌, G2 는 넣음 → G1 만 이 봇에게 돌아옴
  states = [st(G1, true, ['XX']), st(G2, true, ['PT'])];
  assert.deepEqual((await link.sendHeartbeat(opts(uri.apiUrl, state))).released, [G1]);
  assert.equal(state.nicknameOwner(G1), 'bot');
  assert.equal(state.nicknameOwner(G2), 'uri');

  // G2 연결 해제(states 에서 빠짐) → 돌아옴
  states = [st(G1, true, [])];
  assert.deepEqual((await link.sendHeartbeat(opts(uri.apiUrl, state))).released, [G2]);
  assert.deepEqual(state.connectedGuilds(), [G1]);
});

test('하트비트: 404 면 모든 서버 연결 안 됨, 다른 실패는 마지막 상태 유지', async (t) => {
  let status = 500;
  const uri = await fakeUri(() => [status, { error: 'x' }]);
  t.after(uri.close);
  const state = new link.LinkState();
  state.variable = 'PT';
  state.apply([st(G1, true, ['PT']), st(G2, true, ['PT'])]);
  const r = await link.sendHeartbeat(opts(uri.apiUrl, state));
  assert.deepEqual([r.ok, r.released], [false, []]);
  assert.equal(state.nicknameOwner(G1), 'uri'); // uri 봇과 번갈아 바꾸지 않게 유지

  status = 404;
  const r2 = await link.sendHeartbeat(opts(uri.apiUrl, state));
  assert.deepEqual(r2.released.sort(), [G1, G2]);
  assert.deepEqual(state.connectedGuilds(), []);
});

test('uri 가 꺼져 있어도 예외 없이 실패만 돌려줌', async () => {
  const r = await link.sendHeartbeat(opts('http://127.0.0.1:1/x', new link.LinkState()));
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('값 푸시: 그 서버가 연결돼 있을 때만, 그 서버 구간 단계 번호', async (t) => {
  await rules.addRule(G1, { min: 100, max: 199 }, ['r1']); // G1: 1단계
  await rules.addRule(G1, { min: 200, max: null }, ['r2']); // G1: 2단계
  await rules.addRule(G2, { min: 500, max: null }, ['r9']); // G2: 1단계 하나뿐
  await record(G1, '1', 'set', 250, '9');
  await record(G1, '2', 'set', 99, '9');
  await record(G2, '1', 'set', 1000, '9');
  const uri = await fakeUri(() => [200, { ok: true }]);
  t.after(uri.close);
  const state = new link.LinkState();
  assert.deepEqual(await link.pushValues(opts(uri.apiUrl, state), G1), { ok: true, sent: 0 });
  assert.equal(uri.got.length, 0);

  state.apply([st(G1, true), st(G2, false)]);
  assert.deepEqual(await link.pushValues(opts(uri.apiUrl, state), G1), { ok: true, sent: 2 });
  assert.deepEqual(await link.pushValues(opts(uri.apiUrl, state), G2), { ok: true, sent: 0 }); // 연결 안 됨
  assert.equal(uri.got.length, 1);
  assert.deepEqual(uri.got[0].auth, { ok: true });
  assert.equal(uri.got[0].path, '/dashboard/api/link/values');
  assert.deepEqual(uri.got[0].body, {
    link_id: 'kimmansik', client_id: '42', guild_id: G1, values: { 1: { PT: '2' }, 2: { PT: '' } },
  });

  state.apply([st(G1, true), st(G2, true)]);
  await link.pushValues(opts(uri.apiUrl, state), G2, ['1', '5']);
  assert.deepEqual(uri.got[1].body.guild_id, G2);
  assert.deepEqual(uri.got[1].body.values, { 1: { PT: '1' }, 5: { PT: '' } }); // G2 1000P → 1단계, 기록 없는 5 → 없음
});

test('값 푸시: 403 not_connected 면 실패 반환', async (t) => {
  await record(G1, '1', 'set', 100, '9');
  const uri = await fakeUri(() => [403, { error: 'not_connected' }]);
  t.after(uri.close);
  const state = new link.LinkState();
  state.apply([st(G1, true)]);
  const r = await link.pushValues(opts(uri.apiUrl, state), G1);
  assert.deepEqual([r.ok, r.status, r.sent], [false, 403, 0]);
});
