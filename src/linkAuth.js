const crypto = require('crypto');

// uri 봇 연계 요청 서명 (point 봇에서 가져옴 — uri 대시보드와 같은 방식이어야 한다).
// 이 봇은 uri 에 보내는 하트비트·값 전송에 sign() 을 쓴다. verify() 는 테스트에서 상대편 흉내용.
// 비밀키는 .env LINK_SECRET = uri 레포 link/kimmansik.secret 과 같은 값.
//
// 헤더: X-Uri-Link-Timestamp: <유닉스 초>
//       X-Uri-Link-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
// 타임스탬프가 서명에 들어가므로 오래된 요청을 그대로 다시 보내면 거절된다.
const MAX_SKEW_SEC = 300;

function sign(secret, timestamp, rawBody) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `sha256=${mac}`;
}

// 통과하면 { ok: true }, 아니면 { ok: false, why }
function verify(secret, { timestamp, signature }, rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, why: 'no-secret' };
  if (!timestamp || !signature) return { ok: false, why: 'missing-header' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, why: 'bad-timestamp' };
  if (Math.abs(nowSec - Number(timestamp)) > MAX_SKEW_SEC) return { ok: false, why: 'stale' };
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, why: 'bad-signature' };
  }
  return { ok: true };
}

module.exports = { MAX_SKEW_SEC, sign, verify };
