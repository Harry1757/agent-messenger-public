import {githubLogin} from './github-access.ts';
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { detectTools } from './doctor.ts';
import { CONFIG_PATH, DEFAULT_SERVER_URL, parseConfig } from './config.ts';
import type { DaemonConfig } from './config.ts';
import { findRepos } from './workspace.ts';

function readExisting(): DaemonConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return null;
  }
}

function yes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, def?: string): Promise<string> => {
    const suffix = def ? ` [${def}]` : '';
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    return answer === '' ? (def ?? '') : answer;
  };

  try {
    console.log('설치된 도구 확인 중...\n');
    const probes = await detectTools();
    for (const p of probes) console.log(`  ${p.ok ? '✅' : '❌'} ${p.tool} — ${p.detail}`);

    const installed = probes.filter((p) => p.ok);
    if (installed.length === 0) {
      console.log('\n설치된 도구가 없습니다. claude 또는 codex CLI 를 먼저 설치한 뒤 다시 실행하세요.');
      process.exitCode = 1;
      return;
    }

    const existing = readExisting();
    console.log('');

    let tool = '';
    const installedNames = installed.map((p) => p.tool);
    while (!installedNames.includes(tool)) {
      tool = await ask(`사용할 도구 (${installedNames.join(' / ')})`, existing && installedNames.includes(existing.tool) ? existing.tool : installed[0].tool);
    }

    const token = (await ask(existing?.token ? 'API 토큰 (Enter: 기존 값 유지)' : 'API 토큰')) || existing?.token || '';
    const agentName = await ask('내 이름 (에이전트 이름)', existing?.agentName);

    let serverUrl = existing?.serverUrl ?? DEFAULT_SERVER_URL;
    const changeServer = await ask(`서버 주소를 바꾸시겠습니까? (기본값 ${DEFAULT_SERVER_URL}) y/N`, 'n');
    if (yes(changeServer)) {
      serverUrl = await ask('서버 주소', serverUrl);
    }

    const existingWorkspaceDefault = existing
      ? (Array.isArray(existing.workspace) ? existing.workspace.join(',') : existing.workspace)
      : undefined;

    let workspacePaths: string[] = [];
    for (;;) {
      const input = await ask('작업 폴더 (여러 개면 쉼표로 구분)', existingWorkspaceDefault);
      workspacePaths = input.split(',').map((s) => s.trim()).filter((s) => s !== '');
      const missing = workspacePaths.filter((p) => !existsSync(p));
      if (workspacePaths.length === 0) {
        console.log('작업 폴더를 하나 이상 입력해야 합니다.');
        continue;
      }
      if (missing.length > 0) {
        console.log(`다음 경로가 존재하지 않습니다: ${missing.join(', ')}`);
        continue;
      }
      break;
    }

    if (workspacePaths.length > 1) {
      console.log('\n경로를 여러 개 입력하셨습니다 — 첫 번째가 작업 디렉터리, 나머지는 추가로 읽기만 허용됩니다.');
      if (tool === 'codex') {
        console.log('codex 는 추가 경로(--add-dir 상당)가 검증되지 않았습니다. 가능하면 프로젝트를 한 폴더 아래 모아');
        console.log('경로 하나로 쓰는 것을 권합니다.');
      }
    }

    const workspaceValue: string | string[] = workspacePaths.length === 1 ? workspacePaths[0] : workspacePaths;
    const repos = findRepos(workspaceValue);
    console.log(`\n찾은 저장소 (${repos.length}개): ${repos.length > 0 ? repos.join(', ') : '(없음)'}`);

    if (repos.length === 0) {
      const cont = await ask('저장소를 찾지 못했습니다. 경로가 맞는지 확인하세요. 그래도 계속할까요? y/N', 'n');
      if (!yes(cont)) {
        console.log('설정을 저장하지 않고 종료합니다.');
        return;
      }
    } else {
      const confirmRepos = await ask('이 목록이 맞습니까? y/N', 'y');
      if (!yes(confirmRepos)) {
        console.log('설정을 저장하지 않고 종료합니다.');
        return;
      }
    }

    const config = {
      serverUrl,
      token,
      agentName,
      command: tool,
      tool,
      workspace: workspaceValue,
    };

    if (existsSync(CONFIG_PATH)) {
      console.log(`\n기존 설정 파일이 있습니다: ${CONFIG_PATH}`);
      const shown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      console.log(JSON.stringify({...shown, token:'[숨김]'}, null, 2));
      const overwrite = await ask('덮어쓸까요? y/N', 'n');
      if (!yes(overwrite)) {
        console.log('취소했습니다.');
        return;
      }
    }

    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    parseConfig(config);
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {mode:0o600});
    console.log(`\n저장했습니다: ${CONFIG_PATH}`);
    console.log((await githubLogin()).detail);
    console.log('npm run daemon 으로 시작하세요.');
  } finally {
    rl.close();
  }
}

await main();
