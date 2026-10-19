import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync('web/app.js','utf8');
const fn=source.slice(source.indexOf('function pendingInfo()'),source.indexOf('function updatePending()'));
const request={id:1,authorType:'human',kind:'text',body:'@서연 @예제동료 확인',privateTo:null,createdAt:new Date().toISOString()};
function pending(messages:any[],busy=true){return runInNewContext(fn+';pendingInfo()',{
 current:{id:'t',paused:false},messages,privateOn:false,myName:'예제사용자',
 mentionedIn:()=>['서연','예제동료'],agentOnline:(name:string)=>name==='서연',
 agents:[{user:'서연',online:true,busyThreadId:busy?'t':null,reportedAt:new Date().toISOString()}]
});}
test('한 명이 작업 중이어도 다른 멘션 대상의 오프라인 표시를 유지한다',()=>{
 const p=pending([request]);assert.equal(p.running,true);assert.deepEqual([...p.offline],['예제동료']);
});
test('한 명이 답한 뒤에도 미응답 멘션 대상의 오프라인 표시를 유지한다',()=>{
 const p=pending([request,{id:2,authorType:'agent',author:'서연',privateTo:null}],false);
 assert.equal(p.who,'예제동료');assert.equal(p.warn,true);
});
