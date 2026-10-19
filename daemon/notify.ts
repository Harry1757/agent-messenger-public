import { execFile } from 'node:child_process';
import notifier from 'node-notifier';
import {existsSync} from 'node:fs';

export function notificationUrl(serverUrl:string, threadId?:string):string {
  const url=new URL(threadId ? '/' : '/decisions.html',serverUrl);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('지원하지 않는 알림 주소');
  if(threadId) url.hash=`thread=${encodeURIComponent(threadId)}`;
  return url.href;
}

function openUrl(url:string):void {
  const parsed=new URL(url);
  if(!['http:','https:'].includes(parsed.protocol)) return;
  const file=process.platform==='win32' ? 'rundll32.exe' : process.platform==='darwin' ? 'open' : 'xdg-open';
  execFile(file,process.platform==='win32' ? ['url.dll,FileProtocolHandler',parsed.href] : [parsed.href],{windowsHide:true},error=>{if(error)console.error('알림 링크 열기 실패:',error.message);});
}

export function decisionInboxCommand(serverUrl: string, account: string, platform = process.platform): [string, string[]] {
  const url = new URL('/decisions.html', serverUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('지원하지 않는 서버 주소');
  url.searchParams.set('account', account);
  // 토큰은 URL이나 프로세스 인수에 넣지 않는다. 브라우저의 로그인으로 인증한다.
  if (platform === 'darwin') return ['open', [url.href]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]];
  return ['xdg-open', [url.href]];
}

let lastOpened = 0;
export function openDecisionInbox(serverUrl: string, account: string): void {
  // 동시에 여러 요청이 와도 브라우저 창을 연달아 열지 않는다.
  if (Date.now() - lastOpened < 30_000) return;
  lastOpened = Date.now();
  try {
    const [file,args] = decisionInboxCommand(serverUrl,account);
    execFile(file,args,{windowsHide:true},error=>{if(error) console.error('결정 요청함 열기 실패:',error.message);});
  } catch (error) { console.error('결정 요청함 열기 실패:',error); }
}

/**
 * OS 네이티브 알림. 실패해도 데몬을 멈추지 않는다.
 *
 * macOS 는 내장 `osascript` 를 쓴다. node-notifier 가 끼워 넣은 terminal-notifier
 * 바이너리가 x86_64 전용이라 애플 실리콘에서 errno -86(EBADARCH)로 실패한다 —
 * 2026-09-10 실측 확인. `osascript` 는 OS 기본 제공이라 아키텍처 문제가 없다.
 */
export function notify(title: string, body: string, url?: string, options: {requiresResponse?:boolean} = {}): void {
  if (process.send) { process.send({type:'notify',title,body,url,...(options.requiresResponse?{requiresResponse:true}:{})}); return; }
  const message = body.slice(0, 200);
  try {
    if (process.platform === 'darwin') {
      const fallback = () => {
      const escape = (s: string) => s.replace(/["\\]/g, '\\$&');
      execFile(
        'osascript',
        ['-e', `display notification "${escape(message)}" with title "${escape(title)}"`],
        (e) => { if (e) console.error('알림 실패:', e.message); },
      );
      };
      const native=['/opt/homebrew/bin/terminal-notifier','/usr/local/bin/terminal-notifier'].find(existsSync);
      if(native) {
        const escapeValue=(s:string)=>/^[\[({"]/.test(s) ? `\\${s}` : s;
        execFile(native,['-title',escapeValue(title),'-message',escapeValue(message),...(url ? ['-open',url] : [])],
          error=>{if(error){console.error('클릭 가능한 알림 실패; 기존 알림 사용:',error.message);fallback();}});
        return;
      }
      fallback();
      return;
    }
    notifier.notify({ title, message, sound: false, wait: true }, (error, response) => {
      if (error) console.error('알림 실패:', error.message);
      else if(url && ['activate','clicked'].includes(String(response).toLowerCase())) openUrl(url);
    });
  } catch (e) {
    console.error('알림 실패:', e);
  }
}
