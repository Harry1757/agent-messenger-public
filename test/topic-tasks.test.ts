import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {openDb,upsertUser,createThread,addMessage} from '../server/db.ts';
import {TopicTasks,mountTopicTasks} from '../server/topic-tasks.ts';
function fixture(){const db=openDb(':memory:');upsertUser(db,'owner','a');const thread=createThread(db,'test','owner');const message=addMessage(db,{threadId:thread.id,author:'owner',authorType:'human',kind:'text',body:'@owner question'});return {db,thread,message,store:new TopicTasks(db)};}
test('answering exact decision completes original waiting-owner task',()=>{
 const f=fixture();try{const task=f.store.begin('owner',f.thread.id,f.message.id).task;
 f.store.finish('owner',f.thread.id,task,'waiting-owner',123);assert.equal(f.store.pending(f.thread.id),true);
 f.store.answerDecision(f.thread.id,124);assert.equal(f.store.pending(f.thread.id),true);
 f.store.answerDecision(f.thread.id,123);assert.equal(f.store.pending(f.thread.id),false);assert.equal(f.store.list('owner',f.thread.id)[0].state,'completed');
 }finally{f.db.close();}
});
test('expired running lease becomes failed, releases room, rejects stale proof, and can retry',()=>{
 const f=fixture();try{const task=f.store.begin('owner',f.thread.id,f.message.id).task;
 f.db.prepare('UPDATE topic_tasks SET data=? WHERE id=?').run(JSON.stringify({...task,leaseUntil:Date.now()-1}),task.id);
 assert.equal(f.store.pending(f.thread.id),false);const expired=f.store.list('owner',f.thread.id)[0];assert.equal(expired.state,'failed');assert.equal(expired.claimToken,null);
 assert.throws(()=>f.store.check('owner',f.thread.id,task));const retry=f.store.begin('owner',f.thread.id,f.message.id);assert.equal(retry.claimed,true);assert.ok(retry.task.generation>task.generation);
 }finally{f.db.close();}
});
test('one completed decision does not complete another waiting topic',()=>{
 const f=fixture();try{const first=f.store.begin('owner',f.thread.id,f.message.id).task;f.store.finish('owner',f.thread.id,first,'waiting-owner',10);
 const message=addMessage(f.db,{threadId:f.thread.id,author:'owner',authorType:'human',kind:'text',body:'@owner another question'});const second=f.store.begin('owner',f.thread.id,message.id).task;f.store.finish('owner',f.thread.id,second,'waiting-owner',11);
 f.store.answerDecision(f.thread.id,10);assert.equal(f.store.pending(f.thread.id),true);
 }finally{f.db.close();}
});
test('state transition broadcasts thread ID while GET never broadcasts',async()=>{
 const f=fixture();const app=express();app.use(express.json(),(_req,res,next)=>{res.locals.user='owner';next();});const changed:string[]=[];const store=mountTopicTasks(app,f.db,id=>changed.push(id));const task=store.begin('owner',f.thread.id,f.message.id).task;
 const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 try{const read=await fetch(`${url}/api/threads/${f.thread.id}/tasks`);assert.equal(read.status,200);assert.deepEqual(changed,[]);
 const response=await fetch(`${url}/api/tasks/${task.id}/state`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...task,state:'waiting-connection'})});assert.equal(response.status,200);assert.deepEqual(changed,[f.thread.id]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.db.close();}
});
for(const [status,state,reason] of [['denied','failed','거절'],['cancelled','cancelled','취소'],['completed','completed','완료'],['failed','failed','실패']]){
 test(`terminal resource ${status} settles matching source task`,()=>{
  const f=fixture();try{const task=f.store.begin('owner',f.thread.id,f.message.id).task;f.store.finish('owner',f.thread.id,task,'waiting-owner',null,'자료 접근 확인');
  f.db.exec('CREATE TABLE resource_requests(id TEXT,thread_id TEXT,data TEXT)');
  const insert=(id:string,overrides:any)=>f.db.prepare('INSERT INTO resource_requests VALUES(?,?,?)').run(id,f.thread.id,JSON.stringify({owner:'owner',threadId:f.thread.id,messageId:f.message.id,status,...overrides}));
  insert('wrong-owner',{owner:'other'});insert('wrong-message',{messageId:999});insert('wrong-room',{threadId:'other'});
  assert.equal(f.store.pending(f.thread.id),true);insert('matching',{});
  assert.equal(f.store.pending(f.thread.id),false);const actual=f.store.list('owner',f.thread.id)[0];assert.equal(actual.state,state);assert.match(actual.reason!,new RegExp(reason));
  }finally{f.db.close();}
 });
}
test('any active resource keeps parent waiting and missing resource table is supported',()=>{
 const f=fixture();try{const task=f.store.begin('owner',f.thread.id,f.message.id).task;f.store.finish('owner',f.thread.id,task,'waiting-owner',null,'자료 접근 확인');assert.equal(f.store.pending(f.thread.id),true);
 f.db.exec('CREATE TABLE resource_requests(id TEXT,thread_id TEXT,data TEXT)');for(const [id,status] of [['a','completed'],['b','waiting-connection']])f.db.prepare('INSERT INTO resource_requests VALUES(?,?,?)').run(id,f.thread.id,JSON.stringify({owner:'owner',threadId:f.thread.id,messageId:f.message.id,status}));
 assert.equal(f.store.pending(f.thread.id),true);
 }finally{f.db.close();}
});

test('denied delegated resource settles both waiting tasks using its persisted trigger message',async()=>{const {ResourceStore}=await import('../server/resource-store.ts');const {db,thread:t,message,store:tasks}=fixture();upsertUser(db,'peer','peer');addMessage(db,{threadId:t.id,author:'owner',authorType:'human',kind:'text',body:'@peer joined',direct:true});try{const a=tasks.begin('owner',t.id,message.id).task;const delegated=addMessage(db,{threadId:t.id,author:'owner',authorType:'agent',kind:'text',body:'read',agentTarget:'peer',agentAction:'request'});tasks.finish('owner',t.id,a,'waiting-agent',delegated.id);const b=tasks.begin('peer',t.id,delegated.id).task;tasks.finish('peer',t.id,b,'waiting-owner',null,'자료 접근 확인');const resources=new ResourceStore(db);const r=resources.request('peer',t.id,{messageId:message.id,triggerMessageId:delegated.id,owner:'peer',deviceId:'device',source:'local',rootId:'unselected',path:'README.md'});assert.equal(r.triggerMessageId,delegated.id);resources.decide('peer',r.id,{approved:false});const states=tasks.list('owner',t.id);assert(states.every(t=>t.state==='failed'));assert.equal(tasks.pending(t.id),false);}finally{db.close();}});

for(const status of ['failed','denied','cancelled','completed']){
 test(`resumed resource task leaves running when all resources are ${status}`,()=>{
  const f=fixture();try{
   const first=f.store.begin('owner',f.thread.id,f.message.id).task;
   f.store.finish('owner',f.thread.id,first,'waiting-owner',null,'자료 접근 확인');
   const resumed=f.store.begin('owner',f.thread.id,f.message.id).task;
   f.db.exec('CREATE TABLE resource_requests(id TEXT,thread_id TEXT,data TEXT)');
   for(const id of ['root','child'])f.db.prepare('INSERT INTO resource_requests VALUES(?,?,?)').run(id,f.thread.id,JSON.stringify({owner:'owner',threadId:f.thread.id,messageId:f.message.id,status}));
   assert.equal(f.store.pending(f.thread.id),false);
   assert.equal(f.store.list('owner',f.thread.id)[0].state,status==='denied'?'failed':status);
   assert.throws(()=>f.store.check('owner',f.thread.id,resumed));
  }finally{f.db.close();}
 });
}
test('resumed task stays running while any related resource is still active',()=>{
 const f=fixture();try{const first=f.store.begin('owner',f.thread.id,f.message.id).task;f.store.finish('owner',f.thread.id,first,'waiting-owner',null,'자료 접근 확인');const resumed=f.store.begin('owner',f.thread.id,f.message.id).task;
 f.db.exec('CREATE TABLE resource_requests(id TEXT,thread_id TEXT,data TEXT)');for(const [id,status]of [['a','failed'],['b','running']])f.db.prepare('INSERT INTO resource_requests VALUES(?,?,?)').run(id,f.thread.id,JSON.stringify({owner:'owner',threadId:f.thread.id,messageId:f.message.id,status}));
 assert.equal(f.store.pending(f.thread.id),true);assert.equal(f.store.check('owner',f.thread.id,resumed).state,'running');
 }finally{f.db.close();}
});
