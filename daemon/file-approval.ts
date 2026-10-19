import {createHash,randomUUID} from 'node:crypto';
export type FileOperation = 'read'|'write'|'delete';
export interface FileProposal {
 id:string; owner:string; requester:string; threadId:string; audience:string[];
 operation:FileOperation; path:string; rootId?:string; content?:string; beforeHash?:string;
 expiresAt:number;
}
export function proposalDigest(p:FileProposal):string {
 return createHash('sha256').update(JSON.stringify([p.id,p.owner,p.requester,p.threadId,[...p.audience].sort(),p.operation,p.path,p.rootId??null,p.content??null,p.beforeHash??null,p.expiresAt])).digest('hex');
}
/** Owned by the local broker; ordinary chat text cannot mint or modify an approval. */
export class FileApprovals {
 private approvals=new Map<string,{digest:string;owner:string;expiresAt:number}>();
 approve(p:FileProposal,authenticatedOwner:string,now=Date.now()):string {
  if(authenticatedOwner!==p.owner || p.expiresAt<=now)throw Error('소유자 확인 또는 승인 유효기간 확인 실패');
  const nonce=randomUUID();this.approvals.set(nonce,{digest:proposalDigest(p),owner:p.owner,expiresAt:p.expiresAt});return nonce;
 }
 consume(nonce:string,p:FileProposal,currentAudience:string[],now=Date.now()):void {
  const grant=this.approvals.get(nonce);this.approvals.delete(nonce);
  if(!grant || grant.expiresAt<=now || grant.owner!==p.owner || grant.digest!==proposalDigest(p) ||
   JSON.stringify([...currentAudience].sort())!==JSON.stringify([...p.audience].sort()))throw Error('승인이 없거나 대상·공유 범위가 변경되었습니다');
 }
}
