import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decisionInboxCommand} from '../daemon/notify.ts';
test('Mac과 Windows 요청함 실행은 셸 없이 URL 인수로 전달하고 토큰을 포함하지 않는다',()=>{
 for(const platform of ['darwin','win32','linux'] as const){
  const [command,args]=decisionInboxCommand('http://localhost:3000','예제사용자',platform);
  assert.equal(command,{darwin:'open',win32:'rundll32.exe',linux:'xdg-open'}[platform]);
  const url=new URL(args.at(-1)!);assert.equal(url.pathname,'/decisions.html');
  assert.equal(url.searchParams.get('account'),'예제사용자');assert.equal(url.searchParams.has('token'),false);
 }
 assert.throws(()=>decisionInboxCommand('file:///tmp','예제사용자'));
});

test('완료 알림은 해당 대화로, 결정 알림은 요청함으로 이동한다',async()=>{
 const {notificationUrl}=await import('../daemon/notify.ts');
 assert.equal(notificationUrl('http://localhost:3000','thread-26'),'http://localhost:3000/#thread=thread-26');
 assert.equal(notificationUrl('http://localhost:3000'),'http://localhost:3000/decisions.html');
 assert.throws(()=>notificationUrl('javascript:alert(1)'));
});
