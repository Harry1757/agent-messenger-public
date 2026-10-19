import {test} from 'node:test';import assert from 'node:assert/strict';import {openDb,upsertUser} from '../server/db.ts';import {buildApp} from '../server/routes.ts';
test('approved file audience cannot expand through file contents, later mentions or stale audience',async()=>{
 const db=openDb(':memory:');for(const n of ['owner','peer','stranger'])upsertUser(db,n,n);const srv=buildApp(db,{securityLock:true}).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 const call=(path:string,body?:object,user='owner')=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','X-Agent-Protocol':'conversation-only-v1'},...(body?{body:JSON.stringify(body)}:{})});
 try{const t=await(await call('/threads',{title:'shared files'})).json();const p='/threads/'+t.id+'/messages';await call(p,{authorType:'human',kind:'text',body:'@peer hello',direct:true});
 assert.equal((await call(p,{author:'owner',authorType:'agent',kind:'text',body:'file contents @stranger',fileAudience:['owner','peer']})).status,200);
 assert.equal((await call(p,undefined,'stranger')).status,404);
 assert.equal((await call(p,{authorType:'human',kind:'text',body:'@stranger join',direct:true})).status,409);
 assert.equal((await call(p,{author:'owner',authorType:'agent',kind:'text',body:'MUST_NOT_LEAK',fileAudience:['owner','peer','stranger']})).status,409);
 assert(!(await(await call(p)).json()).some((m:any)=>m.body==='MUST_NOT_LEAK'));
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});

test('legacy compatibility: approved README result passes request filter but secrets and wrong audience stay blocked',async()=>{
 const {addMessage,createThread,addThreadMember}=await import('../server/db.ts');const {createHash}=await import('node:crypto');const db=openDb(':memory:');for(const n of ['owner','peer'])upsertUser(db,n,n);const t=createThread(db,'read','owner');addThreadMember(db,t.id,'peer');
 const q=addMessage(db,{threadId:t.id,author:'owner',authorType:'agent',kind:'decision_request',privateTo:'owner',body:JSON.stringify({fileAccess:true,question:'project/README.md — 읽기 및 내용 공유를 승인하시겠어요?'})});
 const srv=buildApp(db,{securityLock:false}).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api/threads/${t.id}/messages`;
 const post=(content:string,audience=['owner','peer'])=>fetch(base,{method:'POST',headers:{Authorization:'Bearer owner','Content-Type':'application/json','X-Agent-Protocol':'conversation-only-v1'},body:JSON.stringify({author:'owner',authorType:'agent',kind:'text',body:`소유자가 승인한 파일 내용: README.md\n내용 해시: ${createHash('sha256').update(content).digest('hex')}\n\n${content}`,fileAudience:audience})});
 try{
 assert.equal((await post('Docs use /Users/example/Desktop/project')).status,422);
 addMessage(db,{threadId:t.id,author:'owner',authorType:'human',kind:'decision_result',privateTo:'owner',decisionRequestId:q.id,body:'@owner 파일 작업 1회 승인'});
 assert.equal((await post('Docs use /Users/example/Desktop/project\n')).status,200);
 assert.equal((await post('Docs use /Users/example/Desktop/project',['owner'])).status,409);
 assert.equal((await post('-----BEGIN OPENSSH PRIVATE KEY-----')).status,422);
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});
