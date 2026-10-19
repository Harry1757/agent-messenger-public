import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'web/downloads/agent-messenger.zip'));
const stage = mkdtempSync(join(tmpdir(), 'messenger-package-'));
try {
  const bundle = join(stage, 'agent-messenger');
  mkdirSync(bundle);
  for (const name of ['daemon', 'shared', 'package-lock.json']) cpSync(join(root, name), join(bundle, name), {recursive:true});
  mkdirSync(join(bundle, 'scripts'));
  for (const name of ['windows-service.ps1', 'service.ts']) cpSync(join(root, 'scripts', name), join(bundle, 'scripts', name));
  cpSync(join(root, 'docs', '설치.md'), join(bundle, '설치.md'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([k]) => ['daemon','setup','doctor','service:install','service:remove'].includes(k)));
  writeFileSync(join(bundle, 'package.json'), JSON.stringify(pkg,null,2)+'\n');
  mkdirSync(dirname(output), {recursive:true});
  if (process.platform === 'win32') {
    const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const command = `Compress-Archive -LiteralPath ${quote(bundle)} -DestinationPath ${quote(output)} -Force`;
    execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]);
  } else {
    // 기존 zip에 삭제된 파일이 남지 않도록 새 파일을 만든다.
    rmSync(output, {force:true});
    execFileSync('zip', ['-q','-r',output,'agent-messenger'], {cwd:stage});
  }
  console.log(`데몬 패키지: ${output}`);
} finally { rmSync(stage, {recursive:true,force:true}); }
