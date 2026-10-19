import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createUser, verifyLogin, findUserByToken, setPassword } from '../server/db.ts';
import { buildApp } from '../server/routes.ts';

async function server() {
  const db = openDb(':memory:');
  const app = buildApp(db);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close(), db };
}
const H = { 'Content-Type': 'application/json' };

test('비밀번호는 평문으로 저장되지 않는다', () => {
  const db = openDb(':memory:');
  createUser(db, '예제사용자', 'hunter2!!');
  const row = db.prepare('SELECT password_hash FROM users WHERE name = ?').get('예제사용자') as Record<string, unknown>;
  const stored = String(row.password_hash);
  assert.equal(stored.includes('hunter2!!'), false);
  assert.equal(stored.length > 40, true);
});

test('같은 비밀번호라도 해시가 다르다 (솔트)', () => {
  const db = openDb(':memory:');
  createUser(db, '예제사용자', 'samepass1');
  createUser(db, '예제동료', 'samepass1');
  const get = (n: string) => String((db.prepare('SELECT password_hash FROM users WHERE name = ?').get(n) as Record<string, unknown>).password_hash);
  assert.notEqual(get('예제사용자'), get('예제동료'));
});

test('맞는 비밀번호는 가입 때와 같은 토큰을 돌려준다', () => {
  const db = openDb(':memory:');
  const created = createUser(db, '예제사용자', 'hunter2!!')!;
  const login = verifyLogin(db, '예제사용자', 'hunter2!!');
  assert.notEqual(login, null);
  assert.equal(login!.token, created.token);
});

test('틀린 비밀번호와 없는 이름은 모두 null', () => {
  const db = openDb(':memory:');
  createUser(db, '예제사용자', 'hunter2!!');
  assert.equal(verifyLogin(db, '예제사용자', '틀린비번임'), null);
  assert.equal(verifyLogin(db, '없는사람', 'hunter2!!'), null);
});

// Task 17 리뷰가 남긴 지적: 없는 이름은 해싱 전에 단락해 응답 시간으로 존재 여부가
// 샌다. 여기서는 타이밍 자체가 아니라(CI 에서 불안정하다) 단락 경로가 없어졌다는
// 코드 구조만 고정한다 — 없는 이름도 여전히 null 이고 던지지 않는다.
test('없는 이름의 verifyLogin 도 여전히 null 이고 던지지 않는다', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => assert.equal(verifyLogin(db, '없는사람', '아무비번임12'), null));
});

test('setPassword 는 비밀번호만 바꾸고 토큰은 유지한다', () => {
  const db = openDb(':memory:');
  const created = createUser(db, '예제사용자', 'oldpass12')!;
  assert.equal(setPassword(db, '예제사용자', 'newpass12'), true);
  assert.equal(verifyLogin(db, '예제사용자', 'oldpass12'), null);
  assert.equal(verifyLogin(db, '예제사용자', 'newpass12')!.token, created.token);
  assert.equal(setPassword(db, '없는사람', 'x12345678'), false);
});

test('가입에 비밀번호가 없거나 짧으면 400', async () => {
  const s = await server();
  for (const body of [{ name: '예제사용자' }, { name: '예제사용자', password: '짧음' }]) {
    const res = await fetch(`${s.base}/api/signup`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  s.close();
});

test('가입 → 로그인 → 같은 토큰', async () => {
  const s = await server();
  const signup = await (await fetch(`${s.base}/api/signup`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: '예제사용자', password: 'hunter2!!' }),
  })).json();

  const login = await (await fetch(`${s.base}/api/login`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: '예제사용자', password: 'hunter2!!' }),
  })).json();

  assert.equal(login.token, signup.token, '토큰을 잃어버려도 비밀번호로 되찾는다');
  assert.equal(login.name, '예제사용자');
  s.close();
});

test('틀린 비밀번호와 없는 이름은 같은 401 을 준다', async () => {
  const s = await server();
  await fetch(`${s.base}/api/signup`, { method: 'POST', headers: H, body: JSON.stringify({ name: '예제사용자', password: 'hunter2!!' }) });

  const wrong = await fetch(`${s.base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ name: '예제사용자', password: '틀린비번임' }) });
  const missing = await fetch(`${s.base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ name: '없는사람', password: 'hunter2!!' }) });

  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await wrong.json(), await missing.json(), '어떤 이름이 있는지 알려주면 안 된다');
  s.close();
});

test('로그인은 인증 없이 닿을 수 있다', async () => {
  const s = await server();
  const res = await fetch(`${s.base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'x', password: 'y12345678' }) });
  assert.notEqual(res.status, 404);
  s.close();
});

test('받은 토큰은 기존처럼 API 인증에 쓰인다', async () => {
  const s = await server();
  const { token } = await (await fetch(`${s.base}/api/signup`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: '예제사용자', password: 'hunter2!!' }),
  })).json();
  assert.equal(findUserByToken(s.db, token), '예제사용자');
  const res = await fetch(`${s.base}/api/threads`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  s.close();
});

test('비밀번호 없는 기존 사용자도 토큰으로는 계속 쓸 수 있다', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (name, token) VALUES (?, ?)').run('옛사람', 'old-token');
  assert.equal(findUserByToken(db, 'old-token'), '옛사람');
  assert.equal(verifyLogin(db, '옛사람', '아무비번임'), null);
  assert.equal(setPassword(db, '옛사람', 'newpass12'), true);
  assert.equal(verifyLogin(db, '옛사람', 'newpass12')!.token, 'old-token');
});
