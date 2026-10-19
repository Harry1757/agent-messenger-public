export type GithubRead = {project?:string;resource:string;number?:number;ref?:string;base?:string;head?:string;path?:string;query?:string;page?:number;state?:string};
export class GithubReadError extends Error {
 code:string;
 constructor(code:string,message:string){super(message);this.code=code;}
}
export function safeRepositoryFile(path:string):boolean {
 return !/(^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude|node_modules)([\\/]|$)|(^|[\\/])\.env(?:\.|$)|(?:^|[\\/])(?:auth|credentials|secrets)(?:\.|$)|\.(?:pem|key|p12|pfx|db|sqlite|png|jpe?g|gif|webp)$/i.test(path);
}
export function validRepo(repo:unknown):repo is string {return typeof repo==='string'&&/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)&&!['.','..'].includes(repo.split('/')[1]);}
function invalid():never {throw new GithubReadError('INVALID_REQUEST','GitHub 조회 대상이 올바르지 않습니다. 저장소와 이슈·PR 번호 또는 파일 경로를 확인해 주세요.');}
function ref(value:unknown):string {if(typeof value!=='string'||!value||value.length>200||!/^[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))invalid();return encodeURIComponent(value);}
function filePath(value:unknown):string {
 if(typeof value!=='string'||!value||value.length>1000||/[\\%\x00-\x1f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||!safeRepositoryFile(value))invalid();
 return value.split('/').map(encodeURIComponent).join('/');
}
export function githubReadUrl(repo:string,input:unknown):string {
 if(!validRepo(repo)||!input||typeof input!=='object'||Array.isArray(input))invalid();
 const q=input as GithubRead;
 if(Object.keys(q).some(k=>!['project','resource','number','ref','base','head','path','query','page','state'].includes(k)))invalid();
 if(q.page!==undefined&&(!Number.isInteger(q.page)||q.page<1||q.page>100))invalid();
 if(q.state!==undefined&&!['open','closed','all'].includes(q.state))invalid();
 const page=new URLSearchParams({per_page:'30',page:String(q.page??1)});
 const num=()=>{if(!Number.isSafeInteger(q.number)||q.number!<=0)invalid();return q.number;};
 let path='';
 switch(q.resource){
  case 'repository':path='';break;
  case 'issues':case 'pulls':path='/'+q.resource;page.set('state',q.state??'all');page.set('sort','updated');page.set('direction','desc');break;
  case 'issue':path=`/issues/${num()}`;break;
  case 'issue_comments':path=`/issues/${num()}/comments`;break;
  case 'pull':path=`/pulls/${num()}`;break;
  case 'pull_files':case 'pull_reviews':case 'pull_comments':case 'pull_commits':path=`/pulls/${num()}/${q.resource.slice(5)}`;break;
  case 'commits':path='/commits';if(q.ref)page.set('sha',decodeURIComponent(ref(q.ref)));if(q.path)page.set('path',decodeURIComponent(filePath(q.path)));break;
  case 'commit':path='/commits/'+ref(q.ref);break;
  case 'commit_comments':path='/commits/'+ref(q.ref)+'/comments';break;
  case 'compare':path='/compare/'+ref(q.base)+'...'+ref(q.head);break;
  case 'branches':case 'tags':case 'releases':path='/'+q.resource;break;
  case 'tree':path='/git/trees/'+ref(q.ref??'HEAD');page.set('recursive','1');break;
  case 'contents':
   if(typeof q.path!=='string'||!safeRepositoryFile(q.path))invalid();
   path='/contents/'+filePath(q.path);
   if(q.ref)page.set('ref',decodeURIComponent(ref(q.ref)));break;
  case 'search_issues':case 'search_code':
   if(typeof q.query!=='string'||!q.query.trim()||q.query.length>200||(!/^[\p{L}\p{N} _./-]+$/u.test(q.query)||/\bOR\b/i.test(q.query)))invalid();
   page.set('q',`repo:${repo} ${q.query}`);
   return `https://api.github.com/search/${q.resource==='search_issues'?'issues':'code'}?${page}`;
  default:invalid();
 }
 return `https://api.github.com/repos/${repo}${path}?${page}`;
}
export function parseGithubRead(text:string):GithubRead|null {
 const value=text.trim().replace(/^```(?:json)?\s*\n?|\n?```$/g,'').trim();
 if(!value.startsWith('GITHUB_READ'))return null;
 let q:GithubRead;try{q=JSON.parse(value.slice(11).trim());}catch{invalid();}
 if(!q||typeof q.project!=='string'||!q.project.trim()||q.project.length>200)invalid();
 githubReadUrl('validation/repo',q);return q;
}
