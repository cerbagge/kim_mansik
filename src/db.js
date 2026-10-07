// =====================================================================
// DB 연결 (SQLite 파일 하나)
// ---------------------------------------------------------------------
// 다른 컴퓨터로 옮겨도 그대로 돌 수 있게 DB 서버(PostgreSQL 등) 없이
// SQLite 파일 하나에 모든 데이터를 둔다. 백업 = 이 파일 복사.
//
//   기본 위치: <봇 폴더>/data/kimmansik.db
//   바꾸려면 .env 에 DB_FILE=/어딘가/파일.db  (테스트는 ':memory:' 를 쓴다)
//
// better-sqlite3 는 동기(synchronous) API 라 쿼리 중간에 다른 코드가 끼어들 수 없다.
// 그래서 트랜잭션 안의 "읽고 → 계산하고 → 쓰기" 가 통째로 한 번에 실행된다.
// =====================================================================
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'kimmansik.db');

// 파일 DB 면 폴더부터 만든다 (':memory:' 는 파일이 아니므로 건너뜀)
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
// WAL: 읽기와 쓰기가 서로 덜 막히고, 갑자기 꺼져도 파일이 잘 안 깨진다
db.pragma('journal_mode = WAL');
// 다른 연결이 쓰는 중이면 바로 실패하지 말고 최대 5초 기다린다
db.pragma('busy_timeout = 5000');

// 표 만들기. schema.sql 은 전부 IF NOT EXISTS 라 몇 번 실행해도 안전하다.
function migrate() {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

// fn() 을 트랜잭션 안에서 실행한다. fn 안에서 예외가 나면 그동안 쓴 것은 모두 취소(롤백)된다.
// 예) 포인트를 빼다가 잔액이 모자라 UserError 가 나면 기록도 남지 않는다.
function tx(fn) {
  return db.transaction(fn)();
}

module.exports = { db, migrate, tx, DB_FILE };
