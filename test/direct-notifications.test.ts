import {test} from 'node:test';import assert from 'node:assert/strict';
import {DirectNotifications} from '../daemon/direct-notifications.ts';import type {Message} from '../shared/types.ts';
const message={id:1,author:'예제사용자',authorType:'human',kind:'text',body:'제가 확인했어요',privateTo:null} as Message;
test('공개 직접 대화는 발신자를 제외한 모든 수신 참여자에게 한 번씩 알린다',()=>{
 const notified:string[]=[];for(const name of ['예제사용자','서연','예제동료']){const d=new DirectNotifications(name,()=>notified.push(name));d.observe(message);d.observe(message);}
 assert.deepEqual(notified,['서연','예제동료']);
});
test('혼잣말·에이전트 답변·결정 결과·멘션 요청은 직접 대화 알림과 중복하지 않는다',()=>{
 const out:Message[]=[];const d=new DirectNotifications('예제동료',m=>out.push(m));
 for(const patch of [{privateTo:'예제사용자'},{authorType:'agent'},{kind:'decision_result'},{body:'@예제동료 확인해줘'}])d.observe({...message,...patch} as Message);
 assert.equal(out.length,0);
});
