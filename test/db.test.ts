import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, createThread, listThreads, getThread,
  addMessage, listMessages, upsertUser, findUserByToken,
} from '../server/db.ts';

function freshDb() {
  return openDb(':memory:');
}

test('스레드를 만들고 다시 읽는다', () => {
  const db = freshDb();
  const t = createThread(db, '결제 API 문의');
  assert.equal(t.title, '결제 API 문의');
  assert.equal(t.autoTurns, 0);
  assert.equal(t.paused, false);
  assert.equal(t.autoStartedAt, null);
  assert.match(t.id, /^[0-9a-f-]{36}$/);

  const again = getThread(db, t.id);
  assert.deepEqual(again, t);
});

test('없는 스레드는 null', () => {
  const db = freshDb();
  assert.equal(getThread(db, 'nope'), null);
});

test('스레드 목록은 최신순', () => {
  const db = freshDb();
  const a = createThread(db, '먼저');
  const b = createThread(db, '나중');
  const ids = listThreads(db).map((t) => t.id);
  assert.deepEqual(ids, [b.id, a.id]);
});

test('메시지를 넣고 순서대로 읽는다', () => {
  const db = freshDb();
  const t = createThread(db, '스레드');
  const m1 = addMessage(db, {
    threadId: t.id, author: '예제사용자', authorType: 'human',
    kind: 'text', body: '@예제동료 이거 뭐예요?',
  });
  const m2 = addMessage(db, {
    threadId: t.id, author: '예제동료', authorType: 'agent',
    kind: 'text', body: '결제 승인 엔드포인트입니다.',
  });

  assert.equal(m1.id < m2.id, true);
  const list = listMessages(db, t.id, '예제사용자');
  assert.deepEqual(list.map((m) => m.body), [m1.body, m2.body]);
  assert.equal(list[1].authorType, 'agent');
});

test('다른 스레드의 메시지는 섞이지 않는다', () => {
  const db = freshDb();
  const a = createThread(db, 'A');
  const b = createThread(db, 'B');
  addMessage(db, { threadId: a.id, author: '예제사용자', authorType: 'human', kind: 'text', body: 'a' });
  addMessage(db, { threadId: b.id, author: '예제사용자', authorType: 'human', kind: 'text', body: 'b' });
  assert.deepEqual(listMessages(db, a.id, '예제사용자').map((m) => m.body), ['a']);
});

test('토큰으로 사용자를 찾는다', () => {
  const db = freshDb();
  upsertUser(db, '예제사용자', 'tok-abc');
  assert.equal(findUserByToken(db, 'tok-abc'), '예제사용자');
  assert.equal(findUserByToken(db, 'tok-none'), null);
});

test('같은 이름으로 upsert 하면 토큰이 갱신된다', () => {
  const db = freshDb();
  upsertUser(db, '예제사용자', 'tok-1');
  upsertUser(db, '예제사용자', 'tok-2');
  assert.equal(findUserByToken(db, 'tok-1'), null);
  assert.equal(findUserByToken(db, 'tok-2'), '예제사용자');
});
