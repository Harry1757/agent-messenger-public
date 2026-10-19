import {dependencyLive} from './resource-store.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {Message} from '../shared/types.ts';
import {canAccessThread,listMessages} from './db.ts';

export class ContextProvenanceError extends Error {
 status:number;
 constructor(message='참고한 대화 자료의 공유 허용 또는 공개 대상이 변경되었습니다.',status=409){super(message);this.status=status;}
}
export interface ContextProvenance {resourceAudience?:string[];resourcePolicyIds?:string[];}
const names=(value:unknown):value is string[]=>Array.isArray(value)&&value.length>0&&value.length<=100&&value.every(x=>typeof x==='string'&&x.length>0)&&new Set(value).size===value.length;
function members(db:DatabaseSync,thread:string):string[]{return db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(thread).map(r=>String(r.user_name));}
function visibleRoom(db:DatabaseSync,thread:string,owner:string){return canAccessThread(db,thread,owner)&&!db.prepare('SELECT 1 FROM hidden_threads WHERE thread_id=? AND user_name=?').get(thread,owner);}
function validAudience(db:DatabaseSync,thread:string,audience:string[]){const current=members(db,thread);return names(audience)&&audience.every(name=>current.includes(name));}
function liveBinding(db:DatabaseSync,thread:string,binding:string,audience:string[]):boolean {
 const parsed=/^([-\p{L}\p{N}_.]{1,128})@([1-9][0-9]{0,9})$/u.exec(binding);if(!parsed)return false;
 const revision=Number(parsed[2]);if(!Number.isSafeInteger(revision))return false;
 try{
  const row=db.prepare('SELECT owner,data FROM resource_policies WHERE id=?').get(parsed[1]);if(!row)return false;
  const policy=JSON.parse(String(row.data));
  return dependencyLive(db,policy)&&policy.id===parsed[1]&&policy.owner===row.owner&&typeof policy.owner==='string'&&policy.revoked===false&&policy.revision===revision&&
   (policy.threadId===null||policy.threadId===thread)&&Array.isArray(policy.audience)&&policy.audience.every((name:unknown)=>typeof name==='string')&&
   (policy.workFolder===true || audience.every(name=>name===policy.owner||policy.audience.includes(name)));
 }catch{return false;}
}
function proofForMessage(db:DatabaseSync,thread:string,message:Message,audience:string[]):ContextProvenance|null {
 // A private human instruction is just as private as a resource summary.
 if(message.privateTo!==null&&!audience.every(name=>name===message.privateTo))return null;
 const restricted=message.resourceAudience!==undefined;
 if(restricted&&(!names(message.resourceAudience)||!audience.every(name=>message.resourceAudience!.includes(name))))return null;
 if(message.resourcePolicyIds!==undefined&&(!Array.isArray(message.resourcePolicyIds)||message.resourcePolicyIds.length>100||message.resourcePolicyIds.some(x=>typeof x!=='string')))return null;
 const bindings=message.resourcePolicyIds??[];
 if(bindings.length&&(!restricted||bindings.some(binding=>!liveBinding(db,thread,binding,audience))))return null;
 if(restricted||message.privateTo!==null||bindings.length)return {resourceAudience:[...audience],...(bindings.length?{resourcePolicyIds:[...new Set(bindings)]}:{})};
 return {};
}

/** Use for model input only; ordinary UI history remains available through listMessages. */
export function activeContextMessages(db:DatabaseSync,thread:string,owner:string,audience?:string[]):Message[]{
 if(!visibleRoom(db,thread,owner))return [];
 const recipients=audience??members(db,thread);if(!validAudience(db,thread,recipients))return [];
 return listMessages(db,thread,owner).filter(message=>proofForMessage(db,thread,message,recipients)!==null);
}

/** Call inside the same publication transaction as receipt consumption and message insertion. */
export function contextProvenance(db:DatabaseSync,thread:string,owner:string,ids:number[],audience:string[]):ContextProvenance {
 if(!visibleRoom(db,thread,owner))throw new ContextProvenanceError('대화에 접근할 수 없습니다.',403);
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(ids).size!==ids.length||!validAudience(db,thread,audience))throw new ContextProvenanceError('참고한 대화와 공유 대상이 올바르지 않습니다.',400);
 const messages=new Map(listMessages(db,thread,owner).map(message=>[message.id,message]));
 let restricted=false;const bindings=new Set<string>();
 for(const id of ids){const message=messages.get(id);if(!message)throw new ContextProvenanceError('참고한 대화에 접근할 수 없습니다.',403);
  const proof=proofForMessage(db,thread,message,audience);if(!proof)throw new ContextProvenanceError();
  if(proof.resourceAudience)restricted=true;for(const binding of proof.resourcePolicyIds??[])bindings.add(binding);
 }
 if(bindings.size>100)throw new ContextProvenanceError('한 번에 참고할 수 있는 공유 자료 수를 넘었습니다.',400);
 return restricted?{resourceAudience:[...audience],...(bindings.size?{resourcePolicyIds:[...bindings].sort()}:{})}:{};
}
