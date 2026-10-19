import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeTool, detectTools, KNOWN_TOOLS } from '../daemon/doctor.ts';

const found = async () => ({ ok: true, out: 'v1.2.3' });
const missing = async () => ({ ok: false, out: 'command not found' });

test('설치된 도구는 ok 와 버전을 돌려준다', async () => {
  const p = await probeTool('claude', 'claude', found);
  assert.equal(p.ok, true);
  assert.equal(p.tool, 'claude');
  assert.equal(p.detail.includes('v1.2.3'), true);
});

test('없는 도구는 ok=false 와 이유를 돌려준다', async () => {
  const p = await probeTool('codex', 'codex', missing);
  assert.equal(p.ok, false);
  assert.equal(p.detail.trim() === '', false, '이유가 비어 있으면 안 된다');
});

test('probeTool 은 던지지 않는다', async () => {
  const explodes = async () => { throw new Error('spawn EACCES'); };
  const p = await probeTool('claude', 'claude', explodes);
  assert.equal(p.ok, false);
  assert.equal(p.detail.includes('EACCES'), true);
});

test('모르는 도구 이름은 ok=false', async () => {
  const p = await probeTool('없는도구', '없는도구', found);
  assert.equal(p.ok, false);
});

test('command 가 tool 과 다르면 실제로는 command 를 실행한다', async () => {
  // config.ts 는 tool(어댑터 선택)과 command(실행 파일)가 다를 수 있다고 명시한다 —
  // 사전 점검은 반드시 command 를 실행해야 한다. 그렇지 않으면 흔한 이름(tool)은
  // 있는데 실제 설정된 실행 파일(command)은 없는 경우를 놓친다.
  let ranWith: string | null = null;
  const p = await probeTool('claude', '/opt/bin/claude-beta', async (cmd) => {
    ranWith = cmd;
    return { ok: true, out: 'v9.9.9' };
  });
  assert.equal(ranWith, '/opt/bin/claude-beta');
  assert.equal(p.command, '/opt/bin/claude-beta');
  assert.equal(p.tool, 'claude');
  assert.equal(p.ok, true);
});

test('command 를 생략하면 tool 을 실행한다', async () => {
  let ranWith: string | null = null;
  await probeTool('claude', undefined, async (cmd) => {
    ranWith = cmd;
    return { ok: true, out: 'v1' };
  });
  assert.equal(ranWith, 'claude');
});

test('detectTools 는 알려진 도구를 모두 조사한다', async () => {
  const probes = await detectTools(async (cmd) => ({ ok: cmd === 'claude', out: 'v1' }));
  assert.equal(probes.length, KNOWN_TOOLS.length);
  assert.equal(probes.find((p) => p.tool === 'claude')!.ok, true);
  assert.equal(probes.find((p) => p.tool === 'codex')!.ok, false);
});

test('KNOWN_TOOLS 는 어댑터가 있는 도구와 일치한다', async () => {
  const { getAdapter } = await import('../daemon/adapters/index.ts');
  for (const tool of KNOWN_TOOLS) {
    assert.doesNotThrow(() => getAdapter(tool), `${tool} 어댑터가 있어야 한다`);
  }
});
