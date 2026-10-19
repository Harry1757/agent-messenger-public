import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, findUserByToken, createUser } from '../server/db.ts';
import { buildApp } from '../server/routes.ts';

async function server() {
  const db = openDb(':memory:');
  const app = buildApp(db);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close(), db };
}

const JSON_H = { 'Content-Type': 'application/json' };

test('createUser 는 이름과 무작위 토큰을 돌려준다', () => {
  const db = openDb(':memory:');
  const u = createUser(db, '예제사용자', 'hunter2!!');
  assert.notEqual(u, null);
  assert.equal(u!.name, '예제사용자');
  assert.equal(u!.token.length >= 20, true, '토큰이 충분히 길어야 한다');
  assert.equal(findUserByToken(db, u!.token), '예제사용자');
});

test('두 사람의 토큰은 서로 다르다', () => {
  const db = openDb(':memory:');
  const a = createUser(db, '예제사용자', 'hunter2!!')!;
  const b = createUser(db, '예제동료', 'hunter2!!')!;
  assert.notEqual(a.token, b.token);
});

test('같은 이름으로 두 번 가입하면 null', () => {
  const db = openDb(':memory:');
  assert.notEqual(createUser(db, '예제사용자', 'hunter2!!'), null);
  assert.equal(createUser(db, '예제사용자', 'hunter2!!'), null);
});

test('가입은 인증 없이 된다', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/signup`, {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ name: '예제사용자', password: 'hunter2!!' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, '예제사용자');
  assert.equal(typeof body.token, 'string');
  s.close();
});

test('가입한 토큰으로 바로 API 를 쓸 수 있다', async () => {
  const s = await server();
  const { token } = await (await fetch(`${s.base}/api/signup`, {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ name: '예제사용자', password: 'hunter2!!' }),
  })).json();

  const res = await fetch(`${s.base}/api/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  s.close();
});

test('중복 이름 가입은 409', async () => {
  const s = await server();
  const body = JSON.stringify({ name: '예제사용자', password: 'hunter2!!' });
  await fetch(`${s.base}/api/signup`, { method: 'POST', headers: JSON_H, body });
  const res = await fetch(`${s.base}/api/signup`, { method: 'POST', headers: JSON_H, body });
  assert.equal(res.status, 409);
  s.close();
});

test('빈 이름 가입은 400', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/signup`, {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(res.status, 400);
  s.close();
});

test('@멘션에 쓸 수 없는 이름은 400', async () => {
  const s = await server();
  for (const name of ['김 철수', '예제사용자!', 'a@b']) {
    const res = await fetch(`${s.base}/api/signup`, {
      method: 'POST', headers: JSON_H, body: JSON.stringify({ name }),
    });
    assert.equal(res.status, 400, `${name} 은 거부되어야 한다`);
  }
  s.close();
});
