import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getAdapter } from './adapters/index.ts';

export interface DaemonConfig {
  serverUrl: string;
  token: string;
  agentName: string;
  command: string;
  /** 'claude' | 'codex' — 어떤 CLI 를 쓸지. 없으면 command 의 파일 이름에서 유추한다. */
  tool: string;
  /** 도구에 넘길 모델 이름. 없으면 도구 기본값을 쓴다. 웹 설정이 이 값을 이긴다. */
  model?: string;
  /** 저장소를 찾을 작업 폴더. 문자열 하나 또는 여러 개. 첫 번째가 작업 디렉터리, 나머지는 addDirs. */
  workspace: string | string[];
}

export const DATA_DIR = process.env.AGENT_MESSENGER_HOME ?? join(homedir(), '.agent-messenger');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

/** 서버가 하나뿐이라 기본값을 준다. 다른 곳에 붙일 때만 설정에 적으면 된다. */
export const DEFAULT_SERVER_URL = 'http://localhost:3000';

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`설정 항목 "${key}" 가 없거나 비어 있습니다`);
  }
  return v.trim();
}

export function parseConfig(raw: unknown): DaemonConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('설정이 객체가 아닙니다');
  }
  const o = raw as Record<string, unknown>;

  // 옛 설정 형식(레포 이름→경로 지도)이 남아있으면 낯선 필드 누락 에러 대신
  // 무엇이 바뀌었고 무엇을 해야 하는지 바로 알려준다.
  if ('repos' in o) {
    throw new Error('설정 형식이 바뀌었습니다 ("repos" → "workspace") — npm run setup 을 실행해 새 형식으로 다시 만드세요.');
  }

  const workspace = o.workspace;
  const workspaceList = Array.isArray(workspace) ? workspace : [workspace];
  if (workspaceList.length === 0) {
    throw new Error('설정 항목 "workspace" 가 비어 있습니다');
  }
  for (const w of workspaceList) {
    if (typeof w !== 'string' || w.trim() === '') {
      throw new Error('설정 항목 "workspace" 가 문자열도 문자열 배열도 아닙니다');
    }
  }

  const command = typeof o.command === 'string' && o.command.trim() !== '' ? o.command.trim() : 'claude';
  // `/usr/local/bin/claude` → `claude`
  const tool = typeof o.tool === 'string' && o.tool.trim() !== '' ? o.tool.trim() : basename(command).replace(/\.(cmd|exe|bat)$/i, '');
  // 모르는 도구면 지금 던진다 — 데몬이 돌기 시작한 뒤 첫 질문에서 실패하는 것보다 낫다.
  getAdapter(tool);

  const model = typeof o.model === 'string' && o.model.trim() !== '' ? o.model.trim() : undefined;

  const serverUrl = typeof o.serverUrl === 'string' && o.serverUrl.trim() !== '' ? o.serverUrl.trim() : DEFAULT_SERVER_URL;
  const trimmedWorkspace = (workspaceList as string[]).map((w) => w.trim());

  return {
    serverUrl: serverUrl.replace(/\/+$/, ''),
    token: requireString(o, 'token'),
    agentName: requireString(o, 'agentName'),
    command,
    tool,
    ...(model === undefined ? {} : { model }),
    workspace: Array.isArray(workspace) ? trimmedWorkspace : trimmedWorkspace[0],
  };
}

export function loadConfig(path: string = CONFIG_PATH): DaemonConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`설정 파일을 읽을 수 없습니다: ${path}`);
  }
  return parseConfig(JSON.parse(text));
}
