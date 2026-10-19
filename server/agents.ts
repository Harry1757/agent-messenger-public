import type { AgentState } from '../shared/types.ts';

/**
 * 데몬이 보고한 상태를 사용자 이름으로 보관한다. **메모리에만 둔다** — 서버가 다시
 * 뜨면 비지만, 데몬은 SSE 가 끊기면 3초마다 다시 붙고 붙을 때마다 다시 보고하므로
 * 몇 초 안에 스스로 채워진다. 디스크에 남기면 서버가 죽어 있는 동안 실제로 꺼진
 * 데몬이 "연결됨"으로 남는 문제를 새로 만든다.
 */
const states = new Map<string, AgentState>();

/**
 * 사용자별로 붙어 있는 데몬 SSE 연결 수. 마지막 하나가 끊기면 그 데몬은 죽은 것이다.
 * 브라우저 탭도 같은 토큰으로 붙으므로(같은 사용자) 데몬임을 밝힌 연결만 센다.
 */
const daemonLinks = new Map<string, number>();

/** 데몬이 올리는 보고. user 는 여기 없다 — 호출부가 토큰의 계정으로만 정한다. */
export interface StatusReport {
  online: boolean;
  availableTools: string[];
  configuredTool?: string;
  configuredModel?: string | null;
  tool: string;
  model: string | null;
  busyThreadId: string | null;
  toolOk: boolean;
  toolError: string | null;
}

export function reportState(user: string, r: StatusReport): AgentState {
  const state: AgentState = { user, ...r, reportedAt: new Date().toISOString() };
  states.set(user, state);
  return state;
}

export function listStates(): AgentState[] {
  return [...states.values()];
}

export function getState(user: string): AgentState | null {
  return states.get(user) ?? null;
}

export function daemonConnected(user: string): void {
  daemonLinks.set(user, (daemonLinks.get(user) ?? 0) + 1);
}

/**
 * 데몬 연결 하나가 끊겼다. 그 사용자의 마지막 데몬 연결이었고 아직 온라인으로
 * 기록돼 있었다면 오프라인으로 바꾼 상태를 돌려준다 — 호출부가 방송한다.
 * 갑자기 죽은 데몬은 `online:false` 를 보낼 기회가 없으므로 이 경로가 유일한 신호다.
 */
export function daemonDisconnected(user: string): AgentState | null {
  const left = (daemonLinks.get(user) ?? 1) - 1;
  if (left > 0) {
    daemonLinks.set(user, left);
    return null;
  }
  daemonLinks.delete(user);

  const prev = states.get(user);
  if (prev === undefined || !prev.online) return null;
  const state: AgentState = {
    ...prev,
    online: false,
    busyThreadId: null,
    reportedAt: new Date().toISOString(),
  };
  states.set(user, state);
  return state;
}

/** 테스트가 모듈 전역을 비운다 — sse.ts 와 같은 이유로 전역 하나를 공유한다. */
export function resetAgents(): void {
  states.clear();
  daemonLinks.clear();
}
