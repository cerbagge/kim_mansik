// =====================================================================
// uri 봇(플어봇) 연계 — 닉네임 양식 변수 {PT}
// ---------------------------------------------------------------------
// uri 봇은 서버 닉네임을 "양식" 으로 만든다 (예: {MC} | {NN} → Steve | 대한제국).
// 이 봇이 사람마다 PT(= /포인트역할 구간 단계 번호) 값을 uri 에 보내 주면, 서버 관리자가 uri 양식에
// {PT} 를 넣어 "Steve | 3" 처럼 쓸 수 있다. 그 서버는 uri 가 별명을 만들므로 이 봇은 별명을 건드리지 않는다.
//
// 흐름 (모두 이 봇 → uri 대시보드, 서명 포함)
//   POST <LINK_API_URL>/heartbeat  기동 직후 + 10분마다. 응답 states = 서버별 연결 여부·양식이 쓰는 변수
//   POST <LINK_API_URL>/values     포인트가 바뀔 때(그 사람) + 하트비트마다(그 서버 전체)
// 이 봇은 웹훅을 받지 않는다 — 상태는 하트비트 응답으로만 받는다.
// 사양 원문은 uri 레포 link/README.md 6장. 연결·별명 담당은 서버마다 따로다.
// =====================================================================
const { sign } = require('./linkAuth');
const { allBalances, getBalance } = require('./points');
const { suffixFor } = require('./nick');
const { listRules, stageFor } = require('./rules');

const HEARTBEAT_MS = 600_000; // 하트비트 주기 10분 (uri 사양)
const VALUES_CHUNK = 1000;    // /values 한 번에 보낼 최대 인원 (uri 제한)

// 서버별 연계 상태를 들고 있는 상자. 하트비트 응답이 올 때마다 통째로 바뀐다.
class LinkState {
  constructor() {
    this.guilds = new Map(); // guildId → { connected, variablesInUse }
    this.variable = null;
    this.loggedOwners = new Map();
  }

  // 그 서버가 uri 에 연결돼 있나
  connected(guildId) {
    return Boolean(this.guilds.get(guildId)?.connected);
  }

  // 연결된 서버 목록
  connectedGuilds() {
    return [...this.guilds].filter(([, s]) => s.connected).map(([g]) => g);
  }

  // 'uri' = 그 서버 uri 닉네임 양식이 이 봇 변수를 쓰고 있어 uri 가 별명을 만든다 → 이 봇은 별명을 건드리지 않음.
  // 하트비트가 잠깐 실패해도 마지막으로 받은 상태를 그대로 쓴다 — uri 봇은 대시보드와 따로 돌며 계속 별명을 만들므로
  // 여기서 별명을 되찾으면 둘이 번갈아 바꾸게 된다. 링크가 지워지면(404) 연결 안 됨으로 돌아온다.
  nicknameOwner(guildId) {
    const s = this.guilds.get(guildId);
    return s?.connected && s.variablesInUse.includes(this.variable) ? 'uri' : 'bot';
  }

  // states: 하트비트 응답 states 전체. 거기 없는 서버는 연결 안 됨. null = 전부 연결 안 됨(404).
  // 별명 담당이 uri → 이 봇으로 바뀐 서버 목록을 돌려준다 (그 서버는 숫자를 다시 붙여야 함).
  apply(states) {
    const before = new Map([...this.guilds.keys()].map((g) => [g, this.nicknameOwner(g)]));
    this.guilds = new Map((states ?? []).map((s) => [String(s.guild_id), {
      connected: Boolean(s.connected),
      variablesInUse: s.connected && Array.isArray(s.variables_in_use) ? s.variables_in_use : [],
    }]));
    const released = [];
    for (const g of new Set([...before.keys(), ...this.guilds.keys()])) {
      const owner = this.nicknameOwner(g);
      if ((this.loggedOwners.get(g) ?? 'bot') !== owner) {
        console.log(`[link] 서버 ${g} 별명 담당 → ${owner === 'uri' ? 'uri (닉네임 양식이 연계 변수 사용)' : '이 봇 (끝에 숫자)'}`);
        this.loggedOwners.set(g, owner);
      }
      if (before.get(g) === 'uri' && owner === 'bot') released.push(g);
    }
    return released;
  }
}

// uri 대시보드 API 에 서명된 POST (헤더 형식은 linkAuth.js).
// uri 가 이 컴퓨터(127.0.0.1)에서 돌기 때문에 10초 안에 답이 없으면 실패로 본다. 네트워크 오류는 { ok: false, error } 로 돌려준다.
async function postSigned(url, secret, obj, fetchFn) {
  const raw = JSON.stringify(obj);
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Uri-Link-Timestamp': ts,
        'X-Uri-Link-Signature': sign(secret, ts, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
      return { ok: false, status: res.status, text };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.cause?.code ?? err.message };
  }
}

// 실패 로그 한 줄 남기고 { ok: false } 로 정리
function failed(what, r) {
  console.warn(`[link] ${what} 실패: ${r.status ?? ''} ${r.text ?? r.error ?? ''}`);
  return { ok: false, status: r.status, error: r.error };
}

// 하트비트 1회. 실패해도 예외를 던지지 않는다 (uri 가 꺼져 있어도 봇은 계속 돈다).
// 반환 released: 별명 담당이 uri 에서 이 봇으로 돌아온 서버들.
async function sendHeartbeat({ apiUrl, linkId, secret, state, clientId, variable, fetchFn = fetch }) {
  state.variable = variable;
  const r = await postSigned(`${apiUrl}/heartbeat`, secret, { link_id: linkId, client_id: clientId, features: [] }, fetchFn);
  if (!r.ok) {
    // 404 = link 파일이 없거나 오류 → 모든 서버 연결 안 됨
    const released = r.status === 404 ? state.apply(null) : [];
    return { ...failed('하트비트', r), released };
  }
  const released = state.apply(r.data.states ?? []);
  return { ok: true, connected: state.connectedGuilds(), released };
}

// 그 서버의 별명 변수 값을 uri 에 보낸다. userIds 를 안 주면 그 서버에 기록된 모든 사람.
// 연결 안 된 서버면 보내지 않는다 (uri 가 403 not_connected 로 거절).
async function pushValues({ apiUrl, linkId, secret, state, clientId, variable, fetchFn = fetch }, guildId, userIds) {
  if (!state.connected(guildId)) return { ok: true, sent: 0 };
  const rows = userIds
    ? await Promise.all(userIds.map(async (id) => ({ userId: id, balance: await getBalance(guildId, id) })))
    : await allBalances(guildId);
  const rules = await listRules(guildId); // 값 = 그 서버 구간에서의 단계 번호
  let sent = 0;
  for (let i = 0; i < rows.length; i += VALUES_CHUNK) {
    const values = {};
    for (const { userId, balance } of rows.slice(i, i + VALUES_CHUNK)) values[userId] = { [variable]: suffixFor(stageFor(rules, balance)) };
    const r = await postSigned(`${apiUrl}/values`, secret, { link_id: linkId, client_id: clientId, guild_id: guildId, values }, fetchFn);
    if (!r.ok) return { ...failed(`값 전송(서버 ${guildId})`, r), sent };
    sent += Object.keys(values).length;
  }
  return { ok: true, sent };
}

module.exports = { HEARTBEAT_MS, LinkState, sendHeartbeat, pushValues };
