import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claude, READ_ONLY_TOOLS } from '../daemon/adapters/claude.ts';
import { codex } from '../daemon/adapters/codex.ts';

const { buildArgs, parseOutput } = claude;
const SYS = '당신은 예제사용자님의 에이전트입니다.';
const BASE = { prompt: '질문', threadId: 'uuid-1', systemPrompt: SYS, addDirs: [] };

test('첫 호출은 --session-id 를 쓴다', () => {
  const args = buildArgs({ ...BASE, sessionId: null });
  assert.equal(args.includes('--session-id'), true);
  assert.equal(args.includes('--resume'), false);
  assert.equal(args[args.indexOf('--session-id') + 1], 'uuid-1');
});

test('이어가기는 --resume 을 쓴다', () => {
  const args = buildArgs({ ...BASE, sessionId: 'uuid-1' });
  assert.equal(args.includes('--resume'), true);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args[args.indexOf('--resume') + 1], 'uuid-1');
});

test('읽기 전용 제한이 항상 붙는다', () => {
  for (const sessionId of [null, 'uuid-1']) {
    const args = buildArgs({ ...BASE, sessionId });
    assert.equal(args.includes('--restricted'), true, `sessionId=${sessionId}`);
    assert.equal(args[args.indexOf('--tools') + 1], READ_ONLY_TOOLS, `sessionId=${sessionId}`);
  }
});

test('추가 저장소는 --add-dir 로 붙는다', () => {
  const none = buildArgs({ ...BASE, sessionId: null });
  assert.equal(none.includes('--add-dir'), false, '추가 저장소가 없으면 플래그도 없다');

  const args = buildArgs({ ...BASE, sessionId: null, addDirs: ['/work/앱', '/work/배치'] });
  const at = args.indexOf('--add-dir');
  assert.notEqual(at, -1);
  assert.deepEqual(args.slice(at + 1, at + 3), ['/work/앱', '/work/배치']);
});

test('읽기 전용 목록에 쓰기 도구가 없다', () => {
  for (const forbidden of ['Write', 'Edit', 'NotebookEdit']) {
    assert.equal(READ_ONLY_TOOLS.includes(forbidden), false, `${forbidden} 이 들어있으면 안 된다`);
  }
});

test('성공 출력에서 답과 비용과 세션 id 를 꺼낸다', () => {
  const stdout = JSON.stringify({
    result: '결제 승인 엔드포인트는 POST /payments/approve 입니다.',
    total_cost_usd: 0.0356,
    is_error: false,
    session_id: 'uuid-1',
  });
  const r = parseOutput(stdout);
  assert.equal(r.ok, true);
  assert.equal(r.text, '결제 승인 엔드포인트는 POST /payments/approve 입니다.');
  assert.equal(r.costUsd, 0.0356);
  assert.equal(r.sessionId, 'uuid-1');
  assert.equal(r.error, null);
});

test('is_error 가 참이면 실패로 본다', () => {
  const stdout = JSON.stringify({ result: '어쩌구', total_cost_usd: 0.01, is_error: true });
  const r = parseOutput(stdout);
  assert.equal(r.ok, false);
  assert.notEqual(r.error, null);
});

test('JSON 이 아닌 출력은 실패로 본다', () => {
  const r = parseOutput('Error: Session ID uuid-1 is already in use.');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /already in use/);
  assert.equal(r.costUsd, 0);
});

test('빈 출력도 실패로 본다', () => {
  const r = parseOutput('');
  assert.equal(r.ok, false);
});

test('JSON 이지만 객체가 아닌 출력도 던지지 않고 실패로 본다', () => {
  // `null` 은 그냥 두면 속성 접근에서 TypeError 를 던지고, 그 예외가
  // execFile 콜백 안에서 터져 runAgent 의 Promise 를 영영 미결로 만든다.
  for (const input of ['null', '123', '"문자열"']) {
    const r = parseOutput(input);
    assert.equal(r.ok, false, `${input} 은 실패여야 한다`);
    assert.equal(r.costUsd, 0, `${input} 의 비용은 0이어야 한다`);
  }
});

test('세션 id 를 잃어버렸을 때 claude 만 되찾을 수 있다', () => {
  // main.ts 의 자가 교정 재시도가 쓰는 값. claude 는 id 를 우리가 정하므로 스레드 id 로
  // 이어갈 수 있고, codex 는 자기가 만든 id 라 되찾을 방법이 없다(재시도하지 않는다).
  assert.equal(claude.resumeIdFor('uuid-1'), 'uuid-1');
  assert.equal(codex.resumeIdFor('uuid-1'), null);
});
