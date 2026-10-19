import type { Adapter, AdapterArgs, AdapterResult } from './index.ts';

/**
 * codex 는 기본값이 이미 read-only 지만 보안 보장을 기본값에 기대지 않는다.
 * 버전이 바뀌거나 사용자 config.toml 이 덮어쓸 수 있다. 쓰기 차단은 이 제품의
 * 1단계 약속 전부이므로 새 세션이든 이어가기든 항상 명시적으로 넘긴다.
 */
const READ_ONLY_FLAGS = ['--json', '--sandbox', 'read-only', '--skip-git-repo-check'];

/**
 * codex-cli 0.153.4의 exec/resume 도움말에서 --model 지원을 확인했다.
 */
function modelFlags(model: string | null | undefined): string[] {
  return model ? ['--model', model] : [];
}

function buildArgs(o: AdapterArgs): string[] {
  // codex 에는 --append-system-prompt 같은 전용 플래그가 없다. 본문 앞에 붙인다.
  // 이어가기에도 붙인다 — 규칙(멘션·DECISION 형식)이 턴마다 살아 있어야 한다.
  const preamble = o.addDirs.length > 0
    ? `${o.systemPrompt}\n추가로 읽을 수 있는 저장소: ${o.addDirs.join(', ')}`
    : o.systemPrompt;
  const prompt = `${preamble}\n\n${o.prompt}`;

  const flags = [...READ_ONLY_FLAGS, ...modelFlags(o.model)];
  return o.sessionId === null
    ? ['exec', ...flags, prompt]
    : ['exec', ...flags, 'resume', o.sessionId, prompt];
}

function messageOf(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'object' && v !== null) {
    const m = (v as Record<string, unknown>).message;
    if (typeof m === 'string' && m.trim() !== '') return m;
  }
  return fallback;
}

/**
 * `--json` 은 JSONL 을 뱉는다. 한 줄이라도 깨져 있을 수 있으므로 줄 단위로 흘려보낸다.
 * 어떤 입력에도 던지지 않는다 — execFile 콜백 안의 예외는 데몬을 통째로 죽인다.
 */
function parseOutput(stdout: string): AdapterResult {
  let sessionId: string | null = null;
  let text = '';
  let error: string | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue; // 로그 줄이나 잘린 줄. 버린다.
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as Record<string, unknown>;

    if (event.type === 'thread.started') {
      if (typeof event.thread_id === 'string') sessionId = event.thread_id;
    } else if (event.type === 'item.completed') {
      const item = event.item;
      if (typeof item === 'object' && item !== null) {
        const it = item as Record<string, unknown>;
        // 마지막 agent_message 가 최종 답이다.
        if (it.type === 'agent_message' && typeof it.text === 'string') text = it.text;
      }
    } else if (event.type === 'turn.failed') {
      error = messageOf(event.error, '턴이 실패했습니다');
    } else if (event.type === 'error') {
      error = messageOf(event.message, '에이전트 오류');
    }
  }

  if (error !== null) return { ok: false, text: '', costUsd: 0, sessionId, error };
  if (text.trim() === '') {
    const why = stdout.trim() === '' ? '출력이 비어 있습니다'
      : `답변이 비어 있습니다: ${stdout.trim().slice(-1500)}`;
    return { ok: false, text: '', costUsd: 0, sessionId, error: why };
  }
  // JSONL 에 비용 정보가 없다. 0 으로 둔다.
  return { ok: true, text, costUsd: 0, sessionId, error: null };
}

export const codex: Adapter = {
  buildArgs,
  parseOutput,
  // 세션 id 를 codex 가 만들므로 잃어버리면 되찾을 수 없다.
  resumeIdFor: () => null,
};
