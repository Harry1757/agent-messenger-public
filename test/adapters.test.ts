import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../daemon/adapters/index.ts';

const BASE = { prompt: '질문', sessionId: null, systemPrompt: '너는 예제동료의 에이전트다', addDirs: [] };

test('알 수 없는 도구는 던진다', () => {
  assert.throws(() => getAdapter('nonexistent'), /nonexistent/);
  assert.throws(() => getAdapter('toString'), /toString/);
  assert.throws(() => getAdapter('__proto__'), /__proto__/);
});

test('claude: 첫 호출은 --session-id, 이어가기는 --resume', () => {
  const a = getAdapter('claude');
  const first = a.buildArgs({ ...BASE, sessionId: null, threadId: 'uuid-1' });
  assert.equal(first.includes('--session-id'), true);
  assert.equal(first.includes('--resume'), false);

  const next = a.buildArgs({ ...BASE, sessionId: 'uuid-1', threadId: 'uuid-1' });
  assert.equal(next.includes('--resume'), true);
  assert.equal(next.includes('--session-id'), false);
});

test('claude: 읽기 전용 제한이 양쪽 경로에 붙는다', () => {
  const a = getAdapter('claude');
  for (const sessionId of [null, 'uuid-1']) {
    const args = a.buildArgs({ ...BASE, sessionId, threadId: 'uuid-1' });
    assert.equal(args.includes('--restricted'), true, `sessionId=${sessionId}`);
    assert.equal(args.includes('--tools'), true, `sessionId=${sessionId}`);
  }
});

test('codex: 첫 호출은 exec, 이어가기는 exec 옵션 뒤 resume <id>', () => {
  const a = getAdapter('codex');
  const first = a.buildArgs({ ...BASE, sessionId: null, threadId: 'uuid-1' });
  assert.equal(first[0], 'exec');
  assert.equal(first.includes('resume'), false);

  const next = a.buildArgs({ ...BASE, sessionId: 'sess-abc', threadId: 'uuid-1' });
  assert.equal(next[0], 'exec');
  const resume = next.indexOf('resume');
  assert.equal(next[resume + 1], 'sess-abc');
  assert.ok(next.indexOf('--sandbox') < resume, 'resume은 --sandbox를 받지 않으므로 exec 옵션으로 전달');
});

test('codex: --sandbox read-only 를 항상 명시한다', () => {
  const a = getAdapter('codex');
  for (const sessionId of [null, 'sess-abc']) {
    const args = a.buildArgs({ ...BASE, sessionId, threadId: 'uuid-1' });
    const at = args.indexOf('--sandbox');
    assert.notEqual(at, -1, `sessionId=${sessionId}`);
    assert.equal(args[at + 1], 'read-only', `sessionId=${sessionId}`);
  }
});

test('codex: 쓰기를 허용하는 값이 인자에 없다', () => {
  const a = getAdapter('codex');
  const args = a.buildArgs({ ...BASE, sessionId: null, threadId: 'uuid-1' }).join(' ');
  for (const bad of ['workspace-write', 'danger-full-access', '--full-auto']) {
    assert.equal(args.includes(bad), false, `${bad} 가 들어가면 안 된다`);
  }
});

test('codex: 시스템 프롬프트를 본문 앞에 붙인다 (전용 플래그가 없으므로)', () => {
  const a = getAdapter('codex');
  const args = a.buildArgs({ ...BASE, sessionId: null, threadId: 'uuid-1' });
  const joined = args.join('\n');
  assert.equal(joined.includes('너는 예제동료의 에이전트다'), true);
  assert.equal(joined.includes('질문'), true);
});

test('codex: JSONL 에서 최종 답과 세션 id 를 뽑는다', () => {
  const a = getAdapter('codex');
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-abc' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '답변입니다' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const r = a.parseOutput(stdout);
  assert.equal(r.ok, true);
  assert.equal(r.text, '답변입니다');
  assert.equal(r.sessionId, 'sess-abc');
});

test('codex: 마지막 agent_message 를 쓴다', () => {
  const a = getAdapter('codex');
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '중간' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '최종' } }),
  ].join('\n');
  assert.equal(a.parseOutput(stdout).text, '최종');
});

test('codex: turn.failed 와 error 는 실패로 본다', () => {
  const a = getAdapter('codex');
  for (const line of [
    JSON.stringify({ type: 'turn.failed', error: { message: '실패함' } }),
    JSON.stringify({ type: 'error', message: '터짐' }),
  ]) {
    const r = a.parseOutput(line);
    assert.equal(r.ok, false, line);
  }
});

test('codex: 깨진 줄이 섞여도 던지지 않는다', () => {
  const a = getAdapter('codex');
  const stdout = [
    '이건 JSON 이 아님',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '답' } }),
    '{"불완전',
  ].join('\n');
  const r = a.parseOutput(stdout);
  assert.equal(r.ok, true);
  assert.equal(r.text, '답');
});

test('codex: 빈 출력과 답 없는 출력은 실패', () => {
  const a = getAdapter('codex');
  assert.equal(a.parseOutput('').ok, false);
  assert.equal(a.parseOutput(JSON.stringify({ type: 'turn.completed' })).ok, false);
});

test('claude: 기존 계약이 그대로 유지된다', () => {
  const a = getAdapter('claude');
  const ok = a.parseOutput(JSON.stringify({ result: '답', total_cost_usd: 0.02, is_error: false }));
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '답');
  assert.equal(ok.costUsd, 0.02);

  for (const bad of ['', 'null', '123', 'Error: Session ID x is already in use.']) {
    assert.equal(a.parseOutput(bad).ok, false, bad);
  }
});
