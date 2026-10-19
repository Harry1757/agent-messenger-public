import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread,addMessage,listMessages} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';

test('결정은 담당자만 자유 입력 가능하고 요청별로 한 번만 답한다',async()=>{
 const db=openDb(':memory:');upsertUser(db,'예제사용자','a');upsertUser(db,'예제동료','b');
 const t=createThread(db,'test','예제사용자');
 const request=addMessage(db,{threadId:t.id,author:'예제동료',authorType:'agent',kind:'decision_request',body:'{"question":"선택?","options":["A"]}'});
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 const url=`http://127.0.0.1:${(srv.address() as {port:number}).port}/api/threads/${t.id}/messages`;
 const post=(token:string,extra={})=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({authorType:'human',kind:'decision_result',body:'직접 입력한 의견',decisionRequestId:request.id,...extra})});
 try{
  assert.equal((await post('a')).status,403);
  assert.equal((await post('b',{decisionRequestId:999})).status,400);
  const result=await post('b');assert.equal(result.status,200);
  const message=await result.json();assert.equal(message.decisionRequestId,request.id);assert.equal(message.body,'@예제동료 직접 입력한 의견');
  assert.equal((await post('b')).status,409);
  assert.equal(listMessages(db,t.id,'예제동료').at(-1)?.decisionRequestId,request.id);
 }finally{srv.close();db.close();}
});
test('비공개 결정의 답변도 비공개를 유지한다',async()=>{
 const db=openDb(':memory:');upsertUser(db,'예제사용자','a');upsertUser(db,'예제동료','b');const t=createThread(db,'test','예제사용자');
 const request=addMessage(db,{threadId:t.id,author:'예제사용자',authorType:'agent',kind:'decision_request',body:'{}',privateTo:'예제사용자'});
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 try{
  const res=await fetch(`http://127.0.0.1:${(srv.address() as {port:number}).port}/api/threads/${t.id}/messages`,{method:'POST',headers:{Authorization:'Bearer a','Content-Type':'application/json'},body:JSON.stringify({authorType:'human',kind:'decision_result',body:'답변',decisionRequestId:request.id,privateTo:null})});
  assert.equal(res.status,200);assert.equal((await res.json()).privateTo,'예제사용자');assert.equal(listMessages(db,t.id,'예제동료').length,0);
 }finally{srv.close();db.close();}
});
