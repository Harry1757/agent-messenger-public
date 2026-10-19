import type { AgentSettings } from '../shared/types.ts';

export interface ActiveTool {
  tool: string;
  /** 실제로 실행할 명령. 설정 파일에 적힌 도구를 그대로 쓸 때만 config.command 를 존중한다. */
  command: string;
  model: string | null;
  /** 웹에서 고른 도구를 실제로 쓸 수 있는가 */
  toolOk: boolean;
  toolError: string | null;
}

interface ToolConfig {
  tool: string;
  command: string;
  model?: string;
}

/**
 * 웹에서 고른 설정과 이 기계의 사정을 합쳐 다음 실행에 쓸 값을 정한다.
 *
 * 고른 도구가 이 기계에 없으면 **조용히 실패하지 않는다** — 쓸 수 없다는 사실을
 * toolOk/toolError 로 남기고(데몬이 그대로 서버에 보고해 화면에 뜬다) 실행 자체는
 * 원래 설정된 도구로 계속한다. 답이 아예 끊기는 것이 가장 나쁜 결과이기 때문이다.
 *
 * 던지지 않는다 — 서버가 보내는 값은 무엇이든 올 수 있고, 설정 하나 때문에
 * 데몬이 죽으면 그 사람의 모든 질문이 사라진다.
 */
export const DEFAULT_MODELS: Record<string,string> = {claude:'claude-sonnet-5',codex:'gpt-6-astra'};

export function resolveActive(
  config: ToolConfig,
  settings: AgentSettings,
  availableTools: string[],
): ActiveTool {
  const desired = settings.tool ?? config.tool;
  const model = settings.model ?? (desired === config.tool ? config.model : undefined) ?? DEFAULT_MODELS[desired] ?? null;

  // 설정 파일의 도구 그대로 — command 가 절대경로일 수 있으므로 그것을 쓴다.
  if (desired === config.tool) {
    return { tool: config.tool, command: config.command, model, toolOk: true, toolError: null };
  }
  // 다른 도구로 바꾸려면 이 기계에서 실제로 실행되는 것이 확인돼 있어야 한다.
  // availableTools 는 `<이름> --version` 이 성공한 것들이므로 이름이 곧 명령이다.
  if (availableTools.includes(desired)) {
    return { tool: desired, command: desired, model, toolOk: true, toolError: null };
  }
  return {
    tool: config.tool,
    command: config.command,
    model: config.model ?? DEFAULT_MODELS[config.tool] ?? null,
    toolOk: false,
    toolError: `선택한 도구 "${desired}" 를 이 기계에서 실행할 수 없습니다 — ${config.tool} 로 계속합니다`,
  };
}

/** 결정 요청은 담당 에이전트의 소유자에게만 알린다. */
export function shouldNotifyDecision(
  message: { kind: string; author?: string },
  _threadMessages: { author: string }[],
  me: string,
): boolean {
  return message.kind === 'decision_request' && message.author === me;
}

/** 에이전트 호출은 사람을 호출하는 알림이 아니다. 결정·완료 알림은 별도 처리한다. */
export function shouldNotifyQuestion(author: string, me: string): boolean {
  return false;
}
