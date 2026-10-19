import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';

/** npm의 Windows shim을 셸에 넘기지 않는다. 메시지의 &, %, 따옴표도 데이터로 유지한다. */
export function resolveInvocation(
  command: string, args: string[], platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env, arch: string = process.arch,
): { command: string; args: string[] } {
  if (platform !== 'win32') return { command, args };
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const roots = /[\\/]/.test(command) ? [''] : pathValue.split(';').map((p) => p.replace(/^"|"$/g, '')).filter(Boolean);
  if(command==='gh' && env.ProgramFiles)roots.push(join(env.ProgramFiles,'GitHub CLI'));
  const suffixes = extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat', ''];
  const found = roots.flatMap((root) => suffixes.map((suffix) => root ? join(root, command + suffix) : command + suffix))
    .find((p) => existsSync(p));
  if (!found) return { command, args }; // execFile의 ENOENT가 사전 점검에 전달된다.
  if (/\.[cm]?js$/i.test(found)) return scriptInvocation(found, args, arch);
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args };
  const shim = readFileSync(found, 'utf8');
  const match = shim.match(/"%dp0%[\\/]([^"\r\n]+?\.[cm]?js)"/i);
  if (match) {
    const script = resolve(dirname(found), match[1].replace(/\\/g, '/'));
    if (existsSync(script)) return scriptInvocation(script, args, arch);
  }
  throw new Error(`npm shim을 해석할 수 없습니다: ${found}. command에 실제 .exe 또는 .js 실행 파일 경로를 지정하세요.`);
}

export function runCommand(command: string, args: string[], options: {cwd?: string; timeout?: number} = {}) {
  return new Promise<{error: Error | null; stdout: string; stderr: string}>((done) => {
    try {
      const invocation = resolveInvocation(command, args);
      const child = execFile(invocation.command, invocation.args,
        { ...options, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => done({error, stdout, stderr}));
      // Codex는 인자에 프롬프트가 있어도 pipe의 EOF를 기다린다.
      child.stdin?.on('error', () => {}); // 자식이 먼저 종료했을 때 EPIPE는 종료 콜백이 처리.
      child.stdin?.end();
    } catch (error) { done({error: error as Error, stdout:'', stderr:''}); }
  });
}

// Codex의 npm 래퍼가 다시 spawn한 콘솔은 부모의 windowsHide를 상속하지 않는다.
// 배포 패키지의 실제 바이너리를 찾아 우리가 직접 숨김 실행한다.
function scriptInvocation(script: string, args: string[], arch: string) {
  const root = dirname(dirname(script));
  try {
    if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === '@openai/codex') {
      const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const roots = [join(root, 'vendor')];
      try { roots.unshift(join(dirname(createRequire(script).resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor')); } catch {}
      for (const vendor of roots) for (const folder of ['bin', 'codex']) {
        const binary = join(vendor, triple, folder, 'codex.exe');
        if (existsSync(binary)) return {command: binary, args};
      }
    }
  } catch {}
  return {command: process.execPath, args: [script, ...args]};
}
