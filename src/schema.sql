-- =====================================================================
-- 김만식 포인트 봇 DB 구조 (SQLite)
-- ---------------------------------------------------------------------
-- * 포인트·기록·구간·알림·별명 숫자는 모두 서버(guild_id)별이다.
--   같은 사람도 A 서버와 B 서버의 포인트는 따로 쌓인다.
-- * 디스코드 ID(서버·유저·역할·채널)는 TEXT 로 저장한다.
--   ID 는 18~20자리 숫자라 자바스크립트 숫자로 바꾸면 끝자리가 틀어질 수 있다.
-- * 시각은 UTC ISO 문자열 (예: 2026-10-07T01:23:45.678Z).
-- * 모두 IF NOT EXISTS 라 봇이 켜질 때마다 실행해도 기존 데이터는 그대로다.
-- =====================================================================

-- 현재 포인트 (서버·사람마다 한 줄)
CREATE TABLE IF NOT EXISTS balances (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- 음수가 될 수 없다
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (guild_id, user_id)
);

-- 포인트 기록 장부. 추가·제거·지정할 때마다 한 줄씩 쌓이고 지우지 않는다(엑셀 대신).
-- reason: add(추가) | remove(제거) | set(지정)
CREATE TABLE IF NOT EXISTS point_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  delta         INTEGER NOT NULL,   -- 변화량 (지정이면 지정 후 - 지정 전)
  balance_after INTEGER NOT NULL,   -- 이 기록 직후 잔액
  reason        TEXT    NOT NULL,
  note          TEXT,               -- 관리자가 적은 사유 (없으면 NULL)
  admin_id      TEXT,               -- 기록한 관리자
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS point_ledger_user_idx ON point_ledger (guild_id, user_id, id);

-- 포인트 구간 → 자동 역할. /포인트역할 로 관리한다.
-- max_points 가 NULL 이면 "min_points 이상" (끝 없음). 구간은 양 끝 포함.
-- role_ids 는 역할 ID 들의 JSON 배열 문자열 (예: ["123","456"])
CREATE TABLE IF NOT EXISTS role_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  min_points INTEGER NOT NULL CHECK (min_points >= 0),
  max_points INTEGER CHECK (max_points IS NULL OR max_points >= min_points),
  role_ids   TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- 한 서버에 같은 구간은 한 줄만 (NULL 끼리도 같은 것으로 보도록 -1 로 바꿔 비교)
CREATE UNIQUE INDEX IF NOT EXISTS role_rules_range_idx ON role_rules (guild_id, min_points, IFNULL(max_points, -1));

-- 서버별 설정. value 는 JSON 문자열.
-- 지금 쓰는 key: notify = { "channelId": "...", "roleIds": ["..."] }  (/포인트알림)
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (guild_id, key)
);

-- 봇이 별명 끝에 붙여 둔 숫자. 다음에 숫자를 바꿀 때 이걸 보고 옛 숫자를 떼어 낸다.
CREATE TABLE IF NOT EXISTS nick_suffix (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  suffix   TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
