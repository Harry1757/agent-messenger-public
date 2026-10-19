import {test} from 'node:test';import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread,addMessage,listMessages} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
import {submitDecision,decisionChoices} from '../daemon/decision-actions.ts';
test('배너 직접 답변은 한글과 구분문자를 보존하고 담당자·중복·비공개 규칙을 따른다',async()=>{
 const db=openDb(':memory:');upsertUser(db,'나','a');upsertUser(db,'동료','b');const t=createThread(db,'banner');
 const request=addMessage(db,{threadId:t.id,author:'나',authorType:'agent',kind:'decision_request',body:JSON.stringify({question:'선택?',summary:'검토 끝',options:['원본 선택 A','B']}),privateTo:'나'});
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 const c={serverUrl:`http://127.0.0.1:${(srv.address() as {port:number}).port}`,token:'a',agentName:'나'};
 try{
  assert.deepEqual(decisionChoices(request).options,['원본 선택 A','B']);
  await assert.rejects(()=>submitDecision({...c,agentName:'동료'},request,'A'));
  const response=await submitDecision(c,request,'직접 입력; key=value 한글');
  assert.equal(response?.body,'@나 직접 입력; key=value 한글');assert.equal(response?.privateTo,'나');
  assert.equal(await submitDecision(c,request,'중복'),null);assert.equal(listMessages(db,t.id,'동료').length,0);
 }finally{srv.close();db.close();}
});
