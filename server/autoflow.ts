import type { DatabaseSync } from 'node:sqlite';
import type { Thread } from '../shared/types.ts';
import { getThread } from './db.ts';

export const MAX_AUTO_TURNS = 20;
export const MAX_AUTO_MS = 30 * 60 * 1000;

/** 사람 확인 없이 자동으로 너무 오래 진행됐는지 판정한다. */
export function shouldPause(t: Thread, now: Date): boolean {
  if (t.autoTurns >= MAX_AUTO_TURNS) return true;
  if (t.autoStartedAt !== null && now.getTime() - Date.parse(t.autoStartedAt) >= MAX_AUTO_MS) {
    return true;
  }
  return false;
}

/** 에이전트가 메시지를 쓴 뒤 호출한다. 카운터를 올리고 필요하면 일시정지한다. */
export function onAgentMessage(db: DatabaseSync, threadId: string, now: Date = new Date()): Thread {
  db.prepare(
    `UPDATE threads
       SET auto_turns = auto_turns + 1,
           auto_started_at = COALESCE(auto_started_at, ?)
     WHERE id = ?`,
  ).run(now.toISOString(), threadId);

  const t = getThread(db, threadId);
  if (t === null) throw new Error(`스레드를 찾을 수 없음: ${threadId}`);

  if (shouldPause(t, now)) {
    db.prepare('UPDATE threads SET paused = 1 WHERE id = ?').run(threadId);
    return { ...t, paused: true };
  }
  return t;
}

/**
 * 사람이 메시지를 쓴 뒤 호출한다. 자동 진행 상태를 완전히 초기화하고,
 * 해결됨 상태였다면 다시 연다 — 다시 묻고 있다면 해결된 것이 아니다.
 * 에이전트 메시지는 이 함수를 거치지 않으므로(onAgentMessage) 해결 상태를 건드리지 않는다.
 */
export function onHumanMessage(db: DatabaseSync, threadId: string): Thread {
  db.prepare(
    'UPDATE threads SET auto_turns = 0, auto_started_at = NULL, paused = 0, resolved = 0 WHERE id = ?',
  ).run(threadId);
  const t = getThread(db, threadId);
  if (t === null) throw new Error(`스레드를 찾을 수 없음: ${threadId}`);
  return t;
}

/** "계속 진행할까요?" 에 사람이 계속을 누르면 호출한다. */
export function resumeThread(db: DatabaseSync, threadId: string): Thread {
  return onHumanMessage(db, threadId);
}
