import {test} from 'node:test';
import assert from 'node:assert/strict';
import {githubReadUrl,parseGithubRead} from '../shared/github-read.ts';
import {readGithub} from '../server/github-reader.ts';
const repo='team/project';
test('read requests cover issues, PR files/reviews, commits and repository files',()=>{
 for(const [resource,extra,path] of [
  ['issues',{},'/issues'],['issue',{number:26},'/issues/26'],['issue_comments',{number:26},'/issues/26/comments'],
  ['pull',{number:8},'/pulls/8'],['pull_files',{number:8},'/pulls/8/files'],['pull_reviews',{number:8},'/pulls/8/reviews'],
  ['pull_comments',{number:8},'/pulls/8/comments'],['pull_commits',{number:8},'/pulls/8/commits'],
  ['commits',{},'/commits'],['commit',{ref:'dev'},'/commits/dev'],['branches',{},'/branches'],
  ['contents',{path:'src/app.ts',ref:'feature/test'},'/contents/src/app.ts'],
 ] as const){assert.equal(new URL(githubReadUrl(repo,{resource,...extra})).pathname,'/repos/'+repo+path);}
 assert.equal(parseGithubRead('GITHUB_READ{"project":"example project","resource":"issue","number":26}')?.number,26);
 assert.equal(parseGithubRead('일반 대화'),null);
});
test('arbitrary endpoints, traversal, secrets, writes and cross-repo search cannot be requested',()=>{
 for(const request of [{resource:'delete'},{resource:'issue',number:-1},{resource:'contents',path:'../secrets'},{resource:'contents',path:'.env'},{resource:'contents',path:'%2e%2e/secret'},{resource:'commit',ref:'../../users'},{resource:'issues',method:'DELETE'},{resource:'search_issues',query:'repo:other/private'}])assert.throws(()=>githubReadUrl(repo,request));
 for(const invalid of ['../private','https://evil.test/x','a/b/c'])assert.throws(()=>githubReadUrl(invalid,{resource:'issues'}));
});
test('GitHub requests are GET only, refuse redirects, redact secrets and indicate pagination',async()=>{
 const calls:any[]=[];
 const output=await readGithub('fixture',repo,{resource:'pull_files',number:2},async(url,options)=>{
  calls.push([url,options]);return new Response(JSON.stringify([{filename:'.env',patch:'secret'},{filename:'src/app.ts',patch:'+ safe change'}]),{headers:{link:'<https://api.github.com/next>; rel="next"'}});
 });
 assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].redirect,'error');
 assert(!JSON.stringify(output).includes('secret'));assert(JSON.stringify(output).includes('safe change'));assert.equal(output.hasMore,true);
 const secret=await readGithub('fixture',repo,{resource:'issue',number:2},async()=>new Response(JSON.stringify({body:'ghp_'+'a'.repeat(30)})));
 assert(!JSON.stringify(secret).includes('ghp_'));assert(JSON.stringify(secret).includes('민감정보'));
});
test('status errors are actionable and no raw body or credentials escape',async()=>{
 for(const [status,code] of [[401,'LOGIN_REQUIRED'],[403,'READ_PERMISSION'],[404,'NOT_FOUND'],[429,'RATE_LIMIT']] as const){
  await assert.rejects(readGithub('fixture',repo,{resource:'issue',number:26},async()=>new Response('secret upstream body',{status})),(e:any)=>e.code===code&&!e.message.includes('secret'));
 }
});
test('long results keep a bounded preview with explicit truncation, not a failed normal PR',async()=>{
 const data=Array.from({length:30},(_,i)=>({number:i+1,title:'PR '+i,body:'review '.repeat(5000)}));
 const r=await readGithub('fixture',repo,{resource:'pulls'},async()=>new Response(JSON.stringify(data)));
 assert(r.truncated);assert(JSON.stringify(r).length<80000);
});
test('file replies reject symlinks/binary data and sanitize nested credential strings',async()=>{
 await assert.rejects(readGithub('fixture',repo,{resource:'contents',path:'README.md'},async()=>new Response(JSON.stringify({type:'symlink',target:'/outside',path:'README.md'}))),/일반 텍스트/);
 const r=await readGithub('fixture',repo,{resource:'contents',path:'README.md'},async()=>new Response(JSON.stringify({type:'file',size:80,path:'README.md',encoding:'base64',content:Buffer.from('api_key=abcdefghijk').toString('base64')})));
 assert(!JSON.stringify(r).includes('abcdefghijk'));
});
test('repository files support real Next.js and Korean paths while traversal remains denied',()=>{
 for(const path of ['app/[slug]/page.tsx','src/(admin)/page.tsx','docs/설치 안내.md']){
  const url=new URL(githubReadUrl(repo,{resource:'contents',path}));assert.equal(decodeURIComponent(url.pathname),'/repos/'+repo+'/contents/'+path);
  assert.equal(new URL(githubReadUrl(repo,{resource:'commits',path})).searchParams.get('path'),path);
 }
 for(const path of ['/etc/passwd','docs/../secret','docs\\secret','docs/%2e%2e/x'])assert.throws(()=>githubReadUrl(repo,{resource:'contents',path}));
});
