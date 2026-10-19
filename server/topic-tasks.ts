import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Express} from 'express';
import {canAccessThread,listMessages} from './db.ts';
import {extractMentions} from '../shared/mentions.ts';

export type TopicState='running'|'waiting-owner'|'waiting-connection'|'waiting-agent'|'completed'|'failed'|'cancelled';
export interface TopicTask {id:string;threadId:string;messageId:number;owner:string;generation:number;state:TopicState;claimToken:string|null;leaseUntil:number;attempts:number;resultId:number|null;reason:string|null;}
export class TopicTasks {
 private db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS topic_tasks(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner TEXT NOT NULL, message_id INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(thread_id,owner,message_id));');}
 private access(owner:string,thread:string){if(!canAccessThread(this.db,thread,owner)||this.db.prepare('SELECT 1 FROM hidden_threads WHERE thread_id=? AND user_name=?').get(thread,owner))throw Error('대화를 찾을 수 없습니다');}
 private save(t:TopicTask){this.db.prepare('INSERT INTO topic_tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id,t.threadId,t.owner,t.messageId,JSON.stringify(t));return t;}
 reconcileResources(thread:string,owner?:string){
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_requests'").get())return;
  const resources=this.db.prepare('SELECT data FROM resource_requests WHERE thread_id=?').all(thread).map(row=>JSON.parse(String(row.data)));
  for(const row of this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=?').all(thread)){
   const task:TopicTask=JSON.parse(String(row.data));
   if(!['waiting-owner','running','failed'].includes(task.state)||task.reason!=='자료 접근 확인'||owner!==undefined&&task.owner!==owner)continue;
   const related=resources.filter(r=>r.owner===task.owner&&r.threadId===task.threadId&&(r.triggerMessageId??r.messageId)===task.messageId);
   if(!related.length||related.some(r=>!['completed','denied','failed','cancelled'].includes(r.status)))continue;
   if(related.every(r=>r.status==='completed')){task.state='completed';task.reason='자료 확인을 완료했습니다';}
   else if(related.some(r=>r.status==='denied')){task.state='failed';task.reason='자료 소유자가 공유를 거절했습니다';}
   else if(related.some(r=>r.status==='failed')){task.state='failed';task.reason='자료 확인에 실패했습니다';}
   else{task.state='cancelled';task.reason='자료 요청이 취소되었습니다';}
   task.claimToken=null;task.leaseUntil=0;this.save(task);
   if(['failed','cancelled'].includes(task.state))for(const parentRow of this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=?').all(thread)){const parent:TopicTask=JSON.parse(String(parentRow.data));if(parent.state==='waiting-agent'&&parent.resultId===task.messageId){parent.state=task.state;parent.reason=task.reason;parent.claimToken=null;this.save(parent);}}
  }
 }
 private expire(t:TopicTask){if(t.state==='running'&&t.leaseUntil<=Date.now()){t.state='failed';t.reason='실행 연결이 끊겨 다시 시도할 수 있습니다';t.claimToken=null;t.leaseUntil=0;t.generation++;this.save(t);}return t;}
 list(owner:string,thread:string){this.access(owner,thread);this.reconcileResources(thread);return this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=?').all(thread).map(r=>this.expire(JSON.parse(String(r.data)) as TopicTask)).filter(t=>listMessages(this.db,thread,owner).some(m=>m.id===t.messageId)).map(t=>({...t,claimToken:null}));}
 begin(owner:string,thread:string,messageId:number){this.access(owner,thread);const m=listMessages(this.db,thread,owner).find(m=>m.id===messageId);if(!m||m.direct||m.kind==='decision_request'||m.authorType==='agent'&&(m.agentTarget!==owner||m.author===owner))throw Error('처리할 요청이 아닙니다');if(m.authorType==='human'&&!extractMentions(m.body).includes(owner))throw Error('지정된 요청이 아닙니다');
 const previous=this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=? AND owner=? AND message_id=?').get(thread,owner,messageId);let t:TopicTask=previous?JSON.parse(String(previous.data)):{id:randomUUID(),threadId:thread,messageId,owner,generation:1,state:'running',claimToken:null,leaseUntil:0,attempts:0,resultId:null,reason:null};
 if(t.resultId!==null||['completed','cancelled'].includes(t.state)||t.state==='running'&&t.leaseUntil>Date.now()||t.attempts>=4)return {claimed:false,task:{...t,claimToken:null}};
 t.generation++;t.state='running';t.claimToken=randomUUID();t.leaseUntil=Date.now()+15*60*1000;t.attempts++;return {claimed:true,task:this.save(t)};
 }
 private owned(owner:string,id:string){const row=this.db.prepare('SELECT data FROM topic_tasks WHERE id=?').get(id);if(!row)throw Error('요청을 찾을 수 없습니다');const t:TopicTask=JSON.parse(String(row.data));if(t.owner!==owner)throw Error('요청 소유자가 아닙니다');this.access(owner,t.threadId);return t;}
 check(owner:string,thread:string,proof:any){const t=this.owned(owner,proof?.id);if(t.threadId!==thread||t.generation!==proof.generation||t.claimToken!==proof.claimToken||t.state!=='running'||t.leaseUntil<Date.now())throw Error('종료되었거나 다른 실행으로 대체된 요청입니다');return t;}
 finish(owner:string,thread:string,proof:any,state:TopicState,resultId:number|null=null,reason:string|null=null){const t=this.check(owner,thread,proof);t.state=state;t.resultId=resultId;t.reason=reason;t.claimToken=null;t.leaseUntil=0;return this.save(t);}
 transition(owner:string,id:string,input:any){const t=this.owned(owner,id);if(!['waiting-owner','waiting-connection','waiting-agent','failed','cancelled'].includes(input?.state))throw Error('잘못된 상태');return this.finish(owner,t.threadId,{...input,id},input.state,null,typeof input.reason==='string'?input.reason.slice(0,120):null);}
 cancelThread(owner:string,thread:string){for(const row of this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=? AND owner=?').all(thread,owner)){const t:TopicTask=JSON.parse(String(row.data));if(!['completed','failed','cancelled'].includes(t.state)){t.state='cancelled';t.generation++;t.claimToken=null;this.save(t);}}}
 answerDecision(thread:string,messageId:number){for(const row of this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=?').all(thread)){const t:TopicTask=JSON.parse(String(row.data));if(t.state==='waiting-owner'&&t.resultId===messageId){t.state='completed';this.save(t);}}}
 answerDelegation(thread:string,messageId:number){for(const row of this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=?').all(thread)){const t:TopicTask=JSON.parse(String(row.data));if(t.state==='waiting-agent'&&t.resultId===messageId){t.state='completed';this.save(t);}}}
 pending(thread:string){this.reconcileResources(thread);return this.db.prepare('SELECT data FROM topic_tasks WHERE thread_id=?').all(thread).map(r=>this.expire(JSON.parse(String(r.data)) as TopicTask)).some(t=>!['completed','failed','cancelled'].includes(t.state));}
}
export function mountTopicTasks(app:Express,db:DatabaseSync,changed:(thread:string)=>void){const store=new TopicTasks(db);const run=(fn:(user:string,req:any)=>unknown)=>(req:any,res:any)=>{try{const result=fn(res.locals.user,req);res.json(result);const threadId=(result as TopicTask)?.threadId??req.params.id;changed(threadId);}catch(e){res.status(409).json({error:(e as Error).message});}};
 app.get('/api/threads/:id/tasks',(r,s)=>{try{s.json(store.list(s.locals.user,r.params.id));}catch{s.status(404).json({error:'대화를 찾을 수 없습니다'});}});
 app.post('/api/threads/:id/tasks',run((u,r)=>store.begin(u,r.params.id,r.body?.messageId)));
 app.post('/api/tasks/:id/state',run((u,r)=>store.transition(u,r.params.id,r.body)));
 return store;
}
