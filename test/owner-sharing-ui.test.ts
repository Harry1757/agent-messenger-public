import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
class Element {
 children:any[]=[];dataset:any={};disabled=false;textContent='';type='';hidden=false;listeners:any={};
 tag='';className='';
 constructor(tag='',className='',text=''){this.tag=tag;this.className=className;this.textContent=text;}
 append(...children:any[]){this.children.push(...children);}
 setAttribute(){}
 addEventListener(event:string,fn:any){this.listeners[event]=fn;}
 querySelectorAll(tag:string):any[]{return this.children.flatMap(x=>[...(x.tag===tag?[x]:[]),...x.querySelectorAll(tag)]);}
}
function fixture(owner='owner',available=true){
 const calls:any[]=[];const requests:any[]=[];
 const context:any={myName:owner,el:(...args:any[])=>new Element(...args),sharingAvailable:()=>available,resourceLabels:{'waiting-owner':'소유자 확인 필요'},api:async(path:string,options:any)=>{requests.push({path,...options});},refreshResourceRequests:async()=>{},window:{desktopMessenger:{sharingList:async()=>({policies:[]}),sharingAdd:async(input:any)=>{calls.push(input);return {policies:[{id:'new',revoked:false}]};}}}};
 // Include the real status-label helper used by the card; do not stub away its dependencies.
 const start=source.indexOf('function resourceStatusLabel(status, text) {');
 const end=source.indexOf('setInterval(() => { if (!document.hidden)',start);
 assert(start>=0 && end>start,'resource card source boundaries must exist');
 const code=source.slice(start,end);
 runInNewContext(code+';this.render=renderResourceCard;',context);
 const request={id:'r',owner:'owner',requester:'reader',threadId:'room',audience:['reader','owner'],status:'waiting-owner'};
 return {context,calls,requests,card:context.render(request)};
}
test('only owner gets native selection and reject actions, never other readers',()=>{
 assert.equal(fixture().card.querySelectorAll('button').length,2);
 assert.deepEqual(fixture('reader').card.querySelectorAll('button').map((b:any)=>b.textContent),['요청 취소']);
 assert.equal(fixture('observer').card.querySelectorAll('button').length,0);
 assert.equal(fixture('owner',false).card.querySelectorAll('button')[0].disabled,true);
});
test('owner native picker binds explicit audience and room before structured approval',async()=>{
 const f=fixture();f.card.querySelectorAll('button')[0].listeners.click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{kind:'file',audience:['reader','owner'],threadId:'room'}]);
 assert.deepEqual(JSON.parse(f.requests[0].body),{approved:true,policyId:'new',path:''});
 assert.equal(f.requests[0].path,'/resources/r/decision');
});
test('cancelled native selection never grants access',async()=>{
 const f=fixture();f.context.window.desktopMessenger.sharingAdd=async()=>({policies:[]});
 f.card.querySelectorAll('button')[0].listeners.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.requests.length,0);
});
test('local sharing never requests GitHub readiness',()=>{
 const fn=source.slice(source.indexOf('async function refreshGithubRequest()'),source.indexOf('async function checkGithubWithFeedback'));
 assert.doesNotMatch(fn,/api\(/);assert.match(fn,/hidden = true/);
 const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
 assert.match(html,/id="sharingConfirm"[^>]*required/);assert.doesNotMatch(html,/name="audience"[^>]*checked/);
});

test('sensitive request approves existing policy with masked-content action and no picker',async()=>{
 const f=fixture();const card=f.context.render({id:'s',owner:'owner',requester:'reader',audience:['reader'],threadId:'room',status:'waiting-owner',waitReason:'sensitive',policyId:'existing',preview:'값을 가린 내용'});
 assert.equal(card.querySelectorAll('button').length,2);
 assert.match(card.querySelectorAll('button')[0].textContent,/가린 내용만/);
 card.querySelectorAll('button')[0].listeners.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.length,0);assert.deepEqual(JSON.parse(f.requests[0].body),{approved:true,policyId:'existing'});
});
test('work-folder capable app still permits a file only for this room',async()=>{const f=fixture();f.context.window.desktopMessenger.sharingList=async()=>({workFolders:true,policies:[]});f.card.querySelectorAll('button')[0].listeners.click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{kind:'file',audience:['reader','owner'],threadId:'room'}]);assert.equal(JSON.parse(f.requests[0].body).path,'');});
test('directory request selects the requested directory itself, not a duplicated subpath',async()=>{const f=fixture();const card=f.context.render({id:'d',owner:'owner',requester:'reader',audience:['owner','reader'],threadId:'room',status:'waiting-owner',action:'list',path:'plan'});card.querySelectorAll('button')[0].listeners.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls[0].kind,'directory');assert.equal(f.calls[0].threadId,'room');assert.equal(f.calls[0].workFolder,undefined);assert.equal(JSON.parse(f.requests[0].body).path,'');});
