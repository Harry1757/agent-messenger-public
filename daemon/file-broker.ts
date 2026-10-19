import {mkdir,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {FileApprovals,type FileProposal} from './file-approval.ts';
import {safeReadText,safeMutateText} from './safe-local-files.ts';
import {inspectSensitive} from './sensitive-content.ts';
import {validRelativePath} from '../shared/resource-access.ts';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function safeFileName(path:string):boolean {
 return !/(^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude|node_modules)([\\/]|$)|(^|[\\/])\.env(?:\.|$)|(?:^|[\\/])(?:auth|credentials|secrets)(?:\.|$)|\.(?:pem|key|p12|pfx|db|sqlite|png|jpe?g|gif|webp)$/i.test(path);
}
/** Exact owner-approved files; native helpers perform every read and mutation. */
export class LocalFileBroker {
 private approvals=new FileApprovals();
 private snapshots=new Map<string,string>();
 private reviewed=new Map<string,string>();
 async reviewedContent(root:string,path:string):Promise<string|undefined>{return this.reviewed.get(resolve(await realpath(root),path));}
 private backupDir:string;
 constructor(backupDir:string){this.backupDir=backupDir;}
 approve(p:FileProposal,owner:string){return this.approvals.approve(p,owner);}
 async execute(nonce:string,p:FileProposal,audience:string[],repositoryRoot:string):Promise<string>{
  this.approvals.consume(nonce,p,audience);
  if(!validRelativePath(p.path) || !safeFileName(p.path))throw Error('공유할 수 없는 파일 경로입니다');
  // Resolve only the explicitly supplied root's OS spelling. The native helper
  // validates every ancestor; relative model paths never become filesystem roots.
  const root=resolve(repositoryRoot),key=resolve(root,p.path);
  const read=safeReadText(root,p.path,{maxBytes:256000});
  if(read.sensitive)throw Error('민감정보가 포함된 파일은 별도 확인이 필요합니다');
  const original=read.text;
  if(p.operation==='read'){this.snapshots.set(key,read.hash);this.reviewed.set(key,original);return original;}
  if(!p.beforeHash || this.snapshots.get(key)!==p.beforeHash || read.hash!==p.beforeHash)throw Error('먼저 파일을 읽어 변경 전 내용을 확인해야 합니다. 파일이 바뀌면 다시 읽고 수정을 승인해 주세요');
  if(p.operation!=='write' && p.operation!=='delete')throw Error('지원하지 않는 파일 작업입니다');
  if(p.operation==='write' && (typeof p.content!=='string' || Buffer.byteLength(p.content)>256000 || inspectSensitive(p.content,p.path).sensitive))throw Error('수정 내용이 유효하지 않거나 민감정보가 포함되어 있습니다');
  await mkdir(this.backupDir,{recursive:true,mode:0o700});
  // Existing user state is never overwritten by the backup. The native helper
  // holds directory/file handles, verifies exact original bytes and writes backup.
  const backupRoot=await realpath(this.backupDir);
  safeMutateText(root,p.path,p.operation,original,p.operation==='write'?p.content!:'',join(backupRoot,randomUUID()+'.bak'));
  this.snapshots.delete(key);this.reviewed.delete(key);
  return p.operation==='delete'?'승인한 파일을 삭제하고 백업했습니다.':'승인한 내용으로 수정하고 백업했습니다.';
 }
}
export {digest as fileDigest};
