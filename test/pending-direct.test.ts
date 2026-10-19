import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function pendingInfo()'),source.indexOf('function updatePending()'));
function pending(messages:any[]){return runInNewContext(fn+';pendingInfo()', {current:{id:'t',paused:false},messages,privateOn:false,myName:'me',agents:[],agentOnline:()=>true,mentionedIn:(s:string)=>[...s.matchAll(/@(\w+)/g)].map(m=>m[1])});}
const request={id:1,authorType:'human',kind:'text',author:'me',body:'@peer question',privateTo:null,createdAt:'2026-09-14T01:00:00Z'};
test('direct human message does not erase an unanswered agent request',()=>{
 const value=pending([request,{...request,id:2,direct:true,body:'human message'}]);assert(value);assert.equal(value.who,'peer');
});
test('answered agent request remains cleared after a direct human message',()=>{
 assert.equal(pending([request,{...request,id:2,authorType:'agent',author:'peer',body:'answer'},{...request,id:3,direct:true,body:'thanks'}]),null);
});
test('private approval followed by public file result and summary leaves no phantom pending request',()=>{
 assert.equal(pending([request,
 {...request,id:2,authorType:'agent',author:'peer',kind:'decision_request',privateTo:'peer',body:'approval'},
 {...request,id:3,author:'peer',kind:'decision_result',privateTo:'peer',body:'@peer approve'},
 {...request,id:4,authorType:'agent',author:'peer',body:'approved file result'},
 {...request,id:5,authorType:'agent',author:'peer',kind:'summary',body:'done'}]),null);
});
