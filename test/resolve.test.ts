import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createUser, createThread, getThread, setResolved, addMessage } from '../server/db.ts';
import { buildApp } from '../server/routes.ts';

async function server() {
  const db = openDb(':memory:');
  const a = createUser(db, '예제사용자', 'password11')!;
  const app = buildApp(db);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close(), db, a };
}
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

test('새 스레드는 해결되지 않은 상태다', () => {
  const db = openDb(':memory:');
  assert.equal(createThread(db, 'x').resolved, false);
});

test('setResolved 가 상태를 바꾸고 되돌릴 수 있다', () => {
  const db = openDb(':memory:');
  const t = createThread(db, 'x');
  assert.equal(setResolved(db, t.id, true)!.resolved, true);
  assert.equal(getThread(db, t.id)!.resolved, true);
  assert.equal(setResolved(db, t.id, false)!.resolved, false);
  assert.equal(setResolved(db, '없는스레드', true), null);
});

test('사람이 메시지를 쓰면 다시 열린다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();

  await fetch(`${s.base}/api/threads/${t.id}/resolve`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ resolved: true }),
  });
  assert.equal(getThread(s.db, t.id)!.resolved, true);

  await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: h(s.a.token),
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: '하나 더 물어볼게요' }),
  });
  assert.equal(getThread(s.db, t.id)!.resolved, false, '다시 묻고 있다면 해결된 것이 아니다');
  s.close();
});

test('에이전트 메시지는 해결 상태를 바꾸지 않는다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();
  setResolved(s.db, t.id, true);

  await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: h(s.a.token),
    body: JSON.stringify({ authorType: 'agent', author: '예제사용자', kind: 'text', body: '답' }),
  });
  assert.equal(getThread(s.db, t.id)!.resolved, true);
  s.close();
});

test('해결 상태는 목록에도 반영된다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ title: 'x' }),
  })).json();
  await fetch(`${s.base}/api/threads/${t.id}/resolve`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ resolved: true }),
  });
  const list = await (await fetch(`${s.base}/api/threads`, { headers: h(s.a.token) })).json();
  assert.equal(list.find((x: { id: string }) => x.id === t.id).resolved, true);
  s.close();
});

test('없는 스레드를 해결하려 하면 404', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/threads/nope/resolve`, {
    method: 'POST', headers: h(s.a.token), body: JSON.stringify({ resolved: true }),
  });
  assert.equal(res.status, 404);
  s.close();
});
