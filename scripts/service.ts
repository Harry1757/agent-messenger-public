import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {CONFIG_PATH, DATA_DIR, loadConfig} from '../daemon/config.ts';

const action = process.argv[2];
if (!['install','remove'].includes(action)) throw new Error('install 또는 remove를 지정하세요.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (action === 'install') loadConfig();
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/windows-service.ps1'),
    '-Action',action,'-NodePath',process.execPath,'-ProjectPath',root], {stdio:'inherit',windowsHide:true});
} else if (process.platform === 'darwin') {
  const label = 'com.agent-messenger.daemon';
  const domain = `gui/${process.getuid!()}`;
  const plist = join(homedir(),'Library/LaunchAgents',label+'.plist');
  try { execFileSync('launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'}); } catch {}
  if (action === 'remove') {
    // 삭제 대신 비활성화해 다음 로그인 때도 시작하지 않는다.
    execFileSync('launchctl',['disable',`${domain}/${label}`]);
  } else {
    const xml = (s:string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    mkdirSync(dirname(plist),{recursive:true}); mkdirSync(DATA_DIR,{recursive:true});
    const args=[process.execPath,'--experimental-strip-types','--disable-warning=ExperimentalWarning',join(root,'daemon/background.ts')];
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '')}</string><key>AGENT_MESSENGER_HOME</key><string>${xml(DATA_DIR)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardErrorPath</key><string>${xml(join(DATA_DIR,'launcher.log'))}</string></dict></plist>`);
    execFileSync('launchctl',['enable',`${domain}/${label}`]);
    execFileSync('launchctl',['bootstrap',domain,plist]);
  }
} else throw new Error('자동 실행 등록은 Windows와 macOS를 지원합니다. 이 OS에서는 npm run daemon을 사용하세요.');
console.log(`자동 실행 ${action === 'install' ? '등록' : '해제'} 완료. 설정: ${CONFIG_PATH}`);
