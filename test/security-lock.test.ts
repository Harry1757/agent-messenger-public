import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread,listMessages} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
test('구버전 결과는 차단하고 일반 질문과 직접 대화는 유지한다',async()=>{
 const db=openDb(':memory:');upsertUser(db,'사용자','token');
 const srv=buildApp(db,{securityLock:true}).listen(0);
 await new Promise(r=>srv.once('listening',r));
 const base=`http://127.0.0.1:${(srv.address() as any).port}`;
 const send=async(url:string,body:unknown)=>fetch(base+url,{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
 const t=await(await send('/api/threads',{title:'보안 테스트'})).json();
 for(const kind of ['text','summary','decision_request'])assert.equal((await send(`/api/threads/${t.id}/messages`,{authorType:'agent',author:'사용자',kind,body:'private data'})).status,423);
 assert.equal((await send(`/api/threads/${t.id}/messages`,{authorType:'human',kind:'text',body:'@사용자 안녕하세요'})).status,200);
 assert.equal((await send(`/api/threads/${t.id}/messages`,{authorType:'human',kind:'text',body:'안녕하세요',direct:true})).status,200);
 const messages=listMessages(db,t.id,'사용자');
 assert.equal(messages.length,3);
 assert.match(messages[0].body,/답변 게시가 차단/);
 assert(!messages.some(m=>m.body.includes('private data')));
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});
