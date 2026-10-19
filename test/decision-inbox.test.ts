import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread,addMessage} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';

test('요청함은 담당자의 미응답 요청만 반환하고 공개 요청 맥락에 혼잣말을 섞지 않는다',async()=>{
 const db=openDb(':memory:'); upsertUser(db,'나','a');upsertUser(db,'동료','b');
 const t=createThread(db,'배포 결정');
 const add=(extra:object)=>addMessage(db,{threadId:t.id,author:'나',authorType:'agent',kind:'text',body:'공개 근거',...extra});
 add({privateTo:'나',body:'비밀 대화'});
 const mine=add({kind:'decision_request',body:JSON.stringify({question:'범위?',summary:'검토 요약',options:['필수만']})});
 add({author:'동료',kind:'decision_request',body:'{}'});
 const done=add({kind:'decision_request',body:'{}'});
 add({authorType:'human',kind:'decision_result',decisionRequestId:done.id});
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 const base=`http://127.0.0.1:${(srv.address() as {port:number}).port}/api`;
 try {
  assert.equal((await fetch(`${base}/decisions`)).status,401);
  const get=()=>fetch(`${base}/decisions`,{headers:{Authorization:'Bearer a'}}).then(r=>r.json());
  const first=await get(); assert.equal(first.length,1);assert.equal(first[0].request.id,mine.id);
  assert.equal(first[0].threadTitle,'배포 결정');assert.ok(!JSON.stringify(first).includes('비밀 대화'));
  assert.deepEqual(await get(),first); // 읽거나 창을 다시 열어도 남아 있다.
  const answer=await fetch(`${base}/threads/${t.id}/messages`,{method:'POST',headers:{Authorization:'Bearer a','Content-Type':'application/json'},body:JSON.stringify({authorType:'human',kind:'decision_result',body:'직접 답변',decisionRequestId:mine.id})});
  assert.equal(answer.status,200); assert.deepEqual(await get(),[]);
 }finally{srv.close();db.close();}
});
