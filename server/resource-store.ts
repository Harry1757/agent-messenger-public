import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canAccessThread,listMessages} from './db.ts';
import {hasSecret} from './content-safety.ts';

export interface ResourcePolicy {
 id:string; owner:string; deviceId:string; source:'local'|'github'; rootId:string;
 prefix:string; kind:'file'|'directory'; audience:string[]; threadId:string|null;
 excluded:string[]; revision:number; revoked:boolean; label?:string; workFolder?:boolean; dependency?:{parentId:string;parentRevision:number;packageName:string};
}
export function dependencyLive(db:DatabaseSync,p:ResourcePolicy):boolean {
 if(!p.dependency)return true;
 try{const d=p.dependency;const row=db.prepare('SELECT data FROM resource_policies WHERE id=?').get(d.parentId);if(!row)return false;const parent:ResourcePolicy=JSON.parse(String(row.data));
  return p.source==='local'&&p.workFolder!==true&&p.kind==='directory'&&p.threadId!==null&&typeof d.packageName==='string'&&/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(d.packageName)&&!parent.dependency&&!parent.revoked&&parent.owner===p.owner&&parent.deviceId===p.deviceId&&parent.source==='local'&&parent.kind==='directory'&&parent.prefix===''&&parent.revision===d.parentRevision&&(parent.threadId===null||parent.threadId===p.threadId)&&!parent.excluded.some(e=>e===''||e==='package.json')&&p.audience.every(u=>u===parent.owner||parent.workFolder===true||parent.audience.includes(u));
 }catch{return false;}
}
export type ResourceStatus='waiting-owner'|'waiting-connection'|'running'|'completed'|'denied'|'failed'|'cancelled';
export interface PersistentResourceRequest {
 id:string; threadId:string; messageId:number; triggerMessageId?:number; requestKey?:string; privateRead?:boolean; requester:string; owner:string; deviceId:string;
 source:'local'|'github'; action:'read'|'list'; rootId:string; path:string; policyId:string|null; policyRevision:number|null;
 selection?:{rootId:string;deviceId:string;path:string;action:'read'|'list'};
 audience:string[]; generation:number; status:ResourceStatus; claimToken:string|null; attempts:number; leaseUntil?:number; waitReason?:'sensitive'; preview?:string; contentDigest?:string; approvedDigest?:string;
}
export class ResourceError extends Error { status:number; constructor(message:string,status=409){super(message);this.status=status;} }
const fail=(message='자료 요청 권한 또는 현재 상태를 확인해 주세요',status=409):never=>{throw new ResourceError(message,status);};
function id(value:unknown):string {if(typeof value!=='string'||!value.length||value.length>128||hasSecret(value)||!/^[-\p{L}\p{N}_.]+$/u.test(value))return fail('잘못된 식별자',400);return value;}
function path(value:unknown):string {if(typeof value!=='string'||value.length>512||/[\\:\x00-\x1f%]/.test(value)||value.startsWith('/')||value.split('/').some(p=>p==='..'||p==='.'||p==='')&&value!=='')return fail('상대 경로만 허용됩니다',400);if(hasSecret(value))return fail('민감한 정보는 저장할 수 없습니다',422);return value;}
const sorted=(xs:string[])=>[...new Set(xs)].sort();
const same=(a:string[],b:string[])=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const within=(base:string,p:string,kind='directory')=>p===base||(kind==='directory'&&(base===''||p.startsWith(base+'/')));
export class ResourceStore {
 db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec(`
 CREATE TABLE IF NOT EXISTS resource_policies(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS resource_requests(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS resource_requests_thread ON resource_requests(thread_id);
 CREATE TABLE IF NOT EXISTS resource_receipts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner TEXT NOT NULL, thread_id TEXT NOT NULL, policy_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, audience TEXT NOT NULL, content_hash TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
 `);}
 private transaction<T>(fn:()=>T):T {this.db.exec('SAVEPOINT resource_action');try{const result=fn();this.db.exec('RELEASE resource_action');return result;}catch(e){this.db.exec('ROLLBACK TO resource_action');this.db.exec('RELEASE resource_action');throw e;}}
 private access(user:string,thread:string){if(!canAccessThread(this.db,thread,user)||this.db.prepare('SELECT 1 FROM hidden_threads WHERE thread_id=? AND user_name=?').get(thread,user))fail('대화를 찾을 수 없습니다',404);}
 private audience(thread:string):string[]{return this.db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(thread).map(r=>String(r.user_name));}
 private currentAudience(r:PersistentResourceRequest){return r.privateRead?[r.owner]:this.audience(r.threadId);}
 private policy(policyId:string):ResourcePolicy {const row=this.db.prepare('SELECT data FROM resource_policies WHERE id=?').get(policyId);if(!row)fail('공유 설정을 찾을 수 없습니다',404);return JSON.parse(String(row.data));}
 private save(r:PersistentResourceRequest){this.db.prepare('INSERT INTO resource_requests VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.id,r.threadId,r.owner,JSON.stringify(r));return r;}
 private get(requestId:string):PersistentResourceRequest {const row=this.db.prepare('SELECT data FROM resource_requests WHERE id=?').get(id(requestId));if(!row)fail('자료 요청을 찾을 수 없습니다',404);return JSON.parse(String(row.data));}
 private owned(owner:string,requestId:string){const r=this.get(requestId);if(r.owner!==owner)fail('자료 소유자만 처리할 수 있습니다',403);this.access(owner,r.threadId);return r;}
 private validPolicy(r:PersistentResourceRequest,p:ResourcePolicy){if(!dependencyLive(this.db,p)||(r.action==='list'&&p.kind==='file')||p.revoked||p.owner!==r.owner||p.deviceId!==r.deviceId||p.source!==r.source||p.rootId!==r.rootId||(p.threadId!==null&&p.threadId!==r.threadId)||!within(p.prefix,r.path,p.kind)||p.excluded.some(e=>within(e,r.path))||!same(r.audience,this.currentAudience(r))||!(p.workFolder===true||r.audience.every(u=>u===r.owner||p.audience.includes(u))))fail();this.access(r.owner,r.threadId);this.access(r.requester,r.threadId);}
 policies(owner:string){return this.db.prepare('SELECT data FROM resource_policies WHERE owner=?').all(owner).map(r=>JSON.parse(String(r.data)) as ResourcePolicy);}
 putPolicy(owner:string,policyId:string,input:any):ResourcePolicy{return this.transaction(()=>{
 id(policyId);if(!input||typeof input!=='object')fail('잘못된 공유 설정',400);
 const existing=this.db.prepare('SELECT data FROM resource_policies WHERE id=?').get(policyId);const old:ResourcePolicy|undefined=existing?JSON.parse(String(existing.data)):undefined;
 if(old&&old.owner!==owner)fail('본인 공유 설정만 수정할 수 있습니다',403);if(old?.revoked){if(input.revoked===true)return old;fail('철회된 설정은 새 ID로 등록해 주세요');}
 if(input.owner!==undefined&&input.owner!==owner)fail('소유자가 일치하지 않습니다',403);
 if(!['local','github'].includes(input.source)||!['file','directory'].includes(input.kind)||!Array.isArray(input.audience)||input.audience.length>100||!Array.isArray(input.excluded)||input.excluded.length>100)fail('잘못된 공유 범위',400);
 if(input.workFolder!==undefined&&(typeof input.workFolder!=='boolean'||input.workFolder&&(input.source!=='local'||input.kind!=='directory'||input.threadId!=null||input.prefix!=='')))fail('업무 폴더 범위가 올바르지 않습니다',400);
 const audience=sorted(input.audience.map(id));for(const u of audience)if(!this.db.prepare('SELECT 1 FROM users WHERE name=?').get(u))fail('등록된 공유 상대를 선택해 주세요',400);
 const threadId=input.threadId==null?null:id(input.threadId);if(threadId)this.access(owner,threadId);
 const prefix=path(input.prefix);const excluded=sorted(input.excluded.map(path));if(excluded.some((p:string)=>!within(prefix,p)))fail('제외 경로가 공유 범위 밖입니다',400);
 if(input.label!==undefined&&(typeof input.label!=='string'||input.label.length>80||/[\\/:\x00-\x1f]/.test(input.label)||hasSecret(input.label)))fail('잘못된 표시 이름',400);
 if(input.revision!==undefined&&(!Number.isSafeInteger(input.revision)||input.revision<1||input.revision>1000000000))fail('잘못된 공유 설정 버전',400);
 const p:ResourcePolicy={id:policyId,owner,deviceId:id(input.deviceId),source:input.source,rootId:id(input.rootId),prefix,kind:input.kind,audience,threadId,excluded,revision:input.revision??(old?.revision??0)+1,revoked:input.revoked===true,...(input.label?{label:input.label}:{}),...(input.workFolder===true?{workFolder:true}:{}),...(input.dependency?{dependency:{parentId:id(input.dependency.parentId),parentRevision:input.dependency.parentRevision,packageName:input.dependency.packageName}}:{})};
 if(!dependencyLive(this.db,p))fail('관련 패키지의 원래 읽기 허용을 확인해 주세요',403);
 if(old&&JSON.stringify({...old,revision:0})===JSON.stringify({...p,revision:0})&&(input.revision===undefined||input.revision===old.revision))return old;
 if(old&&p.revision<=old.revision)fail('공유 설정 버전이 오래되었습니다. 최신 설정을 동기화해 주세요');
 this.db.prepare('INSERT INTO resource_policies VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(policyId,owner,JSON.stringify(p));
 if(old)this.invalidate(policyId);return p;
 });}
 private invalidate(policyId:string){for(const row of this.db.prepare('SELECT data FROM resource_requests').all()){const r:PersistentResourceRequest=JSON.parse(String(row.data));if((r.policyId===policyId||(r.policyId&&this.policy(r.policyId).dependency?.parentId===policyId))&&!['completed','denied','failed','cancelled'].includes(r.status)){r.status='cancelled';r.generation++;r.claimToken=null;this.save(r);}}}
 revokePolicy(owner:string,policyId:string){return this.transaction(()=>{const p=this.policy(policyId);if(p.owner!==owner)fail('본인 공유 설정만 철회할 수 있습니다',403);if(!p.revoked){p.revoked=true;p.revision++;this.db.prepare('UPDATE resource_policies SET data=? WHERE id=?').run(JSON.stringify(p),policyId);this.invalidate(policyId);}return p;});}
 request(actor:string,threadId:string,input:any){return this.transaction(()=>{
 this.access(actor,threadId);if(!Number.isSafeInteger(input?.messageId)||!['local','github'].includes(input.source)||!['read','list'].includes(input.action??'read'))fail('잘못된 자료 요청',400);
 const m=this.db.prepare('SELECT * FROM messages WHERE id=? AND thread_id=?').get(input.messageId,threadId);
 const owner=id(input.owner);const privateRead=!!m&&m.private_to===owner&&m.author===owner&&actor===owner;
 if(!m||m.author_type!=='human'||!['text','decision_result'].includes(String(m.kind))||(m.private_to!==null&&!privateRead)||m.direct)fail('접근 가능한 원래 사용자 요청이 필요합니다',403);
 this.access(owner,threadId);const requester=String(m.author);this.access(requester,threadId);
 if(actor!==owner&&actor!==requester)fail('원래 요청자 또는 자료 소유자만 요청할 수 있습니다',403);
 const triggerMessageId=input.triggerMessageId??input.messageId;const trigger=listMessages(this.db,threadId,owner).find(m=>m.id===triggerMessageId);if(!trigger||trigger.direct||trigger.id<m.id||trigger.authorType==='agent'&&trigger.agentTarget!==owner)fail('자료 요청의 실행 대상을 확인할 수 없습니다',403);
 const generation=input.generation??1;if(!Number.isSafeInteger(generation)||generation<1||generation>1000000)fail('잘못된 요청 세대',400);
 const r:PersistentResourceRequest={id:randomUUID(),threadId,messageId:input.messageId,triggerMessageId,privateRead,requester,owner,deviceId:id(input.deviceId),source:input.source,action:input.action??'read',rootId:id(input.rootId),path:path(input.path),policyId:input.policyId==null?null:id(input.policyId),policyRevision:null,audience:privateRead?[owner]:this.audience(threadId),generation,status:'waiting-owner',claimToken:null,attempts:0};
 r.requestKey=JSON.stringify([r.messageId,r.triggerMessageId??r.messageId,r.owner,r.deviceId,r.source,r.rootId,r.path,r.action]);
 const prior=this.db.prepare('SELECT data FROM resource_requests WHERE thread_id=?').all(threadId).map(row=>JSON.parse(String(row.data)) as PersistentResourceRequest).find(p=>p.requestKey===r.requestKey||(!p.requestKey&&p.messageId===r.messageId&&(p.triggerMessageId??p.messageId)===(r.triggerMessageId??r.messageId)&&p.owner===owner&&p.deviceId===r.deviceId&&p.source===r.source&&p.rootId===r.rootId&&p.path===r.path&&p.action===r.action));if(prior){if(!same(prior.audience,r.audience))fail('공유 대상이 바뀌었습니다. 새 메시지로 요청해 주세요');return {...prior,claimToken:null};}
 if(this.list(actor,threadId).filter(p=>!['completed','denied','failed','cancelled'].includes(p.status)).length>=32)fail('대기 자료 요청 한도를 넘었습니다',429);
 if(!r.policyId&&r.source==='local'){
  // Reuse only a binding explicitly established by this owner in this room.
  const previous=this.db.prepare('SELECT data FROM resource_requests WHERE thread_id=? ORDER BY rowid DESC').all(threadId);
  for(const row of previous){const old:PersistentResourceRequest=JSON.parse(String(row.data));const selected=old.selection;
   if(!selected||!old.policyId||old.owner!==owner||old.source!==r.source||selected.rootId!==r.rootId||selected.deviceId!==r.deviceId||old.privateRead!==r.privateRead||!same(old.audience,r.audience)||['denied','cancelled'].includes(old.status))continue;
   try{const p=this.policy(old.policyId);if(p.revision!==old.policyRevision)continue;
    const subtree=p.kind==='directory'&&selected.action==='list';
    if(subtree?!within(selected.path,r.path):selected.path!==r.path||selected.action!==r.action)continue;
    const suffix=subtree?(selected.path?r.path.slice(selected.path.length).replace(/^\//,''):r.path):'';
    const target={...r,rootId:p.rootId,deviceId:p.deviceId,path:suffix?(old.path?old.path+'/':'')+suffix:old.path,policyId:p.id,policyRevision:p.revision};
    this.validPolicy(target,p);Object.assign(r,target);break;
   }catch{/* Changed or excluded scopes require a new owner selection. */}
  }
 }
 if(r.policyId){const p=this.policy(r.policyId);this.validPolicy(r,p);r.policyRevision=p.revision;r.status='waiting-connection';}return this.save(r);
 });}
 list(actor:string,threadId:string){this.access(actor,threadId);return this.db.prepare('SELECT data FROM resource_requests WHERE thread_id=? ORDER BY rowid').all(threadId).map(row=>JSON.parse(String(row.data)) as PersistentResourceRequest).filter(r=>(!r.privateRead||r.owner===actor)&&same(r.audience,this.currentAudience(r))).map(r=>({...r,claimToken:null}));}
 listOwned(owner:string){return this.db.prepare('SELECT data FROM resource_requests WHERE owner=? ORDER BY rowid').all(owner).map(row=>JSON.parse(String(row.data)) as PersistentResourceRequest).filter(r=>{try{this.access(owner,r.threadId);return same(r.audience,this.currentAudience(r));}catch{return false;}}).map(r=>({...r,claimToken:null}));}
 decide(owner:string,requestId:string,input:any){return this.transaction(()=>{const r=this.owned(owner,requestId);if(r.status!=='waiting-owner'||typeof input?.approved!=='boolean')fail();if(!input.approved){r.status='denied';return this.save(r);}const p=this.policy(id(input.policyId??r.policyId));if(r.waitReason==='sensitive'){if(p.id!==r.policyId)fail();this.validPolicy(r,p);if(p.revision!==r.policyRevision)fail();r.approvedDigest=r.contentDigest;}else{if(p.owner!==owner||p.source!==r.source)fail();r.selection={rootId:r.rootId,deviceId:r.deviceId,path:r.path,action:r.action};r.rootId=p.rootId;r.deviceId=p.deviceId;r.path=path(input.path??(p.kind==='file'?p.prefix:r.path));this.validPolicy(r,p);}r.policyId=p.id;r.policyRevision=p.revision;r.status='waiting-connection';return this.save(r);});}
 claim(owner:string,requestId:string,input:any){return this.transaction(()=>{const r=this.owned(owner,requestId);if((r.status!=='waiting-connection'&&!(r.status==='running'&&(r.leaseUntil??Infinity)<Date.now()))||r.generation!==input?.generation||r.deviceId!==input.deviceId||r.attempts>=6||!r.policyId)fail();const p=this.policy(r.policyId);this.validPolicy(r,p);if(p.revision!==r.policyRevision)fail();this.db.prepare('UPDATE resource_receipts SET consumed=1 WHERE request_id=?').run(r.id);r.status='running';r.claimToken=randomUUID();r.leaseUntil=Date.now()+300000;r.attempts++;return this.save(r);});}
 complete(owner:string,requestId:string,input:any){return this.transaction(()=>{const r=this.owned(owner,requestId);if(r.status!=='running'||r.generation!==input?.generation||r.claimToken!==input.claimToken||(r.leaseUntil??0)<Date.now()||!['failed','cancelled','waiting-connection'].includes(input.status))fail();r.status=input.status;r.claimToken=null;return this.save(r);});}
 cancel(actor:string,requestId:string){return this.transaction(()=>{const r=this.get(requestId);this.access(actor,r.threadId);if(actor!==r.owner&&actor!==r.requester)fail('',403);if(!['completed','denied','failed','cancelled'].includes(r.status)){r.status='cancelled';r.generation++;r.claimToken=null;this.save(r);}return r;});}
 waitApproval(owner:string,requestId:string,input:any){return this.transaction(()=>{const r=this.owned(owner,requestId);if(r.status!=='running'||r.generation!==input?.generation||r.claimToken!==input.claimToken||(r.leaseUntil??0)<Date.now()||input.reason!=='sensitive'||typeof input.contentDigest!=='string'||! /^[a-f0-9]{64}$/.test(input.contentDigest))fail();if(input.preview!==undefined&&(typeof input.preview!=='string'||input.preview.length>1000||hasSecret(input.preview)))fail('민감한 미리보기는 저장할 수 없습니다',422);r.status='waiting-owner';r.waitReason='sensitive';r.preview='민감정보가 감지되었습니다. 값을 가린 내용 공유를 확인해 주세요.';r.contentDigest=input.contentDigest;delete r.approvedDigest;r.claimToken=null;this.db.prepare('UPDATE resource_receipts SET consumed=1 WHERE request_id=?').run(r.id);return this.save(r);});}
 issueReceipt(owner:string,input:any){return this.transaction(()=>{const r=this.owned(owner,input?.requestId);if(r.status!=='running'||r.generation!==input.generation||r.claimToken!==input.claimToken||(r.leaseUntil??0)<Date.now()||r.policyId!==input.policyId||!r.policyId)fail();const p=this.policy(r.policyId);this.validPolicy(r,p);if((r.contentDigest&&(!r.approvedDigest||input.contentDigest!==r.approvedDigest))||p.revision!==r.policyRevision||typeof input.contentHash!=='string'||! /^[a-f0-9]{64}$/.test(input.contentHash))fail();this.db.prepare('UPDATE resource_receipts SET consumed=1 WHERE request_id=?').run(r.id);const receiptId=randomUUID();this.db.prepare('INSERT INTO resource_receipts VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(receiptId,r.id,owner,r.threadId,p.id,p.revision,r.generation,JSON.stringify(r.audience),input.contentHash,Date.now()+300000);return {id:receiptId,requestId:r.id,source:r.source,rootId:r.rootId,path:r.path,contentHash:input.contentHash};});}
 consumeReceipt(owner:string,threadId:string,receiptId:string,contentHash:string){return this.transaction(()=>{const x=this.db.prepare('SELECT * FROM resource_receipts WHERE id=?').get(id(receiptId));if(!x||x.owner!==owner||x.thread_id!==threadId||x.consumed||Number(x.expires)<Date.now()||x.content_hash!==contentHash)fail();const r=this.owned(owner,String(x.request_id));const p=this.policy(String(x.policy_id));this.validPolicy(r,p);if(r.status!=='running'||(r.leaseUntil??0)<Date.now()||r.generation!==x.generation||p.revision!==x.revision||!same(JSON.parse(String(x.audience)),this.currentAudience(r)))fail();if(!this.db.prepare('UPDATE resource_receipts SET consumed=1 WHERE id=? AND consumed=0').run(receiptId).changes)fail();r.status='completed';r.claimToken=null;this.save(r);return {requestId:r.id,source:r.source,rootId:r.rootId,path:r.path,audience:r.audience,policyId:p.id,revision:p.revision};});}
 cleanupThread(owner:string,threadId:string){return this.transaction(()=>{for(const p of this.policies(owner))if(p.threadId===threadId)this.revokePolicy(owner,p.id);for(const row of this.db.prepare('SELECT data FROM resource_requests WHERE thread_id=?').all(threadId)){const r:PersistentResourceRequest=JSON.parse(String(row.data));if((r.owner===owner||r.requester===owner)&&!['completed','denied','failed','cancelled'].includes(r.status)){r.status='cancelled';r.generation++;r.claimToken=null;this.save(r);}}});}
}
