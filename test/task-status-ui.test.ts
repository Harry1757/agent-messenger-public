import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const selector=source.slice(source.indexOf('function pendingInfo()'),source.indexOf('function updatePending()'));
function pending(tasks:any[],others=false){
 return runInNewContext(selector+';pendingInfo()',{
  current:{id:'room'},myName:'me',privateOn:false,taskStatesByThread:new Map([['room',tasks]]),
  messages:[{id:1,authorType:'human',kind:'text',body:'@peer question',privateTo:null,createdAt:'2020-01-01'}],
  agents:[{user:'peer',online:true,busyThreadId:'room',reportedAt:'2020-01-01'}],agentOnline:(name:string)=>name==='peer',mentionedIn:()=>others?['peer','other']:['peer']
 });
}
for(const state of ['completed','failed','cancelled','waiting-owner','waiting-connection','waiting-agent']){
 test(`authoritative ${state} overrides old mention and stale busy heartbeat`,()=>{
  const info=pending([{id:'a',messageId:1,owner:'peer',state}]);
  assert.equal(info.items.length,1);assert.equal(info.items[0].state,state);assert.equal(info.items[0].running,false);assert.equal(info.items[0].since,undefined);
 });
}
test('latest task wins per agent while another agent keeps legacy status',()=>{
 const info=pending([{id:'a',messageId:1,owner:'peer',state:'running'},{id:'b',messageId:2,owner:'peer',state:'completed'}],true);
 assert.equal(info.items.length,2);assert.equal(info.items[0].state,'completed');assert.equal(info.items[1].who,'other');assert.equal(info.items[1].warn,true);
});
test('waiting teammate is retained alongside completed teammate',()=>{
 const info=pending([{id:'a',messageId:1,owner:'peer',state:'completed'},{id:'b',messageId:1,owner:'other',state:'waiting-owner'}],true);
 assert.deepEqual(Array.from(info.items,(item:any)=>item.state),['completed','waiting-owner']);
});
test('task refresh ignores response from previous room',async()=>{
 let resolve:any;const calls:any[]=[];
 const context:any={current:{id:'old'},token:'token',taskRefreshGeneration:0,taskStatesByThread:new Map(),api:()=>new Promise(r=>resolve=r),updatePending:()=>calls.push('pending'),renderThreads:()=>calls.push('threads')};
 const fn=source.slice(source.indexOf('async function refreshTaskStates()'));
 runInNewContext(fn+';this.refresh=refreshTaskStates;',context);
 const response=context.refresh();context.current={id:'new'};resolve([{owner:'peer',state:'running'}]);await response;
 assert.equal(context.taskStatesByThread.size,0);assert.equal(calls.length,0);
});
