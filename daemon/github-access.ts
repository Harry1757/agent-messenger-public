import {runCommand} from './process.ts';
export type GithubRunner=typeof runCommand;
export const GITHUB_LOGIN_HELP='GitHub CLI가 없다면 https://cli.github.com 에서 설치한 뒤, 터미널에서 gh auth login --hostname github.com --web 을 실행해 주세요. 로그인 후 앱을 다시 시작해 주세요. 일반 대화는 계속 사용할 수 있습니다.';
export function githubRepo(remote:string):string|null {
 const m=remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
 return m && !['.','..'].includes(m[2])?`${m[1]}/${m[2]}`:null;
}
export async function githubLogin(run:GithubRunner=runCommand):Promise<{ok:boolean;login?:string;detail:string}> {
 try{
  const r=await run('gh',['api','--hostname','github.com','user'],{timeout:15000});
  if(r.error)throw Error();const user=JSON.parse(r.stdout);
  if(typeof user.login!=='string'||!Number.isSafeInteger(user.id))throw Error();
  return {ok:true,login:user.login,detail:`GitHub: ${user.login}`};
 }catch{return {ok:false,detail:GITHUB_LOGIN_HELP};}
}
export async function checkCommonAccess(repo:string,identities:({login:string}|null)[],run:GithubRunner=runCommand):Promise<{common:boolean;reason:string}>{
 if(!identities.length||identities.some(i=>!i||!/^[A-Za-z0-9-]+$/.test(i.login)))return {common:false,reason:'GitHub 연결이 확인되지 않은 참여자가 있습니다'};
 if(!githubRepo(`https://github.com/${repo}`))return {common:false,reason:'GitHub 저장소를 확인할 수 없습니다'};
 try{
  for(const identity of identities){
   const r=await run('gh',['api','--hostname','github.com',`repos/${repo}/collaborators/${identity!.login}/permission`],{timeout:15000});
   if(r.error||!['read','write','admin'].includes(JSON.parse(r.stdout).permission))return {common:false,reason:'모든 참여자의 저장소 접근 권한이 확인되지 않았습니다'};
  }
  return {common:true,reason:'참여자 전원의 GitHub 저장소 접근 권한을 확인했습니다'};
 }catch{return {common:false,reason:'GitHub 권한 조회에 실패했습니다'};}
}
