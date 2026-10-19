import {test} from 'node:test';import assert from 'node:assert/strict';
import {completeGithubReads,resolveGithubProject} from '../daemon/github-reads.ts';
import {buildSystemPrompt} from '../daemon/prompt.ts';
import {isFileQuestion} from '../shared/file-question.ts';
const reply=(text:string)=>({ok:true,text,costUsd:0,sessionId:null,error:null});
test('issue read and comments produce one final answer with verified scope attached',async()=>{
 const resources:string[]=[];const prompts:string[]=[];
 const done=await completeGithubReads(reply('GITHUB_READ{"project":"team/repo","resource":"issue","number":26}'),async q=>{resources.push(q.resource);return {result:{body:'actual content'},grant:'grant-'+resources.length,audience:['a','b']};},async prompt=>{prompts.push(prompt);return reply(resources.length===1?'GITHUB_READ{"project":"team/repo","resource":"issue_comments","number":26}':'SUMMARY{"conclusion":"done","findings":[],"nextSteps":[]}');});
 assert.deepEqual(resources,['issue','issue_comments']);assert.equal(prompts.length,2);assert.match(prompts[1],/actual content/);assert.match(done.result.text,/SUMMARY/);assert.equal(done.grants.length,2);
});
test('normal conversation uses no GitHub requests and newer user request stops lookup',async()=>{
 let calls=0;const lookup=async()=>{calls++;return {result:{},grant:'g',audience:['a']};};
 await completeGithubReads(reply('안녕하세요'),lookup,async()=>reply('done'));
 await completeGithubReads(reply('GITHUB_READ{"project":"team/repo","resource":"issues"}'),lookup,async()=>reply('done'),()=>true);assert.equal(calls,0);
});
test('audience changes stop without publishing results to changed participants',async()=>{
 const q=reply('GITHUB_READ{"project":"team/repo","resource":"issues"}');
 let count=0;await assert.rejects(completeGithubReads(q,async()=>({result:{},grant:'g'+(++count),audience:count===1?['a']:['a','b']}),async()=>reply('GITHUB_READ{"project":"team/repo","resource":"pulls"}')),/참여자/);
});
test('explicit repository and GitHub natural requests are supported without personal directory scans',async()=>{
 assert.equal(await resolveGithubProject('team/repo',[]),'team/repo');
 await assert.rejects(resolveGithubProject('../private',[]));
 for(const text of ['@예제동료 example project cdn관련 깃 이슈 확인해주세요','PR 변경내용 읽어줘','최근 커밋 확인해줘'])assert(isFileQuestion(text));
 assert.match(buildSystemPrompt('a',[]),/pull_files/);assert.match(buildSystemPrompt('a',[]),/issue_comments/);
});
test('invalid model query is repaired before lookup and the original results remain in context',async()=>{
 const prompts:string[]=[];const queried:string[]=[];
 const done=await completeGithubReads(reply('GITHUB_READ{"project":"team/repo","resource":"search_issues","query":"cdn in:title,body"}'),async q=>{queried.push(q.resource);return {result:{number:26,title:'CDN'},grant:'g',audience:['a','b']};},async prompt=>{prompts.push(prompt);return reply(prompts.length===1?'GITHUB_READ{"project":"team/repo","resource":"search_issues","query":"cdn"}':'SUMMARY{"conclusion":"CDN issue 26","findings":[],"nextSteps":[]}');});
 assert.deepEqual(queried,['search_issues']);assert.equal(done.grants.length,1);assert.match(prompts[0],/query/);assert.match(prompts[1],/CDN/);
});
test('repair is bounded, never executes invalid requests, and cannot claim a result without reading',async()=>{
 for(const replacement of ['GITHUB_READ{"project":"team/repo","resource":"delete"}','SUMMARY{"conclusion":"read completed"}']){
  let attempts=0,calls=0;
  await assert.rejects(completeGithubReads(reply('GITHUB_READ{}'),async()=>{calls++;throw Error('must not read');},async()=>{attempts++;return reply(replacement);}), (e:any)=>e.code==='REQUEST_FORMAT');
  assert.equal(attempts,2);assert.equal(calls,0);
 }
});
test('permission/network errors do not trigger format repair and superseded work stops before repair',async()=>{
 let attempts=0;
 const {GithubReadError}=await import('../shared/github-read.ts');
 for(const code of ['READ_PERMISSION','NETWORK','MEMBER_LOGIN_REQUIRED'])await assert.rejects(completeGithubReads(reply('GITHUB_READ{"project":"team/repo","resource":"issues"}'),async()=>{throw new GithubReadError(code,'denied');},async()=>{attempts++;return reply('retry');}),(e:any)=>e.code===code);
 await completeGithubReads(reply('GITHUB_READ{}'),async()=>{throw Error('unexpected');},async()=>{attempts++;return reply('retry');},()=>true);
 assert.equal(attempts,0);
});
test('format repair during a followup preserves prior read proofs and context',async()=>{
 let turns=0;const prompts:string[]=[];
 const result=await completeGithubReads(reply('GITHUB_READ{"project":"team/repo","resource":"issues"}'),async q=>({result:{kind:q.resource},grant:q.resource,audience:['a']}),async context=>{prompts.push(context);turns++;return reply(turns===1?'GITHUB_READ{"project":"team/repo","resource":"issue","number":"26"}':turns===2?'GITHUB_READ{"project":"team/repo","resource":"issue","number":26}':'done');});
 assert.deepEqual(result.grants,['issues','issue']);assert.match(prompts[1],/"kind":"issues"/);assert.match(prompts[2],/"kind":"issue"/);
});
test('duplicate lookup finalizes gathered facts once instead of discarding them',async()=>{
 const q=reply('GITHUB_READ{"project":"team/repo","resource":"issues"}');let reads=0,turns=0;const prompts:string[]=[];
 const done=await completeGithubReads(q,async()=>{reads++;return {result:{data:[{number:26,title:'CDN'}]},grant:'g',audience:['a']};},async context=>{prompts.push(context);return ++turns===1?q:reply('SUMMARY{"conclusion":"이슈 26 확인","findings":["CDN 이슈"],"nextSteps":[]}');});
 assert.equal(reads,1);assert.equal(turns,2);assert.deepEqual(done.grants,['g']);assert.match(prompts[1],/CDN/);assert.match(done.result.text,/이슈 26/);assert.match(done.result.text,/반복/);
});
test('six read budget stops API calls but produces a bounded partial answer',async()=>{
 let reads=0,turns=0;
 const q=(n:number)=>reply('GITHUB_READ'+JSON.stringify({project:'team/repo',resource:'issue',number:n}));
 const done=await completeGithubReads(q(1),async()=>({result:{data:'fact '+(++reads)},grant:String(reads),audience:['a']}),async()=>++turns<=6?q(turns+1):reply('SUMMARY{"conclusion":"확인한 결과","findings":["일부 확인"],"nextSteps":[]}'));
 assert.equal(reads,6);assert.equal(turns,7);assert.equal(done.grants.length,6);assert.match(done.result.text,/6회/);
});
test('finalization cannot restart tools or lose successful reads when model fails',async()=>{
 const q=reply('GITHUB_READ{"project":"team/repo","resource":"issue","number":26}');
 for(const last of [q,reply('DECISION{}'),{...reply(''),ok:false,error:'offline'}]){
  let turns=0;const done=await completeGithubReads(q,async()=>({result:{url:'https://github.com/team/repo/issues/26',data:{title:'CDN'}},grant:'g',audience:['a']}),async()=>++turns===1?q:last);
  assert.equal(turns,2);assert(done.result.ok);assert.match(done.result.text,/SUMMARY/);assert.match(done.result.text,/https:\/\/github.com\/team\/repo\/issues\/26/);assert.deepEqual(done.grants,['g']);
 }
});
test('equivalent requests with reordered keys/default page use the same lookup identity',async()=>{
 let reads=0,turns=0;
 const done=await completeGithubReads(reply('GITHUB_READ{"project":"team/repo","resource":"issues"}'),async()=>({result:{},grant:String(++reads),audience:['a']}),async()=>++turns===1?reply('GITHUB_READ{"resource":"issues","page":1,"project":"team/repo"}'):reply('SUMMARY{"conclusion":"done","findings":[],"nextSteps":[]}'));
 assert.equal(reads,1);assert.equal(turns,2);assert.equal(done.grants.length,1);
});
