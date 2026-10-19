import {test} from 'node:test';import assert from 'node:assert/strict';import {dismissNotifications} from '../desktop/notification-cleanup.ts';
test('opening app clears retained and previous-session notices without answering decisions',()=>{
 const pending=new Map([[7,{body:'waiting'}]]);let closes=0,history=0;
 const duplicate={close(){closes++;}};const decisions=new Map([[7,duplicate]]);const ordinary=new Set([duplicate,{close(){throw Error('OS already closed');}},{close(){closes++;}}]);
 dismissNotifications(decisions,ordinary,()=>history++);
 assert.equal(closes,2);assert.equal(history,1);assert.equal(decisions.size,0);assert.equal(ordinary.size,0);assert.equal(pending.get(7)?.body,'waiting');
 ordinary.add({close(){closes++;}});dismissNotifications(decisions,ordinary,()=>history++);assert.equal(closes,3);assert.equal(history,2);
});
