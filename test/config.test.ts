import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, DEFAULT_SERVER_URL } from '../daemon/config.ts';

const valid = {
  serverUrl: 'http://localhost:3000',
  token: 'tok-hsw',
  agentName: '예제사용자',
  command: 'claude',
  workspace: '/Users/example-user/Desktop/agent-messenger',
};

test('올바른 설정을 통과시킨다', () => {
  const c = parseConfig(valid);
  assert.equal(c.agentName, '예제사용자');
  assert.equal(c.workspace, '/Users/example-user/Desktop/agent-messenger');
});

test('command 가 없으면 claude 로 채운다', () => {
  const { command, ...rest } = valid;
  assert.equal(parseConfig(rest).command, 'claude');
});

test('tool 이 없으면 command 의 파일 이름에서 유추한다', () => {
  assert.equal(parseConfig(valid).tool, 'claude');
  assert.equal(parseConfig({ ...valid, command: '/usr/local/bin/codex' }).tool, 'codex');
  assert.equal(parseConfig({ ...valid, command: '/opt/bin/claude', tool: 'codex' }).tool, 'codex');
});

test('모르는 도구는 설정 로드 시점에 던진다', () => {
  // 데몬이 돌기 시작한 뒤 첫 질문에서 실패하는 것보다 시작할 때 실패하는 편이 낫다.
  assert.throws(() => parseConfig({ ...valid, tool: 'gemini' }), /gemini/);
  assert.throws(() => parseConfig({ ...valid, command: '/usr/bin/gpt' }), /gpt/);
});

test('serverUrl 끝의 슬래시를 제거한다', () => {
  const c = parseConfig({ ...valid, serverUrl: 'http://x:3000/' });
  assert.equal(c.serverUrl, 'http://x:3000');
});

test('serverUrl 이 없으면 기본값을 쓴다', () => {
  const { serverUrl, ...rest } = valid;
  assert.equal(parseConfig(rest).serverUrl, DEFAULT_SERVER_URL);
});

test('필수 항목이 빠지면 던진다', () => {
  for (const key of ['token', 'agentName']) {
    const broken = { ...valid };
    delete (broken as Record<string, unknown>)[key];
    assert.throws(() => parseConfig(broken), new RegExp(key), `${key} 누락을 잡아야 한다`);
  }
});

test('workspace 가 없으면 던진다', () => {
  const { workspace, ...rest } = valid;
  assert.throws(() => parseConfig(rest), /workspace/);
});

test('workspace 가 문자열도 배열도 아니면 던진다', () => {
  assert.throws(() => parseConfig({ ...valid, workspace: 123 }), /workspace/);
});

test('workspace 가 빈 배열이면 던진다', () => {
  assert.throws(() => parseConfig({ ...valid, workspace: [] }), /workspace/);
});

test('workspace 배열의 항목이 문자열이 아니면 던진다', () => {
  assert.throws(() => parseConfig({ ...valid, workspace: ['/a', 123] }), /workspace/);
});

test('workspace 는 배열을 그대로 통과시킨다', () => {
  const c = parseConfig({ ...valid, workspace: ['/work/a', '/work/b'] });
  assert.deepEqual(c.workspace, ['/work/a', '/work/b']);
});

test('옛 repos 형식이 남아있으면 형식이 바뀌었다고 구체적으로 알려준다', () => {
  const old = { token: 'tok', agentName: '예제사용자', repos: { app: '/Users/example-user/app' } };
  assert.throws(() => parseConfig(old), /설정 형식이 바뀌었습니다/);
  assert.throws(() => parseConfig(old), /npm run setup/);
});

test('repos 와 workspace 가 둘 다 있어도 repos 를 우선 지적한다', () => {
  // 마이그레이션이 반쯤 된 설정도 낡은 흔적을 알려주는 편이 낫다 — 조용히 workspace 로
  // 넘어가면 사람이 repos 가 이제 무시되는지 모른 채 남겨둔다.
  assert.throws(() => parseConfig({ ...valid, repos: { app: '/x' } }), /설정 형식이 바뀌었습니다/);
});

test('public snapshot defaults to the local server', () => {
  assert.equal(DEFAULT_SERVER_URL, 'http://localhost:3000');
});
