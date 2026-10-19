import {GithubReadError,validRepo,type GithubRead} from '../shared/github-read.ts';
import {randomUUID,verify} from 'node:crypto';
import {githubLogin,checkCommonAccess,githubRepo} from './github-access.ts';
import {runCommand} from './process.ts';
import {sealIdentity} from '../shared/github-envelope.ts';
import {GITHUB_SERVER_PUBLIC_KEY} from '../shared/github-server-key.ts';
import type {DaemonConfig} from './config.ts';
export class GithubConnection {
 private config:DaemonConfig;
 private request:typeof fetch;
 private resolveToken:()=>Promise<string>;
 constructor(config:DaemonConfig,dependencies:{request?:typeof fetch;token?:()=>Promise<string>}={}){this.config=config;this.request=dependencies.request??fetch;this.resolveToken=dependencies.token??(async()=>{const token=await runCommand('gh',['auth','token','--hostname','github.com'],{timeout:10000});if(token.error||!token.stdout.trim())throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결이 필요합니다. 로그인 후 연결 상태를 확인해 주세요.');return token.stdout.trim();});}
 private async api(path:string,method='GET',body?:unknown){
  let r:Response;
  try{r=await this.request(`${this.config.serverUrl}/api/${path}`,{method,headers:{Authorization:`Bearer ${this.config.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});}catch{throw new GithubReadError('NETWORK','서버에 연결하지 못해 GitHub 조회를 중단했습니다. 연결이 복구된 뒤 다시 요청해 주세요.');}
  if(!r.ok){const error=await r.json().catch(()=>({}));throw new GithubReadError(error.code??'CONNECTION',error.error??'GitHub 연결 서버 확인 실패');}return r.json();
 }
 async sync(){
  const status=await githubLogin();
  if(!status.ok){try{await this.api('github/connect','DELETE');}catch{}return status;}
  try{
   const {nonce}=await this.api('github/challenge','POST');
   const token=await runCommand('gh',['auth','token','--hostname','github.com'],{timeout:10000});
   if(token.error||!token.stdout.trim())throw Error();
   await this.api('github/connect','POST',{envelope:sealIdentity(GITHUB_SERVER_PUBLIC_KEY,{nonce,owner:this.config.agentName,token:token.stdout.trim()})});
   return status;
  }catch{return {ok:false,detail:'GitHub 계정 연결을 확인하지 못했습니다. 잠시 뒤 다시 확인합니다.'};}
 }
 async resolveProject(project:string):Promise<string>{
  if(typeof project!=='string')throw new GithubReadError('PROJECT','GitHub 저장소를 owner/repo 형식으로 알려주세요.');
  const target=project.trim();if(validRepo(target))return target;
  const label=target.replace(/\s+/g,'-');if(!label||label.length>100||!/^[-\p{L}\p{N}_.]+$/u.test(label)||['.','..'].includes(label))throw new GithubReadError('PROJECT','GitHub 저장소를 owner/repo 형식으로 알려주세요.');
  const {nonce}=await this.api('github/challenge','POST');
  let token:string;try{token=await this.resolveToken();}catch{throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결이 필요합니다. 로그인 후 연결 상태를 확인해 주세요.');}
  if(!token.trim())throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결이 필요합니다.');
  const envelope=sealIdentity(GITHUB_SERVER_PUBLIC_KEY,{nonce,owner:this.config.agentName,token:token.trim(),purpose:'github-resolve',project:label});
  const repo=await this.api('github/resolve','POST',{envelope});if(!validRepo(repo))throw new GithubReadError('PROJECT','GitHub 저장소를 확정하지 못했습니다. owner/repo 형식으로 지정해 주세요.');return repo;
 }
 async readRepository(repo:string,query:GithubRead,thread:string,privateRead:boolean){
  const {nonce}=await this.api('github/challenge','POST');
  const token=await runCommand('gh',['auth','token','--hostname','github.com'],{timeout:10000});
  if(token.error||!token.stdout.trim())throw new GithubReadError('LOGIN_REQUIRED','GitHub 연결이 필요합니다. 로그인 후 연결 상태 확인을 눌러 주세요.');
  const envelope=sealIdentity(GITHUB_SERVER_PUBLIC_KEY,{nonce,owner:this.config.agentName,token:token.stdout.trim(),purpose:'github-read',repo,query,thread,privateRead});
  return await this.api(`threads/${encodeURIComponent(thread)}/github/read`,'POST',{envelope}) as {result:unknown;grant:string;audience:string[]};
 }
 async readGrant(repo:string,path:string,thread:string,privateRead:boolean){
  const {nonce}=await this.api('github/challenge','POST');
  const token=await runCommand('gh',['auth','token','--hostname','github.com'],{timeout:10000});
  if(token.error||!token.stdout.trim())throw Error('GitHub 연결을 확인해 주세요');
  const envelope=sealIdentity(GITHUB_SERVER_PUBLIC_KEY,{nonce,owner:this.config.agentName,token:token.stdout.trim(),purpose:'common-read',repo});
  return (await this.api(`threads/${encodeURIComponent(thread)}/file-read-grant`,'POST',{repo,path,private:privateRead,envelope})).grant as string;
 }
 async scope(root:string,threadId:string,audience:string[]){
  const origin=await runCommand('git',['-C',root,'config','--get','remote.origin.url'],{timeout:5000});
  const repo=origin.error?null:githubRepo(origin.stdout);
  if(!repo)return {common:false,reason:'GitHub 원격 저장소가 확인되지 않은 프로젝트입니다'};
  try{
   const nonce=randomUUID();
   const signed=await this.api(`threads/${encodeURIComponent(threadId)}/github?nonce=${nonce}`);
   if(typeof signed.payload!=='string'||!verify('sha256',Buffer.from(signed.payload),GITHUB_SERVER_PUBLIC_KEY,Buffer.from(signed.signature,'base64')))throw Error();
   const scope=JSON.parse(signed.payload);
   if(scope.thread!==threadId||scope.nonce!==nonce||scope.expiresAt<=Date.now())throw Error();
   const members=scope.members as {name:string;identity:{login:string;id:number;expiresAt:number}|null}[];
   const identities=audience.map(name=>{const i=members.find(m=>m.name===name)?.identity;return i&&i.expiresAt>Date.now()?i:null;});
   return {...await checkCommonAccess(repo,identities),repo,binding:JSON.stringify(identities.map(i=>i?.id??null))};
  }catch{return {common:false,reason:'참여자의 GitHub 연결을 확인할 수 없습니다',repo};}
 }
}
