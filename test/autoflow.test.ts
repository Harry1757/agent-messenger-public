import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createThread, getThread } from '../server/db.ts';
import {
  MAX_AUTO_TURNS, MAX_AUTO_MS,
  shouldPause, onAgentMessage, onHumanMessage, resumeThread,
} from '../server/autoflow.ts';
import type { Thread } from '../shared/types.ts';

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't', title: 'x', createdAt: '2026-09-10T00:00:00.000Z',
    autoTurns: 0, autoStartedAt: null, paused: false, ...over,
  };
}

test('턴이 남아있고 시간도 안 지났으면 멈추지 않는다', () => {
  const now = new Date('2026-09-10T00:10:00.000Z');
  const t = thread({ autoTurns: 5, autoStartedAt: '2026-09-10T00:00:00.000Z' });
  assert.equal(shouldPause(t, now), false);
});

test('턴 상한에 닿으면 멈춘다', () => {
  const now = new Date('2026-09-10T00:01:00.000Z');
  const t = thread({ autoTurns: MAX_AUTO_TURNS, autoStartedAt: '2026-09-10T00:00:00.000Z' });
  assert.equal(shouldPause(t, now), true);
});

test('시간 상한을 넘기면 멈춘다', () => {
  const start = '2026-09-10T00:00:00.000Z';
  const now = new Date(Date.parse(start) + MAX_AUTO_MS);
  const t = thread({ autoTurns: 1, autoStartedAt: start });
  assert.equal(shouldPause(t, now), true);
});

test('시작 시각이 없으면 시간 기준으로는 멈추지 않는다', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  assert.equal(shouldPause(thread({ autoTurns: 1 }), now), false);
});

test('에이전트 메시지가 카운터를 올리고 첫 메시지가 시작 시각을 정한다', () => {
  const db = openDb(':memory:');
  const t = createThread(db, 'x');
  const now = new Date('2026-09-10T00:00:00.000Z');

  const a = onAgentMessage(db, t.id, now);
  assert.equal(a.autoTurns, 1);
  assert.equal(a.autoStartedAt, now.toISOString());
  assert.equal(a.paused, false);

  const b = onAgentMessage(db, t.id, new Date('2026-09-10T00:00:30.000Z'));
  assert.equal(b.autoTurns, 2);
  assert.equal(b.autoStartedAt, now.toISOString(), '시작 시각은 유지된다');
});

test('상한을 넘기면 paused 가 된다', () => {
  const db = openDb(':memory:');
  const t = createThread(db, 'x');
  let last = getThread(db, t.id)!;
  for (let i = 0; i < MAX_AUTO_TURNS; i++) {
    last = onAgentMessage(db, t.id, new Date('2026-09-10T00:00:00.000Z'));
  }
  assert.equal(last.autoTurns, MAX_AUTO_TURNS);
  assert.equal(last.paused, true);
});

test('사람이 말하면 카운터가 초기화되고 일시정지가 풀린다', () => {
  const db = openDb(':memory:');
  const t = createThread(db, 'x');
  for (let i = 0; i < MAX_AUTO_TURNS; i++) {
    onAgentMessage(db, t.id, new Date('2026-09-10T00:00:00.000Z'));
  }
  const after = onHumanMessage(db, t.id);
  assert.equal(after.autoTurns, 0);
  assert.equal(after.autoStartedAt, null);
  assert.equal(after.paused, false);
});

test('resumeThread 는 카운터를 초기화하고 재개한다', () => {
  const db = openDb(':memory:');
  const t = createThread(db, 'x');
  for (let i = 0; i < MAX_AUTO_TURNS; i++) {
    onAgentMessage(db, t.id, new Date('2026-09-10T00:00:00.000Z'));
  }
  const after = resumeThread(db, t.id);
  assert.equal(after.paused, false);
  assert.equal(after.autoTurns, 0);
});
