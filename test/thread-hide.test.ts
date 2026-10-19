import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread,addThreadMember,hideThread,listVisibleThreads,listThreads} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
test('deleting from list is per-user, idempotent and retains shared thread',()=>{
 const db=openDb(':memory:');try{for(const n of ['a','b'])upsertUser(db,n,n);const t=createThread(db,'test','a');addThreadMember(db,t.id,'b');hideThread(db,t.id,'a');hideThread(db,t.id,'a');assert.equal(listVisibleThreads(db,'a').length,0);assert.equal(listVisibleThreads(db,'b').length,1);assert.equal(listThreads(db,'a').length,1);}finally{db.close();}
});
test('delete route rejects outsiders and hides only authenticated member list',async()=>{
 const db=openDb(':memory:');for(const n of ['a','b'])upsertUser(db,n,n);const t=createThread(db,'test','a');const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 try{assert.equal((await fetch(`${base}/threads/${t.id}`,{method:'DELETE',headers:{Authorization:'Bearer b'}})).status,404);assert.equal((await fetch(`${base}/threads/${t.id}`,{method:'DELETE',headers:{Authorization:'Bearer a'}})).status,200);assert.deepEqual(await(await fetch(`${base}/threads`,{headers:{Authorization:'Bearer a'}})).json(),[]);}finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});

test('hiding cancels only own unanswered decisions and never approves a file', async()=>{
 const {addMessage,listMessages}=await import('../server/db.ts');const db=openDb(':memory:');try{
 for(const n of ['a','b'])upsertUser(db,n,n);const t=createThread(db,'test','a');addThreadMember(db,t.id,'b');
 const own=addMessage(db,{threadId:t.id,author:'a',authorType:'agent',kind:'decision_request',body:'file approval',privateTo:'a'});
 addMessage(db,{threadId:t.id,author:'b',authorType:'agent',kind:'decision_request',body:'other approval',privateTo:'b'});
 const cancelled=hideThread(db,t.id,'a');assert.equal(cancelled.length,1);assert.equal(cancelled[0].decisionRequestId,own.id);assert.equal(cancelled[0].body,'대화 삭제로 요청을 취소했습니다.');assert.equal(hideThread(db,t.id,'a').length,0);assert(!listMessages(db,t.id,'b').some(m=>m.kind==='decision_result'));
 }finally{db.close();}
});

test('hidden conversations stop events and late agent decisions only for the deleting member',async()=>{
 const db=openDb(':memory:');for(const n of ['a','b'])upsertUser(db,n,n);const t=createThread(db,'hide','a');addThreadMember(db,t.id,'b');
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;const abort=new AbortController();let events='';
 try{
  const stream=await fetch(base+'/events',{headers:{Authorization:'Bearer a'},signal:abort.signal});
  const reader=stream.body!.getReader();const drain=(async()=>{try{while(true){const x=await reader.read();if(x.done)return;events+=new TextDecoder().decode(x.value);}}catch{}})();
  await fetch(`${base}/threads/${t.id}`,{method:'DELETE',headers:{Authorization:'Bearer a'}});
  const post=(user:string)=>fetch(`${base}/threads/${t.id}/messages`,{method:'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json'},body:JSON.stringify({authorType:'agent',author:user,kind:'decision_request',body:'late decision'})});
  assert.equal((await post('a')).status,409);assert.equal((await post('b')).status,200);
  await new Promise(r=>setTimeout(r,30));assert(events.includes('thread-hidden'));assert(!events.includes('late decision'));
  assert.deepEqual(await(await fetch(base+'/hidden-threads',{headers:{Authorization:'Bearer a'}})).json(),[t.id]);
  abort.abort();await drain;
 }finally{abort.abort();srv.closeAllConnections();await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});

test('calling an agent who hid the room is rejected immediately, without creating a waiting message',async()=>{
 const {listMessages}=await import('../server/db.ts');const db=openDb(':memory:');for(const n of ['a','b'])upsertUser(db,n,n);const t=createThread(db,'hidden target','a');addThreadMember(db,t.id,'b');hideThread(db,t.id,'a');
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 try{
 const response=await fetch(`${base}/threads/${t.id}/messages`,{method:'POST',headers:{Authorization:'Bearer b','Content-Type':'application/json'},body:JSON.stringify({authorType:'human',kind:'text',body:'@a 확인해주세요'})});
 assert.equal(response.status,409);assert.match((await response.json()).error,/새 대화/);assert.equal(listMessages(db,t.id,'b').length,0);
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});
