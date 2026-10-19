import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

const DIR = join(DATA_DIR, 'sessions');

/**
 * 스레드마다 파일 하나에 세션 id 문자열. 파일 하나 = 스레드 하나라 읽고-쓰기 경합이 없다.
 * 없거나 비어 있으면 새 세션으로 시작한다(예전 빈 표시 파일도 여기로 걸러진다).
 */
export function readSession(threadId: string, tool = 'claude'): string | null {
  let text: string;
  try {
    text = readFileSync(join(DIR, tool === 'claude' ? threadId : `${threadId}.${tool}`), 'utf8');
  } catch {
    return null;
  }
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

export function writeSession(threadId: string, sessionId: string, tool = 'claude'): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, tool === 'claude' ? threadId : `${threadId}.${tool}`), sessionId);
}
