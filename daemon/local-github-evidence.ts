import {completeGithubReads} from './github-reads.ts';
import {GithubReadError,type GithubRead} from '../shared/github-read.ts';
import type {AdapterResult} from './adapters/index.ts';
type Evidence={context:string;grants:string[];audience?:string[];expires:number};
/** Remote evidence stays in memory and is published only with its original grants. */
export class LocalGithubEvidence {
 private entries=new Map<string,Evidence>();
 get(key:string){const value=this.entries.get(key);if(value&&value.expires<=Date.now()){this.entries.delete(key);throw new GithubReadError('CONNECTION','GitHub 조회 허용이 만료되었습니다. 다시 요청해 주세요.');}return value;}
 clear(key:string){this.entries.delete(key);}
 seed(key:string,value:{context?:string;grants:string[];audience?:string[]}){
  if(!value.grants.length)return;
  const before=this.get(key);const grants=[...new Set([...(before?.grants??[]),...value.grants])];
  if(grants.length>8)throw new GithubReadError('RATE_LIMIT','이번 비교의 GitHub 조회 범위를 줄여 주세요.');
  if(before?.audience&&value.audience&&JSON.stringify([...before.audience].sort())!==JSON.stringify([...value.audience].sort()))throw new GithubReadError('COMMON_ACCESS','자료 공유 상대가 변경되었습니다.');
  this.entries.set(key,{context:(before?.context??'')+(value.context??''),grants,audience:value.audience??before?.audience,expires:before?.expires??Date.now()+8*60*1000});
 }
 async complete(key:string,initial:AdapterResult,lookup:(q:GithubRead)=>Promise<{result:unknown;grant:string;audience:string[]}>,answer:(context:string)=>Promise<AdapterResult>,cancelled:()=>boolean){
  const previous=this.get(key);let count=previous?.grants.length??0;
  const result=await completeGithubReads(initial,async query=>{if(count>=8)throw new GithubReadError('RATE_LIMIT','이번 비교의 GitHub 조회 한도에 도달했습니다.');const read=await lookup(query);count++;return read;},context=>answer((previous?.context??'')+context),cancelled);
  this.seed(key,result);return result.result;
 }
}
