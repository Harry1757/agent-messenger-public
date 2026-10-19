import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb,upsertUser} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';

test('대화는 작성자와 공개 멘션 참여자만 조회·변경하고 실시간으로 받는다', async()=>{
 const db=openDb(':memory:');
 for(const name of ['예제사용자','예제동료','서연']) upsertUser(db,name,name);
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 const base=`http://127.0.0.1:${(srv.address() as {port:number}).port}/api`;
 const call=(user:string,path:string,body?:object)=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${user}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 // Header values must be ASCII, while account names remain Korean.
 for(const [name,token] of [['예제사용자','a'],['예제동료','b'],['서연','c']]) upsertUser(db,name,token);
 const abort=new AbortController();
 let received='';
 try {
  const stream=await fetch(base+'/events',{headers:{Authorization:'Bearer c'},signal:abort.signal});
  const reader=stream.body!.getReader();
  const drain=(async()=>{try{while(true){const v=await reader.read();if(v.done)break;received+=new TextDecoder().decode(v.value);}}catch{}})();
  const t=await (await call('a','/threads',{title:'두 사람의 대화'})).json();
  const path=`/threads/${t.id}`;
  const post=(body:string,extra={})=>call('a',path+'/messages',{authorType:'human',kind:'text',body,...extra});
  await post('@예제동료 확인해주세요');
  assert.equal((await call('b',path+'/messages')).status,200);
  assert.deepEqual(await (await call('c','/threads')).json(),[]);
  for(const suffix of ['/messages','/resolve','/resume']){
   assert.equal((await call('c',path+suffix,suffix==='/messages'?undefined:{resolved:true})).status,404);
  }
  assert.equal((await call('c',path+'/messages',{authorType:'human',kind:'text',body:'끼어들기'})).status,404);
  await post('@서연 혼잣말의 멘션은 초대 아님',{privateTo:'예제사용자'});
  await post('서연 이름만 쓴 것도 초대 아님');
  await post('요약 @서연',{authorType:'agent',author:'예제사용자',kind:'summary'});
  assert.equal((await call('c',path+'/messages')).status,404);
  await new Promise(r=>setTimeout(r,50));
  assert.ok(!received.includes(t.id),'실시간 이벤트에도 대화가 없어야 한다');
  await post('@서연 이제 함께 봐주세요');
  assert.equal((await call('c',path+'/messages')).status,200);
  const messages=await (await call('c',path+'/messages')).json();
  assert.ok(!messages.some((m:any)=>m.privateTo));
  assert.equal((await (await call('c','/threads')).json()).length,1);
  await new Promise(r=>setTimeout(r,50));
  assert.ok(received.includes('이제 함께 봐주세요'));
  assert.ok(!received.includes('혼잣말의 멘션'));
  abort.abort();await drain;
 }finally{abort.abort();srv.closeAllConnections();srv.close();db.close();}
});

import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createThread,addMessage,canAccessThread,listThreads} from '../server/db.ts';
test('기존 대화는 작성자와 공개 멘션으로 한 번 복원하고 재시작해도 유지한다',()=>{
 const folder=mkdtempSync(join(tmpdir(),'thread-access-'));
 const file=join(folder,'db.sqlite');
 let db=openDb(file);
 try {
  for(const user of ['예제사용자','예제동료','서연'])upsertUser(db,user,user);
  const t=createThread(db,'기존 대화');
  addMessage(db,{threadId:t.id,author:'예제사용자',authorType:'human',kind:'text',body:'@예제동료 확인'});
  addMessage(db,{threadId:t.id,author:'예제사용자',authorType:'human',kind:'text',body:'@서연 비공개',privateTo:'예제사용자'});
  addMessage(db,{threadId:t.id,author:'예제동료',authorType:'agent',kind:'summary',body:'결론 @서연'});
  createThread(db,'작성자를 알 수 없는 빈 대화');
  db.exec('DROP TABLE thread_members');db.close();db=openDb(file);
  assert.ok(canAccessThread(db,t.id,'예제사용자'));assert.ok(canAccessThread(db,t.id,'예제동료'));
  assert.ok(!canAccessThread(db,t.id,'서연'));
  assert.equal(listThreads(db,'예제사용자').length,1);
  db.close();db=openDb(file);
  assert.ok(!canAccessThread(db,t.id,'서연'));
  assert.ok(canAccessThread(db,t.id,'예제동료'));
 }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});
