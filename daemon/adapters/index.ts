import { claude } from './claude.ts';
import { codex } from './codex.ts';

export interface AdapterArgs {
  prompt: string;
  threadId: string;
  /** 이 스레드에 저장된 세션 id. 없으면 새 세션. */
  sessionId: string | null;
  systemPrompt: string;
  /** 작업 디렉토리 외에 읽기를 허용할 저장소들 */
  addDirs: string[];
  /** 쓸 모델. 없거나 비어 있으면 플래그를 붙이지 않는다 — 도구 기본값을 쓴다. */
  model?: string | null;
}

export interface AdapterResult {
  ok: boolean;
  text: string;
  costUsd: number;
  /** 도구가 알려준 세션 id. 다음 호출에 쓴다. 없으면 null. */
  sessionId: string | null;
  error: string | null;
  observedModels?: string[];
  modelSource?: 'response' | 'session' | 'unavailable';
}

export interface Adapter {
  buildArgs(o: AdapterArgs): string[];
  parseOutput(stdout: string): AdapterResult;
  /**
   * 저장된 세션 id 를 잃어버렸을 때 되찾을 수 있는 id. 없으면 null.
   * claude 는 세션 id 를 우리가 정하므로 스레드 id 로 되찾을 수 있고,
   * codex 는 자기가 만든 id 를 우리가 알 길이 없다.
   * main.ts 의 자가 교정 재시도가 이 값을 쓴다.
   */
  resumeIdFor(threadId: string): string | null;
}

const ADAPTERS: Record<string, Adapter> = { claude, codex };

export function getAdapter(tool: string): Adapter {
  const adapter = Object.hasOwn(ADAPTERS, tool) ? ADAPTERS[tool] : undefined;
  if (adapter === undefined) {
    throw new Error(`알 수 없는 도구 "${tool}" — ${Object.keys(ADAPTERS).join(', ')} 중 하나여야 합니다`);
  }
  return adapter;
}
