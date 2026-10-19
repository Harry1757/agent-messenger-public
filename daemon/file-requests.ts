import {basename,join} from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {LocalFileBroker,fileDigest,safeFileName} from './file-broker.ts';
import type {FileProposal} from './file-approval.ts';
import type {Message} from '../shared/types.ts';
export const FILE_APPROVE='파일 작업 1회 승인';
type Pending={proposal:FileProposal;root:string;privateTo:string|null;scope?:string};
export class FileRequests {
 private pending=new Map<number,Pending>();private broker:LocalFileBroker;
 private scopeCheck?: (root:string,thread:string,audience:string[])=>Promise<{common:boolean;reason:string;repo?:string;binding?:string}>;
 private readGrant?: (repo:string,path:string,thread:string,privateRead:boolean)=>Promise<string>;
 constructor(privateConfig:{home:string;scopeCheck?:FileRequests['scopeCheck'];readGrant?:FileRequests['readGrant']}){this.readGrant=privateConfig.readGrant;this.scopeCheck=privateConfig.scopeCheck;this.broker=new LocalFileBroker(join(privateConfig.home,'file-backups'));}
 async propose(text:string,source:Message,owner:string,roots:string[],audience:string[],post:(body:string)=>Promise<Message>,deliver?:(body:string,audience:string[],grant:string)=>Promise<unknown>):Promise<boolean>{
  if(!text.trim().startsWith('FILE_OPERATION'))return false;
  const v=JSON.parse(text.trim().slice('FILE_OPERATION'.length));
  if(!['read','write','delete'].includes(v.operation)||typeof v.project!=='string'||!/^[\w.-]+$/.test(v.project)||['.','..'].includes(v.project)||typeof v.path!=='string'||!safeFileName(v.path)||v.path.startsWith('/')||v.path.includes('..')||v.path.includes(':')||v.path.includes('\\'))throw Error('프로젝트와 정확한 상대 파일 경로가 필요합니다. 개인 폴더 조회는 허용하지 않습니다');
  if(v.operation==='write'&&(typeof v.content!=='string'||v.content.length>12000))throw Error('승인 화면에서 확인할 수 있는 크기의 수정 내용이 필요합니다');
  const candidates=roots.map(r=>basename(r)===v.project?r:join(r,v.project));let root='';
  for(const c of candidates){try{await lstat(join(c,'.git'));root=await realpath(c);break;}catch{}}
  if(!root)throw Error('설정된 작업 위치에서 해당 프로젝트를 확인할 수 없습니다');
  let scope=await this.scopeCheck?.(root,source.threadId,audience);
  const scopeSnapshot=scope?JSON.stringify(scope):undefined;
  const previous=v.operation==='read'?undefined:await this.broker.reviewedContent(root,v.path);
  if(v.operation!=='read' && previous===undefined)throw Error('수정·삭제 전에 해당 파일을 먼저 읽어 변경 전 내용을 확인해야 합니다');
  const proposal:FileProposal={id:randomUUID(),owner,requester:source.author,threadId:source.threadId,audience,operation:v.operation,path:v.path,expiresAt:Date.now()+10*60*1000,...(v.operation==='write'?{content:v.content}:{}),...(typeof v.beforeHash==='string'?{beforeHash:v.beforeHash}:{})};
  if(v.operation==='read'&&scope?.common&&scope.repo&&this.readGrant&&deliver){
    let grant:string|undefined;
    try{grant=await this.readGrant(scope.repo,v.path,source.threadId,source.privateTo!==null);}catch{scope={common:false,reason:'공통 저장소 권한을 다시 확인하지 못해 파일별 승인이 필요합니다'};}
    if(grant){
      const output=await this.broker.execute(this.broker.approve(proposal,owner),proposal,audience,root);
      await deliver(`공통 저장소에서 확인한 파일 내용: ${proposal.path}\n내용 해시: ${fileDigest(output)}\n\n${output}`,audience,grant);
      return true;
    }
  }
  const label={read:'읽기 및 내용 공유',write:'파일 수정',delete:'파일 삭제'}[proposal.operation];
  const body=JSON.stringify({fileAccess:true,question:`${v.project}/${v.path} — ${label}를 승인하시겠어요?`,summary:`${scope?(scope.common?'공통 GitHub 저장소 확인 완료':'공통 권한 미확인 — 이번 파일에 대한 예외 공유 승인')+'\n'+scope.reason+'\n':''}요청자: ${source.author}\n공유 대상: ${audience.join(', ')}\n대상 위치: ${join(root,v.path)}\n10분 이내 이번 작업 한 번만 허용합니다.${previous!==undefined?'\n변경 전 전체 내용:\n'+previous:''}${v.operation==='write'?'\n변경 후 전체 내용:\n'+v.content:''}`,options:[FILE_APPROVE,'거절']});
  const request=await post(body);this.pending.set(request.id,{proposal,root,privateTo:source.privateTo,scope:scopeSnapshot});return true;
 }
 async decision(message:Message,owner:string,audience:(thread:string)=>Promise<string[]>,post:(thread:string,body:string,privateTo:string|null,audience?:string[])=>Promise<unknown>):Promise<boolean>{
  if(message.kind!=='decision_result'||!message.decisionRequestId)return false;
  const pending=this.pending.get(message.decisionRequestId);if(!pending){if(message.author===owner && message.body===`@${owner} ${FILE_APPROVE}`){await post(message.threadId,'파일 승인 요청이 만료되었거나 앱이 다시 시작되었습니다. 파일 작업을 다시 요청해 주세요.',owner);return true;}return false;}
  this.pending.delete(message.decisionRequestId);
  if(message.threadId!==pending.proposal.threadId||message.privateTo!==owner||message.authorType!=='human'||message.author!==owner||message.body!==`@${owner} ${FILE_APPROVE}`)return true;
  try{
   const current=pending.privateTo?[owner]:await audience(message.threadId);
   if(this.scopeCheck && pending.scope!==JSON.stringify(await this.scopeCheck(pending.root,message.threadId,current)))throw Error('GitHub 권한 또는 계정 연결이 변경되었습니다. 파일을 다시 요청해 주세요');
   const nonce=this.broker.approve(pending.proposal,owner);
   const output=await this.broker.execute(nonce,pending.proposal,current,pending.root);
   const body=pending.proposal.operation==='read'?`소유자가 승인한 파일 내용: ${pending.proposal.path}\n내용 해시: ${fileDigest(output)}\n\n${output}`:output;
   await post(message.threadId,body,pending.privateTo,pending.proposal.audience);
  }catch(e){await post(message.threadId,`파일 작업을 실행하지 못했습니다: ${(e as Error).message}`,owner);}
  return true;
 }
}
