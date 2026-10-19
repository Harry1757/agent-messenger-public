import {test} from 'node:test';
import assert from 'node:assert/strict';
import {directEvent,directForLegacyDaemon} from '../server/direct-delivery.ts';
import {extractMentions} from '../shared/mentions.ts';
const m={id:1,threadId:'t',author:'a',authorType:'human' as const,kind:'text' as const,body:'@b 알림 확인 부탁드립니다',privateTo:null,createdAt:'',direct:true};
test('direct mention cannot trigger old daemon and targets only named human',()=>{
 const e=directEvent({type:'message',message:m},'b');assert(e?.type==='message');assert.deepEqual(extractMentions(e.message.body),[]);assert.equal(directEvent({type:'message',message:m},'c'),null);assert.equal(m.body,'@b 알림 확인 부탁드립니다');assert.deepEqual(extractMentions(directForLegacyDaemon(m).body),[]);
});
test('unmentioned direct broadcasts; agent request remains intact',()=>{
 assert(directEvent({type:'message',message:{...m,body:'hello'}},'c'));assert.equal(directForLegacyDaemon({...m,direct:false}).body,m.body);
});
test('existing installed notification logic accepts targeted direct message',async()=>{
 const {DirectNotifications}=await import('../daemon/direct-notifications.ts');
 let delivered=0;const notify=new DirectNotifications('b',()=>delivered++);
 const event=directEvent({type:'message',message:m},'b');
 if(event?.type==='message')notify.observe(event.message);
 assert.equal(delivered,1);
});
