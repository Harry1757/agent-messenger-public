export interface ExecutionInfo {
  tool: string;
  requestedModel: string | null;
  observedModels: string[];
  source: 'response' | 'session' | 'unavailable';
}

export type AuthorType = 'human' | 'agent';

export type MessageKind = 'text' | 'decision_request' | 'decision_result' | 'summary';

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  autoTurns: number;
  autoStartedAt: string | null;
  paused: boolean;
  resolved: boolean;
}

export interface Message {
  id: number;
  threadId: string;
  author: string;
  authorType: AuthorType;
  kind: MessageKind;
  body: string;
  createdAt: string;
  /** 지정되어 있으면 이 이름의 사용자에게만 보인다. null 이면 공개. */
  privateTo: string | null;
  decisionRequestId?: number | null;
  execution?: ExecutionInfo;
  direct?: boolean;
  agentTarget?: string;
  agentAction?: 'request'|'reply';
  replyTo?: number;
  resourceAudience?: string[];
  resourcePolicyIds?: string[];
}

export interface NewMessage {
  threadId: string;
  author: string;
  authorType: AuthorType;
  kind: MessageKind;
  body: string;
  privateTo?: string | null;
  decisionRequestId?: number | null;
  execution?: ExecutionInfo;
  direct?: boolean;
  agentTarget?: string;
  agentAction?: 'request'|'reply';
  replyTo?: number;
  resourceAudience?: string[];
  resourcePolicyIds?: string[];
}

/** kind === 'decision_request' 일 때 body 를 JSON.parse 한 결과 */
export interface DecisionRequest {
  question: string;
  options: string[];
  summary?: string;
  recommendation?: string;
}

/**
 * 데몬이 서버에 올리는 자기 기계의 사정. 화면이 "답하는 중"과 "꺼짐"을 추측하지 않고
 * 사실로 알게 하는 통로다. 서버는 본문의 이름을 믿지 않고 토큰의 계정으로 기록한다.
 */
export interface AgentState {
  /** 데몬을 돌리는 계정 이름 (= agentName) */
  user: string;
  online: boolean;
  /** 그 기계에서 `--version` 실행까지 확인된 도구들 */
  availableTools: string[];
  configuredTool?: string;
  configuredModel?: string | null;
  /** 지금 쓰고 있는 도구 */
  tool: string;
  /** 지금 쓰고 있는 모델. null 이면 도구 기본값. */
  model: string | null;
  /** 실행 중인 스레드 id. null 이면 놀고 있다. */
  busyThreadId: string | null;
  /** 요청된 도구를 실제로 쓸 수 있는가. false 면 이유가 toolError 에 있다 — 조용히 실패하지 않는다. */
  toolOk: boolean;
  toolError: string | null;
  /** 마지막 보고 시각 (ISO) */
  reportedAt: string;
}

/** 서버가 보관하는 사용자별 에이전트 설정. null 은 "정하지 않음" — 데몬 자기 설정을 따른다. */
export interface AgentSettings {
  tool: string | null;
  model: string | null;
}

export type ServerEvent =
  | { type: 'threads-changed' }
  | { type: 'resources-changed'; owner:string }
  | { type: 'tasks-changed'; threadId:string }
  | { type: 'thread-hidden'; threadId:string }
  | { type: 'members'; members: {name:string}[] }
  | { type: 'message'; message: Message }
  | { type: 'thread'; thread: Thread }
  /** 누구의 에이전트든 상태가 바뀌면 전원에게 — 남의 에이전트가 도는지도 화면에 보여야 한다. */
  | { type: 'agent'; state: AgentState }
  /** 설정은 그 사람의 데몬과 그 사람의 화면에만 간다 (broadcast 의 onlyFor). */
  | { type: 'settings'; settings: AgentSettings };
