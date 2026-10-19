import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Message,MessageKind} from '../shared/types.ts';
import type {ResourceRequest,SharePolicy} from '../shared/resource-access.ts';
import {sameAudience,validRelativePath} from '../shared/resource-access.ts';
import {ShareRoots} from './share-roots.ts';
import {safeReadText} from './safe-local-files.ts';
import {inspectSensitive} from './sensitive-content.ts';
import {LocalFileBroker,safeFileName} from './file-broker.ts';
import type {FileProposal} from './file-approval.ts';

export const MUTATION_APPROVE='검토한 변경 1회 승인';
export interface MutationRequestsOptions {
 home:string; owner:string;
 api:(url:string,method?:string,body?:unknown)=>Promise<any>;
 post:(source:Message,kind:MessageKind,body:string,privateTo:string|null)=>Promise<Message>;
 isCancelled:(source:Message)=>boolean;
}
interface PendingMutation {
 requestId:number; requestDigest:string; proposal:FileProposal; rootId:string;
 policyId:string; revision:number; deviceId:string; source:Message;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const fingerprint=(p:SharePolicy)=>JSON.stringify([p.id,p.rootId,p.owner,p.deviceId,p.kind,p.source,p.prefix,p.threadId,[...p.audience].sort(),[...p.excluded].sort(),p.revision,p.revoked]);
export class MutationRequests {
 private options:MutationRequestsOptions;
 private pending=new Map<number,PendingMutation>();
 private active=new Set<number>();
 private broker:LocalFileBroker;
 private file:string;
 constructor(options:MutationRequestsOptions) {
  this.options=options;this.file=path.join(options.home,'mutation-pending.json');this.broker=new LocalFileBroker(path.join(options.home,'file-backups'));
  if(fs.existsSync(this.file)) {
   try {
    if(fs.lstatSync(this.file).isSymbolicLink())throw Error();
    const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(saved.version!==1 || saved.owner!==options.owner || !Array.isArray(saved.pending) || saved.pending.length>50)throw Error();
    for(const p of saved.pending) {
     if(!p || !Number.isSafeInteger(p.requestId) || typeof p.requestDigest!=='string' || !p.proposal || p.proposal.owner!==options.owner ||
      !['write','delete'].includes(p.proposal.operation) || !validRelativePath(p.proposal.path) || typeof p.rootId!=='string' ||
      p.proposal.rootId!==p.rootId || typeof p.policyId!=='string' || !Number.isSafeInteger(p.revision) || typeof p.deviceId!=='string' ||
      !Array.isArray(p.proposal.audience) || !p.proposal.audience.every((x:unknown)=>typeof x==='string') ||
      !Number.isFinite(p.proposal.expiresAt) || !p.source || !Number.isSafeInteger(p.source.id) || typeof p.source.threadId!=='string' ||
      p.source.threadId!==p.proposal.threadId || (p.proposal.operation==='write' && typeof p.proposal.content!=='string'))throw Error();
     this.pending.set(p.requestId,p);
    }
   }catch{throw Error('변경 승인 저장소가 손상되어 실행을 중지했습니다');}
  }
 }
 private persist() {
  fs.mkdirSync(this.options.home,{recursive:true,mode:0o700});const temporary=this.file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify({version:1,owner:this.options.owner,pending:[...this.pending.values()]}),{flag:'wx',mode:0o600});fs.renameSync(temporary,this.file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 }
 private forget(id:number) {this.pending.delete(id);this.persist();}
 private async notice(source:Message,body:string) {await this.options.post(source,'text',body,this.options.owner);}
 private async audience(source:Message):Promise<string[]> {
  const audience=source.privateTo===this.options.owner?[this.options.owner]:await this.options.api(`/api/threads/${encodeURIComponent(source.threadId)}/participants`);
  if(!Array.isArray(audience) || !audience.includes(this.options.owner) || audience.some(x=>typeof x!=='string'))throw Error('invalid-audience');
  return [...new Set(audience)] as string[];
 }
 private readRequest(p:PendingMutation):ResourceRequest {
  return {id:p.proposal.id,owner:this.options.owner,deviceId:p.deviceId,requester:p.proposal.requester,threadId:p.proposal.threadId,
   audience:p.proposal.audience,generation:1,source:'local',rootId:p.rootId,relativePath:p.proposal.path,action:'read'};
 }
 private async validate(p:PendingMutation):Promise<{roots:ShareRoots;policy:SharePolicy;root:string}> {
  if(this.options.isCancelled(p.source) || p.proposal.expiresAt<=Date.now())throw Error('cancelled');
  const audience=await this.audience(p.source);if(!sameAudience(audience,p.proposal.audience))throw Error('audience-changed');
  const roots=new ShareRoots(this.options.home,this.options.owner),access=roots.resolve(this.readRequest(p));
  if(access.decision.kind!=='allow' || !access.policy || access.policy.id!==p.policyId || access.policy.revision!==p.revision)throw Error('policy-changed');
  const remote=await this.options.api('/api/sharing/policies') as SharePolicy[];
  const policy=remote.find(r=>r.id===p.policyId);
  if(!policy || fingerprint(policy)!==fingerprint(access.policy))throw Error('policy-changed');
  return {roots,policy:access.policy,root:roots.getRootPath(p.rootId)};
 }
 private async messages(threadId:string):Promise<Message[]> {
  const messages=await this.options.api(`/api/threads/${encodeURIComponent(threadId)}/messages`);
  if(!Array.isArray(messages))throw Error('missing-messages');return messages;
 }
 async handle(text:string,source:Message,history:Message[]):Promise<boolean> {
  if(!text.trim().startsWith('FILE_OPERATION'))return false;
  let q:any;try{q=JSON.parse(text.trim().slice('FILE_OPERATION'.length));}catch{return false;}
  if(!['write','delete'].includes(q.operation))return false;
  try {
   if(this.options.isCancelled(source))return true;
   if(typeof q.project!=='string' || !q.project || q.project.length>128 || /[\\/:\x00-\x1f]/.test(q.project) ||
    !validRelativePath(q.path) || q.path.length>512 || !safeFileName(q.path) || !/^[a-f0-9]{64}$/.test(q.beforeHash) ||
    (q.operation==='write' && (typeof q.content!=='string' || Buffer.byteLength(q.content)>12000 || inspectSensitive(q.content,q.path).sensitive)))throw Error('invalid-proposal');
   if(source.privateTo!==null && source.privateTo!==this.options.owner)throw Error('private-request');
   // History aids selection only. The initiating human message must also exist in
   // the authenticated server view; agent-authored prose cannot mint an approval.
   const proposed=[...history,source].filter(m=>m.threadId===source.threadId && m.id<=source.id && m.authorType==='human' && m.kind==='text' && !m.direct &&
    (source.privateTo===this.options.owner ? m.privateTo===this.options.owner && m.author===this.options.owner : m.privateTo===null)).sort((a,b)=>b.id-a.id)[0];
   const canonical=(await this.messages(source.threadId)).find(m=>m.id===proposed?.id && m.authorType==='human' && m.kind==='text' && !m.direct && m.privateTo===proposed?.privateTo && m.author===proposed?.author);
   if(!canonical)throw Error('no-human-request');
   const audience=await this.audience(canonical);if(!audience.includes(canonical.author))throw Error('invalid-requester');
   const roots=new ShareRoots(this.options.home,this.options.owner);
   const candidates=roots.listPolicies(source.threadId).filter(p=>!p.revoked && [p.rootId,p.id,p.label].includes(q.project));
   if(candidates.length!==1)throw Error('unselected-root');const policy=candidates[0];
   const p:PendingMutation={requestId:0,requestDigest:'',rootId:policy.rootId,policyId:policy.id,revision:policy.revision,deviceId:roots.deviceId,
    source:{...source,body:''},proposal:{id:randomUUID(),owner:this.options.owner,requester:canonical.author,threadId:source.threadId,audience,
     operation:q.operation,path:q.path,rootId:policy.rootId,beforeHash:q.beforeHash,...(q.operation==='write'?{content:q.content}:{}),expiresAt:Date.now()+600000}};
   if(roots.resolve(this.readRequest(p)).decision.kind!=='allow')throw Error('read-policy-required');
   await this.options.api('/api/sharing/policies/'+encodeURIComponent(policy.id),'PUT',policy);
   let validated=await this.validate(p);
   const snapshot=safeReadText(validated.root,q.path,{maxBytes:12000});
   if(snapshot.sensitive || snapshot.hash!==q.beforeHash)throw Error('changed-or-sensitive');
   const readProposal={...p.proposal,operation:'read' as const,content:undefined,beforeHash:undefined};
   await this.broker.execute(this.broker.approve(readProposal,this.options.owner),readProposal,audience,validated.root);
   if(this.pending.size>=50)throw Error('pending-limit');
   const duplicate=[...this.pending.values()].find(other=>other.source.id===p.source.id && other.rootId===p.rootId && other.proposal.path===p.proposal.path &&
    other.proposal.operation===p.proposal.operation && other.proposal.beforeHash===p.proposal.beforeHash && other.proposal.content===p.proposal.content && other.proposal.expiresAt>Date.now());
   if(duplicate)return true;
   validated=await this.validate(p);
   const body=JSON.stringify({fileMutation:true,question:`${policy.label??policy.rootId}/${q.path} — ${q.operation==='write'?'수정':'삭제'}할까요?`,
    summary:`요청자: ${canonical.author}\n공유 대상: ${audience.join(', ')}\n현재 내용 해시: ${snapshot.hash}\n변경 전:\n${snapshot.redacted}\n변경 후:\n${q.operation==='write'?q.content:'[파일 삭제]'}\n10분 안에 검토한 변경 한 번만 실행하며 원본을 백업합니다.`,options:[MUTATION_APPROVE,'거절']});
   const card=await this.options.post(canonical,'decision_request',body,this.options.owner);
   if(card.kind!=='decision_request' || card.privateTo!==this.options.owner || card.threadId!==source.threadId || !Number.isSafeInteger(card.id))throw Error('invalid-card');
   p.requestId=card.id;p.requestDigest=hash(card.body);this.pending.set(card.id,p);this.persist();return true;
  }catch{await this.notice(source,'파일 변경 요청을 준비하지 못했습니다. 현재 파일 내용·공유 허용·변경 전 해시를 다시 확인해 주세요. 민감한 내용은 전송하지 않았습니다.');return true;}
 }
 async decision(message:Message):Promise<boolean> {
  if(message.kind!=='decision_result' || !message.decisionRequestId)return false;
  const p=this.pending.get(message.decisionRequestId);if(!p)return false;
  if(this.active.has(p.requestId))return true;this.active.add(p.requestId);
  let consumed=false;
  try {
   const messages=await this.messages(p.source.threadId);
   const actual=messages.find(m=>m.id===message.id);
   const card=messages.find(m=>m.id===p.requestId);
   if(!actual || actual.kind!=='decision_result' || actual.decisionRequestId!==p.requestId || actual.threadId!==p.source.threadId ||
    actual.authorType!=='human' || actual.author!==this.options.owner || actual.privateTo!==this.options.owner ||
    !card || card.kind!=='decision_request' || card.privateTo!==this.options.owner || hash(card.body)!==p.requestDigest)return true;
   if(actual.body!==`@${this.options.owner} ${MUTATION_APPROVE}`) {this.forget(p.requestId);return true;}
   let validation=await this.validate(p);
   const snapshot=safeReadText(validation.root,p.proposal.path,{maxBytes:12000});
   if(snapshot.sensitive || snapshot.hash!==p.proposal.beforeHash)throw Error('file-changed');
   const readProposal={...p.proposal,operation:'read' as const,content:undefined,beforeHash:undefined};
   await this.broker.execute(this.broker.approve(readProposal,this.options.owner),readProposal,p.proposal.audience,validation.root);
   validation=await this.validate(p);
   // Durable removal precedes nonce issuance and mutation. A crash never replays it.
   const consumedDirectory=path.join(this.options.home,'mutation-consumed');
   fs.mkdirSync(consumedDirectory,{recursive:true,mode:0o700});
   const marker=path.join(consumedDirectory,hash(p.proposal.id+':'+p.requestId+':'+p.requestDigest));
   // Exclusive creation also serializes separate daemon instances recovering the
   // same local state. Keep the tombstone so an older pending file cannot replay.
   fs.writeFileSync(marker,'consumed',{flag:'wx',mode:0o600});
   this.forget(p.requestId);consumed=true;
   if(this.options.isCancelled(p.source))throw Error('cancelled');
   const nonce=this.broker.approve(p.proposal,this.options.owner);
   const output=await this.broker.execute(nonce,p.proposal,p.proposal.audience,validation.root);
   if(this.options.isCancelled(p.source))return true;
   const currentAudience=await this.audience(p.source);
   await this.options.post(p.source,'text',output,sameAudience(currentAudience,p.proposal.audience)?p.source.privateTo:this.options.owner);
   return true;
  }catch{if(!consumed)this.forget(p.requestId);if(!this.options.isCancelled(p.source))await this.notice(p.source,'파일 변경을 실행하지 못했습니다. 파일·공유 대상·허용 상태를 다시 확인하고 새 변경 요청을 승인해 주세요.');return true;}
  finally{this.active.delete(p.requestId);}
 }
 async resumeReady():Promise<void> {
  for(const p of [...this.pending.values()]) {
   if(p.proposal.expiresAt<=Date.now() || this.options.isCancelled(p.source)){this.forget(p.requestId);continue;}
   try{const actual=(await this.messages(p.source.threadId)).find(m=>m.kind==='decision_result' && m.decisionRequestId===p.requestId);if(actual)await this.decision(actual);}catch{}
  }
 }
}
