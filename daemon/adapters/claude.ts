import type { Adapter, AdapterArgs, AdapterResult } from './index.ts';

/**
 * 1단계 도구 목록. 읽기와 읽기 전용 git 만 허용한다.
 * Write / Edit / 일반 Bash 는 절대 넣지 않는다 — 승인 없는 코드 변경 경로가 생긴다.
 */
export const READ_ONLY_TOOLS =
  'Read Grep Glob Bash(git log:*) Bash(git blame:*) Bash(git diff:*) Bash(git show:*) Bash(gh pr view:*)';

function buildArgs(o: AdapterArgs): string[] {
  return [
    '-p', o.prompt,
    ...(o.sessionId === null ? ['--session-id', o.threadId] : ['--resume', o.sessionId]),
    '--output-format', 'json',
    '--restricted',
    '--tools', READ_ONLY_TOOLS,
    '--append-system-prompt', o.systemPrompt,
    ...(o.model ? ['--model', o.model] : []),
    ...(o.addDirs.length > 0 ? ['--add-dir', ...o.addDirs] : []),
  ];
}

function parseOutput(stdout: string): AdapterResult {
  const fail = (error: string): AdapterResult =>
    ({ ok: false, text: '', costUsd: 0, sessionId: null, error });

  const trimmed = stdout.trim();
  if (trimmed === '') return fail('출력이 비어 있습니다');

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // CLI 자체가 실패하면 JSON 이 아니라 평문 에러가 나온다.
    return fail(trimmed.slice(0, 500));
  }

  // JSON 이지만 객체가 아닌 경우도 실패로 본다.
  // 특히 `null` 은 걸러내지 않으면 아래 속성 접근에서 TypeError 가 나고,
  // 그 예외가 execFile 콜백 안에서 터져 runAgent 의 Promise 가 영영 풀리지 않는다.
  // Node 에서 콜백 내 미처리 예외는 프로세스를 죽이므로 데몬 전체가 내려간다.
  if (typeof raw !== 'object' || raw === null) {
    return fail(`예상치 못한 출력 형식: ${trimmed.slice(0, 200)}`);
  }
  const parsed = raw as Record<string, unknown>;

  const cost = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
  if (parsed.is_error === true) {
    return { ok: false, text: '', costUsd: cost, sessionId, error: String(parsed.result ?? '에이전트 오류') };
  }
  const text = typeof parsed.result === 'string' ? parsed.result : '';
  if (text.trim() === '') return fail('답변이 비어 있습니다');

  const observedModels = parsed.modelUsage && typeof parsed.modelUsage === 'object'
    ? Object.keys(parsed.modelUsage).filter(name => name.startsWith('claude-')) : [];
  return { ok: true, text, costUsd: cost, sessionId, error: null,
    ...(observedModels.length ? {observedModels, modelSource:'response' as const} : {}) };
}

export const claude: Adapter = {
  buildArgs,
  parseOutput,
  // 세션 id 를 우리가 정하므로(`--session-id <threadId>`) 스레드 id 로 되찾는다.
  resumeIdFor: (threadId) => threadId,
};
