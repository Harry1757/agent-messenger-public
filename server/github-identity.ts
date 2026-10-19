import {readGithub} from './github-reader.ts';
import {GithubReadError,githubReadUrl,validRepo} from '../shared/github-read.ts';
import {sign,randomUUID,privateDecrypt,createDecipheriv,type KeyLike} from 'node:crypto';
type Identity={id:number;login:string;expiresAt:number};
export class GithubIdentities {
 private pending=new Map<string,{owner:string;expiresAt:number}>();
 private identities=new Map<string,Identity>();
 private key:KeyLike;private verify:(token:string)=>Promise<{id:number;login:string}>;
 private permission:typeof verifyPermission;
 private request:typeof fetch;
 constructor(key:KeyLike,verify=verifyGithub,permission=verifyPermission,request:typeof fetch=fetch){this.key=key;this.verify=verify;this.permission=permission;this.request=request;}
 signedScope(thread:string,nonce:string,members:{name:string;identity:Identity|null}[]){
  const payload=JSON.stringify({thread,nonce,members,expiresAt:Date.now()+30000});
  return {payload,signature:sign('sha256',Buffer.from(payload),this.key).toString('base64')};
 }
 challenge(owner:string){
  for(const [nonce,c] of this.pending)if(c.expiresAt<=Date.now())this.pending.delete(nonce);
  const owned=[...this.pending].filter(([,c])=>c.owner===owner);
  if(owned.length>=8)this.pending.delete(owned[0][0]);
  const nonce=randomUUID();this.pending.set(nonce,{owner,expiresAt:Date.now()+60000});return {nonce};
 }
 get(owner:string,now=Date.now()):Identity|null{const v=this.identities.get(owner);return v&&v.expiresAt>now?{...v}:null;}
 disconnect(owner:string){this.identities.delete(owner);for(const [nonce,c] of this.pending)if(c.owner===owner)this.pending.delete(nonce);}
 private decrypt(owner:string,blob:string){
  if(typeof blob!=='string'||blob.length>12000)throw Error('잘못된 연결 요청');
  const envelope=JSON.parse(blob);
  const key=privateDecrypt({key:this.key,oaepHash:'sha256'},Buffer.from(envelope.key,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
  const c=this.pending.get(value.nonce);
  if(value.owner!==owner||!c||c.owner!==owner||c.expiresAt<=Date.now())throw Error('연결 요청 만료');
  this.pending.delete(value.nonce);
  if(typeof value.token!=='string'||value.token.length>4096)throw Error('잘못된 인증 정보');
  return value;
 }
 async readScope(owner:string,blob:string,repo:string,members:string[]){
  const value=this.decrypt(owner,blob);
  if(value.purpose!=='common-read'||value.repo!==repo||!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)||['.','..'].includes(repo.split('/')[1]))throw Error('잘못된 저장소');
  const who=await this.verify(value.token);
  if(this.get(owner)?.id!==who.id)throw Error('GitHub 계정이 변경되었습니다');
  const identities=members.map(name=>this.get(name));
  if(identities.some(i=>!i))throw Error('GitHub 미연결 참여자가 있습니다');
  const binding=JSON.stringify(identities.map(i=>i!.id));
  const permissions=await Promise.all(identities.map(identity=>this.permission(value.token,repo,identity!.login)));
  if(permissions.some(allowed=>!allowed))throw Error('공통 저장소 권한이 없습니다');
  if(binding!==this.binding(members))throw Error('GitHub 계정이 변경되었습니다');
  return binding;
 }
 async resolveRepository(owner:string,blob:string):Promise<string>{
  let value:any;try{value=this.decrypt(owner,blob);}catch{throw new GithubReadError('INVALID_REQUEST','GitHub 저장소 확인 요청이 만료되었거나 올바르지 않습니다.');}
  const project=typeof value.project==='string'?value.project.trim().replace(/\s+/g,'-'):'';
  if(value.purpose!=='github-resolve'||!project||project.length>100||!/^[-\p{L}\p{N}_.]+$/u.test(project)||['.','..'].includes(project)||Object.keys(value).some(k=>!['owner','nonce','token','purpose','project'].includes(k)))throw new GithubReadError('PROJECT','GitHub 저장소를 owner/repo 형식으로 알려주세요.');
  let who:{id:number;login:string};try{who=await this.verify(value.token);}catch{throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결을 다시 확인해 주세요.');}
  if(this.get(owner)?.id!==who.id)throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결 계정을 다시 확인해 주세요.');
  const found=new Map<string,string>();let complete=false;
  for(let page=1;page<=3;page++){
   if(this.get(owner)?.id!==who.id)throw new GithubReadError('ACCOUNT_CHANGED','저장소 확인 중 GitHub 계정이 변경되었습니다.');
   const url=`https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=updated`;
   let response:Response;try{response=await this.request(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${value.token}`,Accept:'application/vnd.github+json','User-Agent':'AgentMessenger'},signal:AbortSignal.timeout(15000)});}catch{throw new GithubReadError('NETWORK','GitHub 저장소를 확인하지 못했습니다. 연결 상태를 확인해 주세요.');}
   if(!response.ok){
    if(response.status===401)throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결이 만료되었습니다. 다시 연결해 주세요.');
    if(response.status===429||response.headers.get('x-ratelimit-remaining')==='0')throw new GithubReadError('RATE_LIMIT','GitHub 호출 제한에 도달했습니다. 잠시 뒤 다시 확인해 주세요.');
    if(response.status===403)throw new GithubReadError('READ_PERMISSION','GitHub 저장소 목록의 읽기 권한과 조직 승인을 확인해 주세요.');
    throw new GithubReadError('UPSTREAM','GitHub 저장소를 확인하지 못했습니다. owner/repo 형식으로 지정해 주세요.');
   }
   const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
   try{if(reader)while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2000000){await reader.cancel();throw new GithubReadError('TOO_LARGE','GitHub 저장소 응답이 큽니다. owner/repo 형식으로 지정해 주세요.');}chunks.push(item.value);}}catch(error){if(error instanceof GithubReadError)throw error;throw new GithubReadError('NETWORK','GitHub 저장소 응답을 받지 못했습니다. 연결 상태를 확인해 주세요.');}
   let rows:any;try{rows=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new GithubReadError('UPSTREAM','GitHub 저장소 응답을 확인하지 못했습니다.');}
   if(!Array.isArray(rows)||rows.length>100)throw new GithubReadError('UPSTREAM','GitHub 저장소 응답을 확인하지 못했습니다.');
   for(const repo of rows){if(typeof repo?.name!=='string'||repo.name.trim().replace(/\s+/g,'-').toLowerCase()!==project.toLowerCase()||!validRepo(repo.full_name)||repo.full_name.split('/')[1].toLowerCase()!==project.toLowerCase())continue;found.set(repo.full_name.toLowerCase(),repo.full_name);}
   if(found.size>1)throw new GithubReadError('PROJECT','같은 이름의 저장소가 여러 개입니다. owner/repo 형식으로 지정해 주세요.');
   if(!/rel="next"/.test(response.headers.get('link')??'')&&rows.length<100){complete=true;break;}
  }
  if(this.get(owner)?.id!==who.id)throw new GithubReadError('ACCOUNT_CHANGED','저장소 확인 중 GitHub 계정이 변경되었습니다.');
  if(!complete||found.size!==1)throw new GithubReadError('PROJECT','저장소 이름을 확정하지 못했습니다. owner/repo 형식으로 지정해 주세요.');
  return [...found.values()][0];
 }
 async readRepository(owner:string,blob:string,thread:string,allMembers:string[],sharingAllowed?:(repo:string)=>boolean){
  const value=this.decrypt(owner,blob);
  if(value.purpose!=='github-read'||value.thread!==thread)throw new GithubReadError('INVALID_REQUEST','GitHub 조회 요청이 만료되었거나 대화가 변경되었습니다.');
  githubReadUrl(value.repo,value.query);
  const members=value.privateRead===true?[owner]:allMembers;
  const who=await this.verify(value.token);
  if(this.get(owner)?.id!==who.id)throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결 계정을 다시 확인해 주세요.');
  const shared=sharingAllowed?.(value.repo)===true;
  const checkedMembers=shared?[owner]:members;
  const missing=checkedMembers.filter(m=>!this.get(m));
  if(missing.length)throw new GithubReadError('MEMBER_LOGIN_REQUIRED',`${missing.join(', ')}님의 GitHub 연결이 필요합니다. 연결 후 다시 요청해 주세요.`);
  const binding=this.binding(checkedMembers);
  const permissions=shared?[]:await Promise.all(members.map(m=>this.permission(value.token,value.repo,this.get(m)!.login)));
  if(permissions.some(x=>!x))throw new GithubReadError('COMMON_ACCESS','참여자 모두의 저장소 읽기 권한을 확인하지 못했습니다. 저장소 접근 권한과 조직 승인을 확인해 주세요.');
  const result=await readGithub(value.token,value.repo,value.query,this.request);
  if(binding!==this.binding(checkedMembers))throw new GithubReadError('ACCOUNT_CHANGED','조회 중 GitHub 계정 연결이 변경되었습니다. 다시 요청해 주세요.');
  return {result,binding,audience:members,bindingOwners:checkedMembers};
 }
 binding(members:string[]){return JSON.stringify(members.map(name=>this.get(name)?.id??null));}
 async connect(owner:string,blob:string){
  const value=this.decrypt(owner,blob);
  this.identities.delete(owner);
  const user=await this.verify(value.token);
  if(!Number.isSafeInteger(user.id)||user.id<=0||typeof user.login!=='string'||!/^[A-Za-z0-9-]+$/.test(user.login))throw Error('GitHub 계정 검증 실패');
  this.identities.set(owner,{id:user.id,login:user.login,expiresAt:Date.now()+15*60*1000});
  return this.get(owner);
 }
}
async function verifyGithub(token:string):Promise<{id:number;login:string}>{
 const r=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'AgentMessenger'},signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!r.ok)throw Error('GitHub 계정 검증 실패');return r.json();
}

async function verifyPermission(token:string,repo:string,login:string):Promise<boolean>{
 const r=await fetch(`https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'AgentMessenger'},signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!r.ok)return false;const v=await r.json();return ['read','write','admin','maintain','triage'].includes(v.permission);
}
