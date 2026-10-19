import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openDb,upsertUser,createThread,addThreadMember,addMessage,hideThread} from '../server/db.ts';
import {ResourceStore} from '../server/resource-store.ts';
const hash=createHash('sha256').update('safe result').digest('hex');
function fixture(file=':memory:'){
 const db=openDb(file);for(const u of ['alice','bob','eve'])upsertUser(db,u,u);const thread=createThread(db,'resources','alice');addThreadMember(db,thread.id,'bob');
 const message=addMessage(db,{threadId:thread.id,author:'bob',authorType:'human',kind:'text',body:'Please read the project'});
 const store=new ResourceStore(db);const policy={deviceId:'mac',source:'local',rootId:'project',prefix:'src',kind:'directory',audience:['bob'],excluded:['src/private'],threadId:null};
 const request={messageId:message.id,owner:'alice',deviceId:'mac',source:'local',rootId:'project',path:'src/app.ts',policyId:'policy'};
 store.putPolicy('alice','policy',policy);
 return {db,store,thread,message,policy,request};
}
function running(f:ReturnType<typeof fixture>){const r=f.store.request('bob',f.thread.id,f.request);return f.store.claim('alice',r.id,{generation:r.generation,deviceId:'mac'});}
function receipt(f:ReturnType<typeof fixture>){const r=running(f);const x=f.store.issueReceipt('alice',{requestId:r.id,generation:r.generation,claimToken:r.claimToken,policyId:'policy',contentHash:hash});return {r,x};}
test('owner policies reject impersonation, raw paths, traversal and revoked resurrection',()=>{const f=fixture();try{
 assert.throws(()=>f.store.putPolicy('bob','policy',f.policy));assert.throws(()=>f.store.putPolicy('alice','bad',{...f.policy,owner:'bob'}));
 for(const prefix of ['/Users/alice/private','C:\\secret','src/../private','src/%2e%2e/private'])assert.throws(()=>f.store.putPolicy('alice','bad',{...f.policy,prefix}));
 assert.throws(()=>f.store.putPolicy('alice','bad',{...f.policy,label:'password=secret12345'}));
 f.store.revokePolicy('alice','policy');assert.throws(()=>f.store.putPolicy('alice','policy',f.policy));
}finally{f.db.close();}});
test('scope derives requester from original public human message and denies excluded paths or outsiders',()=>{const f=fixture();try{
 const r=f.store.request('bob',f.thread.id,{...f.request,requester:'eve'});assert.equal(r.requester,'bob');
 assert.throws(()=>f.store.request('eve',f.thread.id,f.request));assert.throws(()=>f.store.request('bob',f.thread.id,{...f.request,path:'src/private/key'}));assert.throws(()=>f.store.request('bob',f.thread.id,{...f.request,path:'src2/file'}));
 const m=addMessage(f.db,{threadId:f.thread.id,author:'bob',authorType:'agent',kind:'text',body:'approved'});assert.throws(()=>f.store.request('bob',f.thread.id,{...f.request,messageId:m.id}));
}finally{f.db.close();}});
test('only owner may approve; chat approval has no authority; claims are single active and bounded',()=>{const f=fixture();try{
 const r=f.store.request('bob',f.thread.id,{...f.request,policyId:null});addMessage(f.db,{threadId:f.thread.id,author:'bob',authorType:'human',kind:'text',body:'approved'});
 assert.equal(f.store.list('bob',f.thread.id)[0].status,'waiting-owner');assert.throws(()=>f.store.decide('bob',r.id,{approved:true,policyId:'policy'}));
 f.store.decide('alice',r.id,{approved:true,policyId:'policy'});
 for(let n=0;n<6;n++){const c=f.store.claim('alice',r.id,{generation:1,deviceId:'mac'});assert.throws(()=>f.store.claim('alice',r.id,{generation:1,deviceId:'mac'}));assert.throws(()=>f.store.complete('alice',r.id,{generation:1,claimToken:'forged',status:'waiting-connection'}));f.store.complete('alice',r.id,{generation:1,claimToken:c.claimToken,status:'waiting-connection'});}
 assert.throws(()=>f.store.claim('alice',r.id,{generation:1,deviceId:'mac'}));
}finally{f.db.close();}});
test('receipt checks exact output hash, room, owner, audience, revision and one-time publication',()=>{const f=fixture();try{
 const {x}=receipt(f);const other=createThread(f.db,'other','alice');addThreadMember(f.db,other.id,'bob');
 assert.throws(()=>f.store.consumeReceipt('alice',other.id,x.id,hash));assert.throws(()=>f.store.consumeReceipt('bob',f.thread.id,x.id,hash));assert.throws(()=>f.store.consumeReceipt('alice',f.thread.id,x.id,'f'.repeat(64)));
 assert.equal(f.store.consumeReceipt('alice',f.thread.id,x.id,hash).source,'local');assert.throws(()=>f.store.consumeReceipt('alice',f.thread.id,x.id,hash));assert.equal(f.store.list('bob',f.thread.id)[0].status,'completed');
}finally{f.db.close();}});
test('new room participant cannot see older requests or receive old receipts',()=>{const f=fixture();try{
 const {x}=receipt(f);addThreadMember(f.db,f.thread.id,'eve');assert.deepEqual(f.store.list('eve',f.thread.id),[]);assert.throws(()=>f.store.consumeReceipt('alice',f.thread.id,x.id,hash));
}finally{f.db.close();}});
test('policy revision and revoke cancel pending work and block late result',()=>{for(const change of ['revision','revoke']){const f=fixture();try{
 const {r,x}=receipt(f);if(change==='revision')f.store.putPolicy('alice','policy',{...f.policy,audience:[]});else f.store.revokePolicy('alice','policy');
 assert.throws(()=>f.store.consumeReceipt('alice',f.thread.id,x.id,hash));assert.throws(()=>f.store.claim('alice',r.id,{generation:1,deviceId:'mac'}));assert.equal(f.store.list('bob',f.thread.id)[0].status,'cancelled');
}finally{f.db.close();}}});
test('waiting requests survive database restart, and cancelled generations never resume',()=>{
 const dir=mkdtempSync(join(tmpdir(),'resource-store-'));const file=join(dir,'test.db');const f=fixture(file);const r=f.store.request('bob',f.thread.id,f.request);f.db.close();
 const db=openDb(file);try{const store=new ResourceStore(db);assert.equal(store.list('alice',f.thread.id)[0].id,r.id);store.cancel('bob',r.id);assert.throws(()=>store.claim('alice',r.id,{generation:1,deviceId:'mac'}));assert.equal(store.request('bob',f.thread.id,f.request).status,'cancelled');}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('owner hide cleanup revokes only room policies and cancels own pending requests',()=>{const f=fixture();try{
 f.store.putPolicy('alice','room',{...f.policy,threadId:f.thread.id});const r=f.store.request('bob',f.thread.id,{...f.request,policyId:'room'});
 f.store.cleanupThread('alice',f.thread.id);hideThread(f.db,f.thread.id,'alice');assert.equal(f.store.policies('alice').find(p=>p.id==='room')!.revoked,true);assert.equal(f.store.policies('alice').find(p=>p.id==='policy')!.revoked,false);assert.equal(f.store.list('bob',f.thread.id)[0].status,'cancelled');assert.throws(()=>f.store.claim('alice',r.id,{generation:1,deviceId:'mac'}));
}finally{f.db.close();}});
test('identical desktop sync preserves revision and active requests',()=>{const f=fixture();try{const r=running(f);assert.equal(f.store.putPolicy('alice','policy',f.policy).revision,1);assert.equal(f.store.list('alice',f.thread.id)[0].status,'running');assert.equal(r.policyRevision,1);}finally{f.db.close();}});
test('owner picker can bind unregistered request to newly selected file root',()=>{const f=fixture();try{
 const r=f.store.request('bob',f.thread.id,{...f.request,rootId:'unselected',path:'unknown.txt',policyId:null});
 f.store.putPolicy('alice','selected',{...f.policy,rootId:'picked-file',prefix:'',kind:'file',excluded:[],threadId:f.thread.id});
 const approved=f.store.decide('alice',r.id,{approved:true,policyId:'selected'});assert.equal(approved.rootId,'picked-file');assert.equal(approved.path,'');assert.equal(f.store.claim('alice',r.id,{generation:1,deviceId:'mac'}).status,'running');
}finally{f.db.close();}});
test('sensitive wait stores only fixed redacted metadata and requires owner-approved content digest',()=>{const f=fixture();try{
 const r=running(f);const input={generation:1,claimToken:r.claimToken,reason:'sensitive',contentDigest:'a'.repeat(64),preview:'credential hidden'};
 assert.throws(()=>f.store.waitApproval('alice',r.id,{...input,preview:'password=secret12345'}));
 const waiting=f.store.waitApproval('alice',r.id,input);assert.equal(waiting.status,'waiting-owner');assert(!waiting.preview?.includes('credential'));assert.equal(waiting.approvedDigest,undefined);
 assert.throws(()=>f.store.decide('bob',r.id,{approved:true}));f.store.decide('alice',r.id,{approved:true});const c=f.store.claim('alice',r.id,{generation:1,deviceId:'mac'});
 const args={requestId:r.id,generation:1,claimToken:c.claimToken,policyId:'policy',contentHash:hash};assert.throws(()=>f.store.issueReceipt('alice',args));assert.throws(()=>f.store.issueReceipt('alice',{...args,contentDigest:'b'.repeat(64)}));assert(f.store.issueReceipt('alice',{...args,contentDigest:input.contentDigest}).id);
}finally{f.db.close();}});
test('expired lease can be reclaimed after restart while old token and receipt are rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'resource-lease-'));const file=join(dir,'test.db');const f=fixture(file);const {r,x}=receipt(f);
 f.db.prepare('UPDATE resource_requests SET data=? WHERE id=?').run(JSON.stringify({...r,leaseUntil:Date.now()-1}),r.id);f.db.close();
 const db=openDb(file);try{const store=new ResourceStore(db);const c=store.claim('alice',r.id,{generation:1,deviceId:'mac'});assert.notEqual(c.claimToken,r.claimToken);assert.throws(()=>store.consumeReceipt('alice',f.thread.id,x.id,hash));assert.throws(()=>store.complete('alice',r.id,{generation:1,claimToken:r.claimToken,status:'failed'}));}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('separate SQLite connections cannot both claim the same request',()=>{const dir=mkdtempSync(join(tmpdir(),'resource-claim-'));const file=join(dir,'test.db');const f=fixture(file);const r=f.store.request('bob',f.thread.id,f.request);const second=openDb(file);try{const other=new ResourceStore(second);f.store.claim('alice',r.id,{generation:1,deviceId:'mac'});assert.throws(()=>other.claim('alice',r.id,{generation:1,deviceId:'mac'}));}finally{second.close();f.db.close();rmSync(dir,{recursive:true,force:true});}});
test('failed publication transaction rolls back receipt consumption',()=>{const f=fixture();try{const {x}=receipt(f);f.db.exec('BEGIN');f.store.consumeReceipt('alice',f.thread.id,x.id,hash);f.db.exec('ROLLBACK');assert.equal(f.store.consumeReceipt('alice',f.thread.id,x.id,hash).source,'local');}finally{f.db.close();}});
test('desktop revisions remain monotonic and reject stale metadata overwrites',()=>{const f=fixture();try{
 assert.equal(f.store.putPolicy('alice','policy',{...f.policy,revision:1}).revision,1);
 assert.throws(()=>f.store.putPolicy('alice','policy',{...f.policy,audience:[],revision:1}));
 assert.equal(f.store.putPolicy('alice','policy',{...f.policy,audience:[],revision:7}).revision,7);
 assert.throws(()=>f.store.putPolicy('alice','policy',{...f.policy,revision:2}));
 assert.equal(f.store.putPolicy('alice','imported',{...f.policy,revision:12}).revision,12);
 f.store.revokePolicy('alice','imported');assert.equal(f.store.putPolicy('alice','imported',{...f.policy,revision:13,revoked:true}).revoked,true);
}finally{f.db.close();}});
test('owner startup list includes own requests only and excludes hidden rooms',()=>{const f=fixture();try{f.store.request('bob',f.thread.id,f.request);assert.equal(f.store.listOwned('alice').length,1);assert.equal(f.store.listOwned('bob').length,0);hideThread(f.db,f.thread.id,'alice');assert.equal(f.store.listOwned('alice').length,0);}finally{f.db.close();}});
test('owner-picked binding does not duplicate original pending request after retry',()=>{const f=fixture();try{
 const input={...f.request,rootId:'unknown',policyId:null};const r=f.store.request('bob',f.thread.id,input);f.store.decide('alice',r.id,{approved:true,policyId:'policy',path:'src/app.ts'});assert.equal(f.store.request('bob',f.thread.id,input).id,r.id);assert.equal(f.store.listOwned('alice').length,1);
}finally{f.db.close();}});
test('only the latest receipt for a request can publish',()=>{const f=fixture();try{const {r,x}=receipt(f);const newer=f.store.issueReceipt('alice',{requestId:r.id,generation:r.generation,claimToken:r.claimToken,policyId:'policy',contentHash:hash});assert.throws(()=>f.store.consumeReceipt('alice',f.thread.id,x.id,hash));assert(f.store.consumeReceipt('alice',f.thread.id,newer.id,hash));}finally{f.db.close();}});
test('private owner original request cannot be borrowed by another participant',()=>{const f=fixture();try{
 const original=addMessage(f.db,{threadId:f.thread.id,author:'alice',authorType:'human',kind:'decision_result',body:'Continue privately',privateTo:'alice'});
 const args={...f.request,messageId:original.id};assert.throws(()=>f.store.request('bob',f.thread.id,args));
 const r=f.store.request('alice',f.thread.id,args);assert.deepEqual(r.audience,['alice']);assert.equal(f.store.list('bob',f.thread.id).length,0);assert.equal(f.store.listOwned('alice').length,1);
}finally{f.db.close();}});
test('work folder policy permits authenticated room members and preserves exclusions and revocation',()=>{const f=fixture();try{
 const p=f.store.putPolicy('alice','work',{...f.policy,prefix:'',audience:['alice'],workFolder:true});
 const r=f.store.request('bob',f.thread.id,{...f.request,policyId:p.id});assert.equal(r.status,'waiting-connection');
 assert.throws(()=>f.store.request('eve',f.thread.id,{...f.request,policyId:p.id}));
 assert.throws(()=>f.store.request('bob',f.thread.id,{...f.request,policyId:p.id,path:'src/private/key'}));
 f.store.revokePolicy('alice',p.id);assert.equal(f.store.listOwned('alice').find(x=>x.id===r.id)?.status,'cancelled');
 assert.throws(()=>f.store.putPolicy('alice','invalid',{...f.policy,workFolder:true}));
}finally{f.db.close();}});
test('owner selection is remembered only for its approved alias and room',()=>{const f=fixture();try{
 const original={...f.request,rootId:'unselected-alias',path:'notes.md',policyId:null};const r=f.store.request('bob',f.thread.id,original);
 const p=f.store.putPolicy('alice','picked',{...f.policy,rootId:'picked-root',prefix:'',kind:'file',threadId:f.thread.id});
 f.store.decide('alice',r.id,{approved:true,policyId:p.id});
 const m=addMessage(f.db,{threadId:f.thread.id,author:'bob',authorType:'human',kind:'text',body:'Read it again'});
 const next=f.store.request('bob',f.thread.id,{...original,messageId:m.id});assert.equal(next.status,'waiting-connection');assert.equal(next.rootId,'picked-root');assert.equal(next.path,'');
 assert.equal(f.store.request('bob',f.thread.id,{...original,messageId:m.id,path:'other.md'}).status,'waiting-owner');
 f.store.revokePolicy('alice',p.id);const last=addMessage(f.db,{threadId:f.thread.id,author:'bob',authorType:'human',kind:'text',body:'After revoke'});assert.equal(f.store.request('bob',f.thread.id,{...original,messageId:last.id}).status,'waiting-owner');
}finally{f.db.close();}});
test('selected directory maps the requested folder and children, never sibling paths',()=>{const f=fixture();try{
 const original={...f.request,rootId:'unknown',path:'plan',policyId:null,action:'list'};const r=f.store.request('bob',f.thread.id,original);
 const p=f.store.putPolicy('alice','folder',{...f.policy,rootId:'selected-plan',prefix:'',threadId:f.thread.id,excluded:['private']});f.store.decide('alice',r.id,{approved:true,policyId:p.id,path:''});
 const m=addMessage(f.db,{threadId:f.thread.id,author:'bob',authorType:'human',kind:'text',body:'Read spec'});
 const next=f.store.request('bob',f.thread.id,{...original,messageId:m.id,action:'read',path:'plan/spec.md'});assert.equal(next.status,'waiting-connection');assert.equal(next.path,'spec.md');
 for(const path of ['plan-other/spec.md','plan/private/key'])assert.equal(f.store.request('bob',f.thread.id,{...original,messageId:m.id,action:'read',path}).status,'waiting-owner');
}finally{f.db.close();}});
