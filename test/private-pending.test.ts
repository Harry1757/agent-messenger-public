import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the actual browser selector without a DOM or a duplicate implementation.
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const selector = source.slice(source.indexOf('function pendingInfo()'), source.indexOf('\nfunction updatePending()'));
function pending(privateOn:boolean, privateTo:string|null, busy:string) {
  const agents = [{user:busy, online:true, busyThreadId:'t', reportedAt:'2026-09-11T00:00:00Z'}];
  return runInNewContext(selector+'\npendingInfo()', {
    current:{id:'t',paused:false}, privateOn, myName:'예제사용자', agents,
    messages:[{authorType:'human',kind:'text', body:'@예제동료 질문', privateTo, createdAt:'2026-09-11T00:00:00Z'}],
    mentionedIn:()=>['예제동료'], agentOnline:(name:string)=>agents.some(a=>a.user===name&&a.online),
  });
}
test('혼잣말을 켜면 이전 공개 질문의 상대 대기 표시를 숨긴다',()=>{
  assert.equal(pending(true,null,'예제동료'),null);
});
test('보낸 혼잣말은 토글을 꺼도 본인 에이전트 상태만 표시한다',()=>{
  assert.equal(pending(false,'예제사용자','예제동료').who,'예제사용자');
  assert.equal(pending(true,'예제사용자','예제사용자').who,'예제사용자');
});
test('공개 대화의 실제 실행 표시는 유지한다',()=>{
  assert.equal(pending(false,null,'예제동료').who,'예제동료');
});

import {shouldNotifyQuestion} from '../daemon/state.ts';
test('본인 질문만 알림을 생략하고 동료 질문은 알린다',()=>{
  assert.equal(shouldNotifyQuestion('예제사용자','예제사용자'),false);
  assert.equal(shouldNotifyQuestion('예제동료','예제사용자'),false);
});
