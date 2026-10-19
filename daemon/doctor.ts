import {githubLogin} from './github-access.ts';
import { runCommand } from './process.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, loadConfig } from './config.ts';

/** 어댑터가 있는 도구 전부. `daemon/adapters/index.ts` 의 ADAPTERS 와 일치해야 한다. */
export const KNOWN_TOOLS: readonly string[] = ['claude', 'codex'];

export interface ToolProbe {
  tool: string;
  command: string;
  ok: boolean;
  detail: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

/** 실제 `<command> --version` 을 실행한다. 파일 존재만으로는 아키텍처·권한 문제를 못 잡는다. */
const execRunner: Runner = async (cmd, args) => {
  const {error, stdout, stderr} = await runCommand(cmd, args, {timeout:5000});
  return {ok:error === null, out:(stdout.trim() || stderr.trim() || error?.message || '').trim()};
};

/**
 * 어떤 경우에도 던지지 않는다 — 실패는 ok:false 와 사람이 읽을 수 있는 detail 로 표현한다.
 * `tool` 은 어댑터 선택(KNOWN_TOOLS 검증)에, `command` 는 실제로 실행할 실행 파일에 쓰인다 —
 * 설정에서 둘이 다를 수 있으므로(예: command 가 절대경로) 반드시 command 를 실행해야
 * 사전 점검이 실제로 돌아갈 바이너리를 확인한 것이 된다.
 */
export async function probeTool(tool: string, command: string = tool, run: Runner = execRunner): Promise<ToolProbe> {
  if (!KNOWN_TOOLS.includes(tool)) {
    return { tool, command, ok: false, detail: `알 수 없는 도구입니다 — ${KNOWN_TOOLS.join(', ')} 중 하나여야 합니다` };
  }
  try {
    const { ok, out } = await run(command, ['--version']);
    return { tool, command, ok, detail: out.trim() !== '' ? out.trim() : (ok ? '실행됨' : '실행 실패') };
  } catch (e) {
    return { tool, command, ok: false, detail: (e as Error).message };
  }
}

/** 이 기기에 어떤 알려진 도구들이 깔려 있는지 조사한다 — 설정과 무관하게 도구 이름 자체를 실행해 본다. */
export async function detectTools(run?: Runner): Promise<ToolProbe[]> {
  return Promise.all(KNOWN_TOOLS.map((tool) => probeTool(tool, tool, run)));
}

async function main(): Promise<void> {
  const probes = await detectTools();
  const github=await githubLogin();
  console.log(`${github.ok?'✅':'⚠️'} ${github.detail}`);
  console.log('설치된 도구 확인:');
  for (const p of probes) {
    console.log(`  ${p.ok ? '✅' : '❌'} ${p.tool.padEnd(8)} ${p.detail}`);
  }

  if (!existsSync(CONFIG_PATH)) {
    console.log(`\n설정 파일이 없습니다: ${CONFIG_PATH}`);
    console.log('npm run setup 으로 만들 수 있습니다.');
    return;
  }

  try {
    const config = loadConfig();
    // 위의 detectTools() 는 도구 이름 자체를 실행해 "이 기기에 뭐가 깔려 있나" 를 본다 —
    // 설정의 command 가 다를 수 있으므로(예: 절대경로) 여기서는 별도로 실제 command 를 확인한다.
    const configProbe = await probeTool(config.tool, config.command);
    if (configProbe.ok) {
      console.log(`\n설정 파일의 command="${config.command}" (tool="${config.tool}") — 이 기기에서 사용 가능합니다.`);
    } else {
      console.log(`\n설정 파일의 command="${config.command}" (tool="${config.tool}") — 사용할 수 없습니다: ${configProbe.detail}`);
      console.log('npm run setup 을 다시 실행하세요.');
      process.exitCode = 1;
    }
  } catch (e) {
    console.log(`\n설정 파일을 읽을 수 없습니다: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('doctor.ts') && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
