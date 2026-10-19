import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createUser, createThread, addMessage, listMessages, addThreadMember } from '../server/db.ts';
import { buildApp } from '../server/routes.ts';

async function server() {
  const db = openDb(':memory:');
  const a = createUser(db, '예제사용자', 'password11')!;
  const b = createUser(db, '예제동료', 'password22')!;
  const app = buildApp(db);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close(), db, a, b };
}
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

test('listMessages 는 보는 사람에 따라 다르게 돌려준다', () => {
  const db = openDb(':memory:');
  const t = createThread(db, 'x', '예제사용자');
  addThreadMember(db, t.id, '예제동료');
  addMessage(db, { threadId: t.id, author: '예제사용자', authorType: 'human', kind: 'text', body: '공개', privateTo: null });
  addMessage(db, { threadId: t.id, author: '예제사용자', authorType: 'human', kind: 'text', body: '혼잣말', privateTo: '예제사용자' });

  assert.deepEqual(listMessages(db, t.id, '예제사용자').map((m) => m.body), ['공개', '혼잣말']);
  assert.deepEqual(listMessages(db, t.id, '예제동료').map((m) => m.body), ['공개']);
});

test('남의 혼잣말은 API 로도 보이지 않는다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();

  await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: h(s.a.token),
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: '혼잣말', privateTo: '예제사용자' }),
  });

  const mine = await (await fetch(`${s.base}/api/threads/${t.id}/messages`, { headers: h(s.a.token) })).json();
  const theirs = await fetch(`${s.base}/api/threads/${t.id}/messages`, { headers: h(s.b.token) });

  assert.equal(mine.length, 1);
  assert.equal(theirs.status, 404, '참여하지 않은 사람의 조회는 서버가 거절한다');
  s.close();
});

test('privateTo 는 본인 이름으로만 지정할 수 있다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();

  const res = await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: h(s.a.token),
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: 'x', privateTo: '예제동료' }),
  });
  assert.equal(res.status, 400, '남을 지정해 감추는 것은 허용하지 않는다');
  s.close();
});

test('에이전트는 원본의 privateTo 를 그대로 실을 수 있다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();

  const res = await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: h(s.a.token),
    body: JSON.stringify({ authorType: 'agent', author: '예제사용자', kind: 'text', body: '답', privateTo: '예제사용자' }),
  });
  assert.equal(res.ok, true);

  const theirs = await fetch(`${s.base}/api/threads/${t.id}/messages`, { headers: h(s.b.token) });
  assert.equal(theirs.status, 404, '질문이 감춰졌으면 답도 감춰져야 한다');
  s.close();
});

test('privateTo 없는 메시지도 멘션으로 초대한 참여자에게만 보인다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();
  await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: h(s.a.token),
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: '@예제동료 공개' }),
  });
  const theirs = await (await fetch(`${s.base}/api/threads/${t.id}/messages`, { headers: h(s.b.token) })).json();
  assert.equal(theirs.length, 1);
  s.close();
});
