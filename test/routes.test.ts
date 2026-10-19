import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertUser } from '../server/db.ts';
import { buildApp } from '../server/routes.ts';
import { MAX_AUTO_TURNS } from '../server/autoflow.ts';

async function server() {
  const db = openDb(':memory:');
  upsertUser(db, '예제사용자', 'tok-hsw');
  const app = buildApp(db);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return { base, close: () => srv.close(), db };
}

const AUTH = { Authorization: 'Bearer tok-hsw', 'Content-Type': 'application/json' };

test('토큰이 없으면 401', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/threads`);
  assert.equal(res.status, 401);
  s.close();
});

test('틀린 토큰이면 401', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/threads`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(res.status, 401);
  s.close();
});

test('스레드를 만들고 목록에서 본다', async () => {
  const s = await server();
  const created = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: '결제 API' }),
  })).json();
  assert.equal(created.title, '결제 API');

  const list = await (await fetch(`${s.base}/api/threads`, { headers: AUTH })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  s.close();
});

test('사람 메시지의 작성자는 토큰에서 정해진다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'x' }),
  })).json();

  const m = await (await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: '@예제동료 뭐예요?', author: '위조' }),
  })).json();

  assert.equal(m.author, '예제사용자', '본문의 author 는 무시한다');
  s.close();
});

test('에이전트 메시지는 본문의 author 를 쓴다 — 단, 토큰 계정과 같아야 한다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'x' }),
  })).json();

  const m = await (await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'agent', author: '예제사용자', kind: 'text', body: '답' }),
  })).json();

  assert.equal(m.author, '예제사용자');
  assert.equal(m.authorType, 'agent');
  s.close();
});

test('에이전트 메시지의 author 가 토큰 계정과 다르면 403 — 사칭 방지', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'x' }),
  })).json();

  const res = await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'agent', author: '예제동료', kind: 'text', body: '답' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /예제동료/);
  assert.match(body.error, /예제사용자/);
  s.close();
});

test('에이전트 메시지가 쌓이면 스레드가 일시정지된다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'x' }),
  })).json();

  for (let i = 0; i < MAX_AUTO_TURNS; i++) {
    await fetch(`${s.base}/api/threads/${t.id}/messages`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ authorType: 'agent', author: '예제사용자', kind: 'text', body: `답 ${i}` }),
    });
  }

  const list = await (await fetch(`${s.base}/api/threads`, { headers: AUTH })).json();
  assert.equal(list[0].paused, true);

  const resumed = await (await fetch(`${s.base}/api/threads/${t.id}/resume`, {
    method: 'POST', headers: AUTH,
  })).json();
  assert.equal(resumed.paused, false);
  assert.equal(resumed.autoTurns, 0);
  s.close();
});

test('일시정지된 스레드는 에이전트 메시지를 거부하고 사람 메시지는 받는다', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'x' }),
  })).json();

  const postAgent = () => fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'agent', author: '예제사용자', kind: 'text', body: '답' }),
  });

  for (let i = 0; i < MAX_AUTO_TURNS; i++) {
    assert.equal((await postAgent()).ok, true, `${i}번째는 통과해야 한다`);
  }

  // 상한을 넘긴 뒤에는 에이전트가 더 쓸 수 없다 — 체크포인트의 실제 강제 지점
  assert.equal((await postAgent()).status, 409);

  // 사람은 언제든 쓸 수 있고, 그 순간 일시정지가 풀린다
  const human = await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: '계속해' }),
  });
  assert.equal(human.ok, true);
  assert.equal((await postAgent()).ok, true, '사람이 말한 뒤에는 다시 통과한다');
  s.close();
});

test('없는 스레드에 메시지를 넣으면 404', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/threads/nope/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: 'x' }),
  });
  assert.equal(res.status, 404);
  s.close();
});

test('빈 본문은 400', async () => {
  const s = await server();
  const t = await (await fetch(`${s.base}/api/threads`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ title: 'x' }),
  })).json();
  const res = await fetch(`${s.base}/api/threads/${t.id}/messages`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ authorType: 'human', kind: 'text', body: '   ' }),
  });
  assert.equal(res.status, 400);
  s.close();
});
