import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'messenger-sessions-'));
process.env.AGENT_MESSENGER_HOME = dir;
const {readSession, writeSession} = await import('../daemon/sessions.ts');
after(() => rmSync(dir, {recursive:true,force:true}));
test('같은 스레드의 Claude와 Codex 문맥을 따로 보관한다', () => {
  writeSession('thread-a', 'claude-session');
  assert.equal(readSession('thread-a', 'codex'), null);
  writeSession('thread-a', 'codex-session', 'codex');
  assert.equal(readSession('thread-a', 'claude'), 'claude-session');
  assert.equal(readSession('thread-a', 'codex'), 'codex-session');
});
