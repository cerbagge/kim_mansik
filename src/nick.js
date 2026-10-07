// =====================================================================
// 별명 끝 숫자 계산 (디스코드·DB 와 상관없는 순수 계산 — 테스트하기 쉽게 따로 둠)
// ---------------------------------------------------------------------
// 숫자는 /포인트역할 구간의 단계 번호다 (rules.stageFor). 예) 2단계 → "철수 2", 구간 밖 → 숫자 없음
// =====================================================================

// 별명 끝에 붙일 글자: 단계 번호 (0 = 어느 구간에도 안 들어감 → '' = 숫자 없음)
function suffixFor(stage) {
  return stage > 0 ? String(stage) : '';
}

// 디스코드 서버 별명 최대 길이
const MAX_NICK = 32;

// 새 별명을 계산한다. 바꿀 필요가 없으면 undefined, 서버 별명을 지워야 하면 null.
// nickname: 지금 서버 별명(없으면 null), fallback: 서버 별명이 없을 때 보이는 이름,
// prevSuffix: 봇이 전에 붙인 숫자, suffix: 이번에 붙일 숫자('' = 없음)
function computeNick({ nickname, fallback, prevSuffix, suffix }) {
  // 1) 바탕 이름: 지금 별명에서 봇이 전에 붙인 " 숫자" 를 떼어 낸 것
  let base = nickname ?? fallback;
  if (nickname && prevSuffix && nickname.endsWith(` ${prevSuffix}`)) {
    base = nickname.slice(0, -(prevSuffix.length + 1));
  }
  // 2) 새 별명: 붙일 숫자가 없으면 바탕 이름 그대로
  //    (바탕이 원래 보이는 이름과 같으면 서버 별명 자체를 지워(null) 원래 상태로 돌린다)
  let target;
  if (!suffix) target = base === fallback ? null : base;
  else {
    // 숫자를 붙였을 때 32자를 넘으면 앞쪽 이름을 줄인다 (숫자는 항상 보이게)
    const tail = ` ${suffix}`;
    const chars = Array.from(base); // 이모지 등이 반으로 잘리지 않게
    const room = MAX_NICK - tail.length;
    target = (chars.length > room ? chars.slice(0, room).join('').trimEnd() : base) + tail;
  }
  // 3) 지금과 같으면 바꿀 필요 없음
  return target === nickname ? undefined : target;
}

module.exports = { suffixFor, computeNick, MAX_NICK };
