import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertUser, getSettings, setSettings } from '../server/db.ts';
import { buildApp } from '../server/routes.ts';
import { resetAgents } from '../server/agents.ts';
import { resolveActive, shouldNotifyDecision } from '../daemon/state.ts';
import { getAdapter } from '../daemon/adapters/index.ts';

async function server() {
  resetAgents(); // 모듈 전역이라 테스트끼리 새지 않게 비우고 시작한다
  const db = openDb(':memory:');
  upsertUser(db, '예제사용자', 'tok-hsw');
  upsertUser(db, '예제동료', 'tok-sb');
  const srv = buildApp(db).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close(), db };
}

const HSW = { Authorization: 'Bearer tok-hsw', 'Content-Type': 'application/json' };
const SB = { Authorization: 'Bearer tok-sb', 'Content-Type': 'application/json' };

const REPORT = {
  online: true,
  availableTools: ['claude'],
  tool: 'claude',
  model: 'sonnet',
  busyThreadId: null,
  toolOk: true,
  toolError: null,
};

function postStatus(base: string, headers: Record<string, string>, body: unknown) {
  return fetch(`${base}/api/agent/status`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('상태를 올리면 목록에서 보인다', async () => {
  const s = await server();
  const posted = await (await postStatus(s.base, HSW, REPORT)).json();
  assert.equal(posted.state.user, '예제사용자');
  assert.equal(posted.state.online, true);
  assert.deepEqual(posted.state.availableTools, ['claude']);
  assert.equal(typeof posted.state.reportedAt, 'string');

  const { agents } = await (await fetch(`${s.base}/api/agents`, { headers: HSW })).json();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].user, '예제사용자');
  s.close();
});

test('상태는 자기 것만 쓸 수 있다 — 본문의 user 는 무시한다', async () => {
  const s = await server();
  await postStatus(s.base, SB, REPORT); // 예제동료의 데몬이 정상 가동 중

  // 예제사용자의 토큰으로 예제동료의 에이전트를 꺼졌다고 쓰려는 시도
  await postStatus(s.base, HSW, { ...REPORT, user: '예제동료', online: false, busyThreadId: 'x' });

  const { agents } = await (await fetch(`${s.base}/api/agents`, { headers: SB })).json();
  const sb = agents.find((a: { user: string }) => a.user === '예제동료');
  assert.equal(sb.online, true, '남의 상태는 건드리지 못한다');
  assert.equal(sb.busyThreadId, null);

  const hsw = agents.find((a: { user: string }) => a.user === '예제사용자');
  assert.equal(hsw.online, false, '본문의 값은 토큰의 계정에만 적용된다');
  s.close();
});

test('남의 상태도 목록에 보인다 — 남의 에이전트가 도는지 화면이 알아야 한다', async () => {
  const s = await server();
  await postStatus(s.base, HSW, REPORT);
  await postStatus(s.base, SB, { ...REPORT, busyThreadId: 'thread-1' });

  const { agents } = await (await fetch(`${s.base}/api/agents`, { headers: HSW })).json();
  const sb = agents.find((a: { user: string }) => a.user === '예제동료');
  assert.equal(sb.busyThreadId, null, '참여하지 않은 대화의 ID는 숨긴다');
  s.close();
});

test('도구를 쓸 수 없다는 보고가 그대로 전달된다 — 조용히 실패하지 않는다', async () => {
  const s = await server();
  await postStatus(s.base, HSW, {
    ...REPORT, toolOk: false, toolError: 'codex 가 이 기계에 설치되어 있지 않습니다',
  });
  const { agents } = await (await fetch(`${s.base}/api/agents`, { headers: HSW })).json();
  assert.equal(agents[0].toolOk, false);
  assert.match(agents[0].toolError, /codex/);
  s.close();
});

test('설정을 저장하면 다시 읽을 때 그대로 나온다', async () => {
  const s = await server();
  const saved = await (await fetch(`${s.base}/api/agent/settings`, {
    method: 'POST', headers: HSW, body: JSON.stringify({ tool: 'codex', model: 'opus' }),
  })).json();
  assert.deepEqual(saved, { tool: 'codex', model: 'opus' });

  const mine = await (await fetch(`${s.base}/api/agents`, { headers: HSW })).json();
  assert.deepEqual(mine.settings, { tool: 'codex', model: 'opus' });

  // 남의 설정은 보이지 않는다
  const theirs = await (await fetch(`${s.base}/api/agents`, { headers: SB })).json();
  assert.deepEqual(theirs.settings, { tool: null, model: null });
  s.close();
});

test('빈 값은 "정하지 않음"(null)으로 저장된다', async () => {
  const s = await server();
  await fetch(`${s.base}/api/agent/settings`, {
    method: 'POST', headers: HSW, body: JSON.stringify({ tool: 'claude', model: 'opus' }),
  });
  const cleared = await (await fetch(`${s.base}/api/agent/settings`, {
    method: 'POST', headers: HSW, body: JSON.stringify({ tool: 'claude', model: '' }),
  })).json();
  assert.deepEqual(cleared, { tool: 'claude', model: null });
  s.close();
});

test('잘못된 설정 값은 400', async () => {
  const s = await server();
  for (const bad of [{ tool: 'a b' }, { model: '../../etc' }, { tool: 'x'.repeat(41) }, { tool: 3 }]) {
    const res = await fetch(`${s.base}/api/agent/settings`, {
      method: 'POST', headers: HSW, body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  s.close();
});

test('설정은 DB 에 남는다 — 서버가 다시 떠도 고른 값이 유지된다', async () => {
  const db = openDb(':memory:');
  upsertUser(db, '예제사용자', 'tok-hsw');
  assert.deepEqual(getSettings(db, '예제사용자'), { tool: null, model: null });
  assert.deepEqual(setSettings(db, '예제사용자', { tool: 'codex', model: null }), { tool: 'codex', model: null });
  assert.deepEqual(getSettings(db, '예제사용자'), { tool: 'codex', model: null });
  assert.deepEqual(getSettings(db, '없는사람'), { tool: null, model: null }, '없는 사용자도 던지지 않는다');
});

test('데몬 SSE 연결이 끊기면 오프라인이 된다 — 갑자기 죽어도 화면이 안다', async () => {
  const s = await server();
  await postStatus(s.base, HSW, REPORT);

  // 데몬임을 밝히고 붙었다가 끊는다
  const ac = new AbortController();
  const es = await fetch(`${s.base}/api/events?token=tok-hsw&client=daemon`, { signal: ac.signal });
  assert.equal(es.ok, true);
  ac.abort();

  // close 이벤트가 서버에 닿을 시간을 준다
  for (let i = 0; i < 50; i++) {
    const { agents } = await (await fetch(`${s.base}/api/agents`, { headers: HSW })).json();
    if (agents[0].online === false) {
      assert.equal(agents[0].busyThreadId, null, '꺼진 데몬은 실행 중일 수 없다');
      s.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('데몬 연결이 끊겼는데도 온라인으로 남았다');
});

test('브라우저 연결이 끊겨도 데몬 상태는 그대로다', async () => {
  const s = await server();
  await postStatus(s.base, HSW, REPORT);

  // client=daemon 없이 붙는 것은 브라우저다
  const ac = new AbortController();
  await fetch(`${s.base}/api/events?token=tok-hsw`, { signal: ac.signal });
  ac.abort();
  await new Promise((r) => setTimeout(r, 100));

  const { agents } = await (await fetch(`${s.base}/api/agents`, { headers: HSW })).json();
  assert.equal(agents[0].online, true, '탭을 닫았다고 데몬이 꺼진 것은 아니다');
  s.close();
});

test('인증 없이는 상태를 올릴 수도 볼 수도 없다', async () => {
  const s = await server();
  assert.equal((await fetch(`${s.base}/api/agents`)).status, 401);
  assert.equal(
    (await fetch(`${s.base}/api/agent/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(REPORT),
    })).status,
    401,
  );
  s.close();
});

/* ---------------------------------------------- 데몬: 설정을 실제 실행값으로 푸는 규칙 */

const CONFIG = { tool: 'claude', command: '/usr/local/bin/claude' };
const NONE = { tool: null, model: null };

test('아무것도 안 고르면 설정 파일 그대로 — command 의 절대경로를 지킨다', () => {
  const a = resolveActive(CONFIG, NONE, ['claude', 'codex']);
  assert.equal(a.tool, 'claude');
  assert.equal(a.command, '/usr/local/bin/claude');
  assert.equal(a.model, 'claude-sonnet-5');
  assert.equal(a.toolOk, true);
});

test('설치된 다른 도구를 고르면 그 도구로 바뀐다', () => {
  const a = resolveActive(CONFIG, { tool: 'codex', model: null }, ['claude', 'codex']);
  assert.equal(a.tool, 'codex');
  assert.equal(a.command, 'codex');
  assert.equal(a.toolOk, true);
});

test('없는 도구를 고르면 조용히 실패하지 않고 이유를 남긴 채 원래 도구로 계속한다', () => {
  const a = resolveActive(CONFIG, { tool: 'codex', model: null }, ['claude']);
  assert.equal(a.toolOk, false);
  assert.match(a.toolError!, /codex/);
  assert.equal(a.tool, 'claude', '답이 끊기는 것이 가장 나쁘므로 실행은 계속한다');
  assert.equal(a.command, '/usr/local/bin/claude');
});

test('모르는 도구 이름이 와도 던지지 않는다 — 설정 하나로 데몬이 죽으면 안 된다', () => {
  const a = resolveActive(CONFIG, { tool: 'gemini', model: null }, ['claude']);
  assert.equal(a.toolOk, false);
  assert.equal(a.tool, 'claude');
});

test('모델은 웹 설정이 설정 파일을 이기고, 둘 다 없으면 명시된 도구별 모델', () => {
  const withFile = { ...CONFIG, model: 'opus' };
  assert.equal(resolveActive(withFile, NONE, ['claude']).model, 'opus');
  assert.equal(resolveActive(withFile, { tool: null, model: 'haiku' }, ['claude']).model, 'haiku');
  assert.equal(resolveActive(CONFIG, NONE, ['claude']).model, 'claude-sonnet-5');
});

test('모델이 있으면 어댑터가 --model 을 붙이고, 없으면 아예 붙이지 않는다', () => {
  const base = { prompt: '질문', threadId: 'uuid-1', systemPrompt: '시스템', addDirs: [], sessionId: null };
  for (const tool of ['claude', 'codex']) {
    const a = getAdapter(tool);
    const none = a.buildArgs({ ...base });
    assert.equal(none.includes('--model'), false, `${tool}: 모델이 없으면 플래그도 없다`);

    const args = a.buildArgs({ ...base, model: 'opus' });
    assert.equal(args[args.indexOf('--model') + 1], 'opus', `${tool}: 고른 모델이 넘어간다`);

    // 모델을 붙였다고 읽기 전용 보장이 흔들리면 안 된다
    const joined = args.join(' ');
    for (const bad of ['workspace-write', 'danger-full-access', '--full-auto', '--dangerously-skip-permissions']) {
      assert.equal(joined.includes(bad), false, `${tool}: ${bad} 가 들어가면 안 된다`);
    }
  }
});

test('판단 요청 알림은 담당자에게만 간다', () => {
  const decision = { kind: 'decision_request', author:'예제동료' };
  const thread = [
    { author: '예제사용자' },   // 물어본 사람
    { author: '예제동료' },   // 답한 에이전트
  ];
  assert.equal(shouldNotifyDecision(decision, thread, '예제사용자'), false, '다른 참여자에게 결정을 요구하지 않는다');
  assert.equal(shouldNotifyDecision(decision, thread, '예제동료'), true, '만든 쪽도 알림을 받는다');
  assert.equal(shouldNotifyDecision(decision, thread, '민수'), false, '참여하지 않은 사람은 받지 않는다');
});

test('판단 요청이 아니면 알리지 않는다', () => {
  for (const kind of ['text', 'decision_result']) {
    assert.equal(shouldNotifyDecision({ kind }, [{ author: '예제사용자' }], '예제사용자'), false, kind);
  }
});

test('도구 전환 때 이전 도구의 설정 모델이 새 도구에 넘어가지 않는다', () => {
  const config = {tool:'claude', command:'claude', model:'opus'};
  assert.equal(resolveActive(config, {tool:'codex',model:null}, ['claude','codex']).model, 'gpt-6-astra');
  assert.equal(resolveActive(config, {tool:'codex',model:'gpt-test'}, ['claude','codex']).model, 'gpt-test');
  assert.equal(resolveActive(config, {tool:'codex',model:'gpt-test'}, ['claude']).model, 'opus');
});

test('가입한 팀원은 데몬 없이도 표시하고 인증 정보는 공개하지 않는다', async () => {
  const s = await server();
  try {
    assert.equal((await fetch(`${s.base}/api/agents`)).status, 401);
    let data = await (await fetch(`${s.base}/api/agents`, {headers: HSW})).json();
    assert.deepEqual(data.members.map((m: {name:string}) => m.name).sort(), ['예제동료','예제사용자'].sort());
    assert.ok(data.members.every((m: object) => Object.keys(m).join(',') === 'name'));
    await fetch(`${s.base}/api/signup`, {method:'POST', headers:HSW, body:JSON.stringify({name:'새팀원',password:'test-password'})});
    data = await (await fetch(`${s.base}/api/agents`, {headers:HSW})).json();
    assert.ok(data.members.some((m: {name:string}) => m.name === '새팀원'));
  } finally { s.close(); s.db.close(); }
});
