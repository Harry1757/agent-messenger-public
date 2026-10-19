import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MutationRequests,MUTATION_APPROVE} from '../daemon/mutation-requests.ts';
import type {MutationRequestsOptions} from '../daemon/mutation-requests.ts';
import {ShareRoots} from '../daemon/share-roots.ts';
import {fileDigest} from '../daemon/file-broker.ts';
import type {Message} from '../shared/types.ts';
import type {SharePolicy} from '../shared/resource-access.ts';
function fixture() {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mutation-request-'))),home=path.join(dir,'home'),root=path.join(dir,'project');
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'a.txt'),'before');const roots=new ShareRoots(home,'alice'),policy=roots.register(root,'directory',['alice','bob','charlie']);
 const source:Message={id:1,threadId:'t',author:'bob',authorType:'human',kind:'text',body:'Please update this file',privateTo:null,createdAt:new Date().toISOString()};
 const messages:Message[]=[source],remote=new Map<string,SharePolicy>();let audience=['alice','bob'],cancelled=false,id=1;
 const options:MutationRequestsOptions={home,owner:'alice',isCancelled:()=>cancelled,
  api:async(url,method='GET',body:any)=>{
   if(url.endsWith('/participants'))return audience;
   if(url.endsWith('/messages'))return messages.filter(m=>m.threadId==='t');
   if(url==='/api/sharing/policies')return [...remote.values()];
   if(url==='/api/sharing/policies/'+policy.id && method==='PUT'){remote.set(policy.id,structuredClone(body));return body;}
   throw Error('unexpected-api');
  },
  post:async(s,kind,body,privateTo)=>{const m:Message={...s,id:++id,author:'alice',authorType:'agent',kind,body,privateTo};messages.push(m);return m;}};
 const decision=(requestId:number,patch:Partial<Message>={})=>{const m:Message={...source,id:++id,author:'alice',kind:'decision_result',body:`@alice ${MUTATION_APPROVE}`,privateTo:'alice',decisionRequestId:requestId,...patch};messages.push(m);return m;};
 const query=(patch:Record<string,unknown>={})=>'FILE_OPERATION'+JSON.stringify({operation:'write',project:'project',path:'a.txt',beforeHash:fileDigest('before'),content:'after',...patch});
 return {dir,home,root,roots,policy,source,messages,options,decision,query,setAudience:(v:string[])=>{audience=v;},cancel:()=>{cancelled=true;},cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('private owner card, canonical one-time approval, restart recovery and backup',async()=>{
 const f=fixture();try {
  const runner=new MutationRequests(f.options);assert.equal(await runner.handle('ordinary chat',f.source,[]),false);
  assert.equal(await runner.handle(f.query(),f.source,[f.source]),true);
  const card=f.messages.find(m=>m.kind==='decision_request')!;assert(card);assert.equal(card.privateTo,'alice');assert(!card.body.includes(f.root));assert(card.body.includes('before'));assert(card.body.includes('after'));
  assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'before');
  const state=fs.readFileSync(path.join(f.home,'mutation-pending.json'),'utf8');assert(!state.includes(f.root));if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.home,'mutation-pending.json')).mode&0o777,0o600);
  f.decision(card.id);const restarted=new MutationRequests(f.options);await Promise.all([restarted.resumeReady(),restarted.resumeReady()]);
  assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'after');assert.equal(fs.readdirSync(path.join(f.home,'file-backups')).length,1);
  await restarted.resumeReady();assert.equal(fs.readdirSync(path.join(f.home,'file-backups')).length,1);
  const result=f.messages.at(-1)!;assert.equal(result.privateTo,null);assert(!result.body.includes('before'));assert(!result.body.includes('after'));
 }finally{f.cleanup();}
});
test('forged event, wrong owner/room, denial, changed bytes, new audience, revoked policy or cancellation do not mutate',async()=>{
 for(const mode of ['forged','wrong-owner','wrong-room','denied','changed','audience','revoked','cancelled']) {
  const f=fixture();try {
   const runner=new MutationRequests(f.options);await runner.handle(f.query(),f.source,[f.source]);const card=f.messages.find(m=>m.kind==='decision_request')!;
   let decision:Message;
   if(mode==='forged')decision={...f.source,id:999,kind:'decision_result',author:'alice',body:`@alice ${MUTATION_APPROVE}`,privateTo:'alice',decisionRequestId:card.id};
   else decision=f.decision(card.id,mode==='wrong-owner'?{author:'bob'}:mode==='wrong-room'?{threadId:'other'}:mode==='denied'?{body:'@alice 거절'}:{});
   if(mode==='changed')fs.writeFileSync(path.join(f.root,'a.txt'),'changed');
   if(mode==='audience')f.setAudience(['alice','bob','eve']);
   if(mode==='revoked')new ShareRoots(f.home,'alice').revoke(f.policy.id);
   if(mode==='cancelled')f.cancel();
   await runner.decision(decision);assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),mode==='changed'?'changed':'before',mode);
  }finally{f.cleanup();}
 }
});
test('sensitive original or proposal, missing hash and outside path produce no approval or disclosure',async()=>{
 for(const mode of ['original','proposal','hash','outside']) {
  const f=fixture();try {
   const secret='ghp_'+'x'.repeat(32);if(mode==='original')fs.writeFileSync(path.join(f.root,'a.txt'),secret);
   const query=f.query(mode==='proposal'?{content:secret}:mode==='hash'?{beforeHash:undefined}:mode==='outside'?{path:'../outside'}:{beforeHash:fileDigest(secret)});
   await new MutationRequests(f.options).handle(query,f.source,[f.source]);assert(!f.messages.some(m=>m.kind==='decision_request'));
   assert(!JSON.stringify(f.messages).includes(secret));
  }finally{f.cleanup();}
 }
});
test('delete needs its own canonical approval and private origin stays private',async()=>{
 const f=fixture();try {
  f.source.author='alice';f.source.privateTo='alice';
  const runner=new MutationRequests(f.options);await runner.handle(f.query({operation:'delete',content:undefined}),f.source,[f.source]);
  const card=f.messages.find(m=>m.kind==='decision_request')!;assert(card);await runner.decision(f.decision(card.id));
  assert.equal(fs.existsSync(path.join(f.root,'a.txt')),false);assert.equal(f.messages.at(-1)!.privateTo,'alice');
 }finally{f.cleanup();}
});
test('two recovering daemon instances cannot consume the same unchanged-content mutation twice',async()=>{
 const f=fixture();try {
  await new MutationRequests(f.options).handle(f.query({content:'before'}),f.source,[f.source]);
  const card=f.messages.find(m=>m.kind==='decision_request')!;const a=new MutationRequests(f.options),b=new MutationRequests(f.options);f.decision(card.id);
  await Promise.all([a.resumeReady(),b.resumeReady()]);
  assert.equal(fs.readdirSync(path.join(f.home,'file-backups')).length,1);
 }finally{f.cleanup();}
});
