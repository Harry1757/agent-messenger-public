import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeGithubReads} from '../daemon/github-reads.ts';
import {GithubReadError} from '../shared/github-read.ts';
const reply=(text:string)=>({ok:true,text,costUsd:0,sessionId:null,error:null});
const first=reply('GITHUB_READ{"project":"team/repo","resource":"issue","number":26}');
const next=reply('GITHUB_READ{"project":"team/repo","resource":"issue_comments","number":26}');
test('later permission failure preserves verified result, grants and audience with one safe recovery summary',async()=>{
 const prompts:string[]=[];let reads=0;const secret='ghp_'+'x'.repeat(32);
 const done=await completeGithubReads(first,async()=>{if(++reads===1)return {result:{url:'https://github.com/team/repo/issues/26',title:'Verified CDN issue',body:secret},grant:'first-proof',audience:['owner','peer']};throw new GithubReadError('READ_PERMISSION','upstream '+secret);},async context=>{prompts.push(context);return prompts.length===1?next:reply('SUMMARY{"conclusion":"CDN issue verified","findings":["Issue 26 exists"],"nextSteps":["Read comments after permission recovery"]}');});
 assert.equal(reads,2);assert.equal(prompts.length,2);assert.deepEqual(done.grants,['first-proof']);assert.deepEqual(done.audience,['owner','peer']);assert.equal(done.recovery?.code,'READ_PERMISSION');assert.equal(done.recovery?.query.resource,'issue_comments');assert.match(done.result.text,/CDN issue verified/);assert.match(done.result.text,/미확인/);assert.match(done.result.text,/https:\/\/github.com\/team\/repo\/issues\/26/);assert(!JSON.stringify({prompts,done}).includes(secret));
});
test('network retry happens once for the same query, then returns partial recovery without a model repair loop',async()=>{const reads:string[]=[];let answers=0;const done=await completeGithubReads(first,async q=>{reads.push(q.resource);if(q.resource==='issue')return {result:{title:'verified'},grant:'g',audience:['a']};throw new GithubReadError('NETWORK','network');},async()=>++answers===1?next:reply('SUMMARY{"conclusion":"Partial","findings":[],"nextSteps":[]}'));assert.deepEqual(reads,['issue','issue_comments','issue_comments']);assert.equal(answers,2);assert.equal(done.recovery?.code,'NETWORK');assert.deepEqual(done.grants,['g']);});
test('transient retry success continues normally, while auth/rate failures do not retry',async()=>{
 let reads=0,answers=0;const done=await completeGithubReads(first,async()=>{if(++reads===1)throw new GithubReadError('NETWORK','temporary');return {result:{title:'success'},grant:'g',audience:['a']};},async()=>{answers++;return reply('done');});assert.equal(reads,2);assert.equal(answers,1);assert.equal(done.recovery,undefined);
 for(const code of ['LOGIN_REQUIRED','MEMBER_LOGIN_REQUIRED','RATE_LIMIT']){let count=0;await assert.rejects(completeGithubReads(first,async()=>{count++;throw new GithubReadError(code,'failed');},async()=>reply('unused')),e=>e instanceof GithubReadError&&e.code===code);assert.equal(count,1);}
});
test('partial recovery keeps source evidence when final model call fails, but audience change remains a hard failure',async()=>{
 let reads=0,answers=0;const done=await completeGithubReads(first,async()=>{if(++reads===1)return {result:{url:'https://github.com/team/repo/issues/26'},grant:'g',audience:['a']};throw new GithubReadError('NOT_FOUND','missing');},async()=>{if(++answers===1)return next;throw Error('model offline');});assert(done.result.ok);assert.match(done.result.text,/issues\/26/);assert.equal(done.recovery?.code,'NOT_FOUND');assert.deepEqual(done.grants,['g']);
 let lookup=0;await assert.rejects(completeGithubReads(first,async()=>{if(++lookup===1)return {result:{},grant:'g',audience:['a']};throw new GithubReadError('ACCOUNT_CHANGED','changed');},async()=>next),e=>e instanceof GithubReadError&&e.code==='ACCOUNT_CHANGED');
});
