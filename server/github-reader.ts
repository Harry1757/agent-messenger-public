import {GithubReadError,githubReadUrl,safeRepositoryFile,type GithubRead} from '../shared/github-read.ts';
import {hasSecret} from './content-safety.ts';
export type GithubReadResult={repo:string;resource:string;url:string;page:number;hasMore:boolean;truncated:boolean;data:unknown};
/** Fixed-host GET requests only. Never follow upstream URLs or execute repository content. */
export async function readGithub(token:string,repo:string,query:GithubRead,request:typeof fetch=fetch):Promise<GithubReadResult>{
 const url=githubReadUrl(repo,query);
 let response:Response;
 try{response=await request(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'AgentMessenger'},signal:AbortSignal.timeout(15000)});}catch{throw new GithubReadError('NETWORK','GitHub 응답을 받지 못했습니다. 네트워크 상태를 확인한 뒤 다시 요청해 주세요.');}
 if(!response.ok){
  if(response.status===401)throw new GithubReadError('LOGIN_REQUIRED','GitHub 로그인이 만료되었습니다. 계정을 다시 연결해 주세요.');
  if(response.status===429||response.headers.get('x-ratelimit-remaining')==='0')throw new GithubReadError('RATE_LIMIT','GitHub 조회 한도에 도달했습니다. 잠시 뒤 다시 요청해 주세요.');
  if(response.status===403)throw new GithubReadError('READ_PERMISSION','GitHub가 읽기를 허용하지 않았습니다. 연결 계정의 저장소 및 Issues·Pull requests·Contents 읽기 권한과 조직 승인을 확인해 주세요.');
  if(response.status===404)throw new GithubReadError('NOT_FOUND','GitHub에서 대상을 찾지 못했습니다. 저장소·번호·브랜치 또는 연결 계정의 접근 권한을 확인해 주세요.');
  throw new GithubReadError('UPSTREAM','GitHub 조회에 실패했습니다. 요청 범위를 확인한 뒤 다시 시도해 주세요.');
 }
 const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
 if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000){await reader.cancel();throw new GithubReadError('TOO_LARGE','조회 결과가 큽니다. 파일·커밋 또는 페이지를 나누어 요청해 주세요.');}chunks.push(value);}}
 let raw:any;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new GithubReadError('UPSTREAM','GitHub 응답 형식을 확인하지 못했습니다.');}
 let truncated=Boolean(raw?.truncated);
 // File bodies are decoded only after checking the returned path and file type.
 if(query.resource==='contents'&&!Array.isArray(raw)){
  if(raw.type!=='file'||!safeRepositoryFile(raw.path??'')||raw.size>200000||raw.encoding!=='base64')throw new GithubReadError('FILE_TYPE','일반 텍스트 파일만 읽을 수 있습니다. 연결 파일·개인 설정·큰 파일은 제외됩니다.');
  const content=Buffer.from(raw.content??'','base64').toString('utf8');
  if(content.includes('\0'))throw new GithubReadError('FILE_TYPE','일반 텍스트 파일만 읽을 수 있습니다.');
  raw={path:raw.path,sha:raw.sha,html_url:raw.html_url,content};
 }
 const fields=new Set(['number','title','body','state','merged','merged_at','mergeable','draft','message','sha','parents','stats','files','filename','previous_filename','patch','path','size','content','html_url','additions','deletions','changes','status','type','tree','truncated','total_count','items','text_matches','fragment','matches','text','labels','description','milestone','head','base','ref','repo','full_name','default_branch','language','created_at','updated_at','closed_at','submitted_at','published_at','tag_name','target_commitish','prerelease','commit','commits','user','author','committer','login','name','date','url','comments','review_comments','changed_files','ahead_by','behind_by','total_commits','encoding','mode','pull_request','permissions']);
 let budget=50000;
 const omit=new Set(['email','avatar_url','node_id','gravatar_id','permissions','verification','download_url','git_url','url','_links']);
 function clean(v:any,depth=0):any{
  if(depth>12){truncated=true;return '[중첩 내용 생략]';}
  if(typeof v==='string'){
   if(hasSecret(v))return '[민감정보가 포함되어 내용을 제외했습니다]';
   const length=Math.min(12000,budget);budget-=Math.min(v.length,length);
   if(v.length>length){truncated=true;return v.slice(0,length)+'\n[긴 내용 생략]';}return v;
  }
  if(Array.isArray(v)){if(v.length>100)truncated=true;return v.slice(0,100).map(x=>clean(x,depth+1));}
  if(v&&typeof v==='object'){
   const path=v.filename??v.path;
   if(typeof path==='string'&&(!safeRepositoryFile(path)||v.previous_filename&&!safeRepositoryFile(v.previous_filename)))return {omitted:'민감한 파일 제외'};
   return Object.fromEntries(Object.entries(v).filter(([k])=>fields.has(k)&&!omit.has(k)&&(!k.endsWith('_url')||k==='html_url')).map(([k,x])=>[k,clean(x,depth+1)]));
  }
  return v;
 }
 if(['issues','pulls','commits','search_issues','search_code'].includes(query.resource)){const items=Array.isArray(raw)?raw:raw.items;if(Array.isArray(items))for(const item of items)if(typeof item.body==='string'&&item.body.length>1600){if(hasSecret(item.body))item.body='[민감정보가 포함되어 내용을 제외했습니다]';else item.body=item.body.slice(0,1600)+'\n[상세 조회에서 계속 확인]';truncated=true;}}
 const data=clean(raw);
 if(JSON.stringify(data).length>80000)throw new GithubReadError('TOO_LARGE','조회 결과가 큽니다. 파일·커밋 또는 페이지를 나누어 요청해 주세요.');
 return {repo,resource:query.resource,url:query.number?`https://github.com/${repo}/${query.resource.startsWith('pull')?'pull':'issues'}/${query.number}`:`https://github.com/${repo}`,page:query.page??1,hasMore:/rel="next"/.test(response.headers.get('link')??''),truncated,data};
}
