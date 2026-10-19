import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread,addThreadMember} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
test('대화 요약은 참여자에게 공유되고 혼잣말 요약은 본인에게만 보인다',async()=>{
 const db=openDb(':memory:');upsertUser(db,'나','a');upsertUser(db,'동료','b');const t=createThread(db,'요약 검증','나');addThreadMember(db,t.id,'동료');
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 const url=`http://127.0.0.1:${(srv.address() as {port:number}).port}/api/threads/${t.id}/messages`;
 const post=(extra={})=>fetch(url,{method:'POST',headers:{Authorization:'Bearer a','Content-Type':'application/json'},body:JSON.stringify({authorType:'agent',author:'나',kind:'summary',body:'검토 결과',...extra})});
 try {
  assert.equal((await post()).status,200);
  assert.equal((await post({body:'비공개 결론',privateTo:'나'})).status,200);
  assert.equal((await post({authorType:'human'})).status,400);
  const get=(token:string)=>fetch(url,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
  const mine=await get('a');const peer=await get('b');
  assert.equal(mine.length,2);assert.equal(peer.length,1);assert.equal(peer[0].kind,'summary');assert.equal(peer[0].body,'검토 결과');
 }finally{srv.close();db.close();}
});
