import {test} from 'node:test';import assert from 'node:assert/strict';
import {CompletionNotifications,COMPLETION_DELAY_MS} from '../daemon/reminders.ts';
import type {Message} from '../shared/types.ts';
const m:Message={id:91,threadId:'end-test',author:'서연',authorType:'agent',kind:'summary',body:'서연님의 점심은 닭가슴살입니다.',privateTo:null,createdAt:''};
test('완료 답변을 받은 참여자 모두에게 한 번 알린다',()=>{
 for(const me of ['예제사용자','예제동료','서연']){const sent:Message[]=[];const n=new CompletionNotifications(me,m=>sent.push(m));n.observe(m,0);assert.equal(sent.length,1);n.observe(m,COMPLETION_DELAY_MS+1);n.tick(99999);assert.deepEqual(sent,[m]);}
});
test('중간 대화와 타인 혼잣말은 알리지 않고 후속 대화가 오면 완료 알림을 취소한다',()=>{
 const sent:Message[]=[];const n=new CompletionNotifications('예제사용자',m=>sent.push(m));n.observe({...m,privateTo:'서연'},0);n.tick(99999);assert.equal(sent.length,0);
 n.observeAgent({user:'예제동료',online:true,busyThreadId:m.threadId} as any);
 n.observe({...m,id:92},0);n.observe({...m,id:93,kind:'text',body:'@예제동료 추가 확인 부탁해요'},1000);n.tick(99999);assert.equal(sent.length,0);
 n.observe({...m,id:94},100000);n.observe({...m,id:95,authorType:'human',body:'제가 직접 답할게요'},100001);n.tick(999999);assert.equal(sent.length,0);
});

test('후속 에이전트가 실행 중이면 완료 알림을 보류한다',()=>{
 const sent:Message[]=[];const n=new CompletionNotifications('예제사용자',m=>sent.push(m));
 n.observeAgent({user:'예제동료',online:true,busyThreadId:m.threadId} as any);n.observe(m,0);
 n.tick(COMPLETION_DELAY_MS*2);assert.equal(sent.length,0);
 n.observe({...m,id:92,author:'예제동료'},COMPLETION_DELAY_MS*2);
 n.observeAgent({user:'예제동료',online:true,busyThreadId:null} as any);
 assert.equal(sent.length,1);assert.equal(sent[0].id,92);
});

 test('일반 답변은 완료가 아니며 동일 대화의 요약 여러 개도 한 번만 알린다',()=>{
 const sent:Message[]=[];const n=new CompletionNotifications('예제사용자',m=>sent.push(m));
 n.observe({...m,id:100,kind:'text',body:'검토했습니다.'});assert.equal(sent.length,0);
 n.observe({...m,id:101});n.observe({...m,id:102});assert.equal(sent.length,1);
 n.observe({...m,id:103,authorType:'human',kind:'text',body:'추가 질문'});
 n.observe({...m,id:104});assert.equal(sent.length,2);
 });
test('내 혼잣말 요약은 완료 알림을 만들지 않는다',()=>{
 const sent:Message[]=[];const n=new CompletionNotifications('예제사용자',m=>sent.push(m));
 n.observe({...m,author:'예제사용자',privateTo:'예제사용자'},0);n.tick(99999);assert.equal(sent.length,0);
});
