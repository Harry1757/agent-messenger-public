import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DecisionReminders,REMINDER_INTERVAL_MS,shouldNotifyCompletion} from '../daemon/reminders.ts';
import type {Message} from '../shared/types.ts';
const request:Message={id:1,threadId:'t',author:'예제사용자',authorType:'agent',kind:'decision_request',body:'{}',privateTo:null,createdAt:''};
test('담당자에게만 알리고 답할 때까지 정확히 2분 간격으로 반복한다',()=>{
 const events:string[]=[];const r=new DecisionReminders('예제사용자',title=>events.push(title));
 r.observe({...request,author:'예제동료'},0);assert.equal(events.length,0);
 r.observe(request,0);assert.equal(events.length,1);
 r.tick(REMINDER_INTERVAL_MS-1);assert.equal(events.length,1);
 r.tick(REMINDER_INTERVAL_MS);assert.equal(events.length,2);
 r.tick(2*REMINDER_INTERVAL_MS);assert.equal(events.length,3);
 r.observe({...request,id:2,kind:'decision_result',decisionRequestId:1},2*REMINDER_INTERVAL_MS);
 r.tick(3*REMINDER_INTERVAL_MS);assert.equal(events.length,3);
});
test('재연결 때 이미 답한 요청은 복원하지 않는다',()=>{
 const events:string[]=[];const r=new DecisionReminders('예제사용자',title=>events.push(title));
 r.reconcile([request,{...request,id:2,kind:'decision_result',decisionRequestId:1}],0);
 r.tick(REMINDER_INTERVAL_MS);assert.equal(events.length,0);
});
test('에이전트 대화 중에는 완료 알림을 하지 않는다',()=>{
 assert.equal(shouldNotifyCompletion('text','@예제동료 추가 확인 부탁해요','예제사용자'),false);
 assert.equal(shouldNotifyCompletion('decision_request','{}','예제사용자'),false);
 assert.equal(shouldNotifyCompletion('text','검토를 마쳤습니다.','예제사용자'),false);
});
test('새 결정은 한 번만 요청함을 열고 요약을 리마인드에도 전달한다',()=>{
 const bodies:string[]=[];const opened:number[]=[];
 const r=new DecisionReminders('예제사용자',(_title,body)=>bodies.push(body),m=>opened.push(m.id));
 const m={...request,body:JSON.stringify({question:'배포할까요?',summary:'필수 검증이 끝났습니다',options:['배포','보류']})};
 r.observe(m,0); r.observe(m,1);r.tick(REMINDER_INTERVAL_MS);
 assert.deepEqual(opened,[1]);assert.equal(bodies.length,2);
 for(const body of bodies){assert.match(body,/배포할까요/);assert.match(body,/필수 검증/);}
});
test('hidden threads stop repeat reminders while other threads remain active',()=>{
 const events:number[]=[];const r=new DecisionReminders('예제사용자',(_t,_b,m)=>events.push(m.id));
 r.observe(request,0);r.observe({...request,id:2,threadId:'keep'},0);r.forgetThread('t');
 r.tick(REMINDER_INTERVAL_MS);assert.deepEqual(events,[1,2,2]);
});
test('reconcile discards stale requests absent from visible history',()=>{
 const events:number[]=[];const r=new DecisionReminders('예제사용자',(_t,_b,m)=>events.push(m.id));
 r.observe(request,0);r.reconcile([],1);r.tick(REMINDER_INTERVAL_MS);assert.deepEqual(events,[1]);
});
test('deletion during history restore cannot recreate a reminder from the stale response',()=>{
 const events:number[]=[];const r=new DecisionReminders('예제사용자',(_t,_b,m)=>events.push(m.id));
 r.observe(request,0);r.forgetThread('t');r.reconcile([request],1);r.observe({...request,id:3},2);r.tick(REMINDER_INTERVAL_MS+5);assert.deepEqual(events,[1]);
});
