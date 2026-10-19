import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {GithubIdentities} from '../server/github-identity.ts';
import {GithubConnection} from '../daemon/github-connection.ts';
import {GithubReadError} from '../shared/github-read.ts';
import {sealIdentity} from '../shared/github-envelope.ts';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
async function fixture(respond:(page:number)=>Response=()=>new Response(JSON.stringify([{name:'Project',full_name:'Team/Project'}]))){
 let identity=1;const calls:Array<{url:string;options:RequestInit|undefined}>=[];
 const github=new GithubIdentities(privateKey,async()=>({id:identity,login:'owner'}),async()=>{throw Error('permission probing forbidden');},async(url,options)=>{calls.push({url:String(url),options});return respond(Number(new URL(String(url)).searchParams.get('page')));});
 const blob=(project='project',extra={})=>sealIdentity(publicKey,{...github.challenge('owner'),owner:'owner',token:'fixture-token',purpose:'github-resolve',project,...extra});
 await github.connect('owner',sealIdentity(publicKey,{...github.challenge('owner'),owner:'owner',token:'fixture-token'}));return {github,calls,blob,changeIdentity:()=>{identity=2;}};
}
test('short project resolves exact normalized name with fixed GET pagination and returns only full_name',async()=>{
 const f=await fixture(page=>page===1?new Response(JSON.stringify([{name:'Unrelated',full_name:'Private/Unrelated',description:'PRIVATE-DESCRIPTION'}]),{headers:{link:'<https://evil.invalid/arbitrary>; rel="next"'}}):new Response(JSON.stringify([{name:'example-project',full_name:'Team/example-project'}])));
 const result=await f.github.resolveRepository('owner',f.blob('example project'));assert.equal(result,'Team/example-project');assert.equal(f.calls.length,2);for(const call of f.calls){const url=new URL(call.url);assert.equal(url.origin,'https://api.github.com');assert.equal(url.pathname,'/user/repos');assert.equal(url.searchParams.get('per_page'),'100');assert.equal(url.searchParams.get('affiliation'),'owner,collaborator,organization_member');assert.equal(call.options?.method,'GET');assert.equal(call.options?.redirect,'error');}assert(!result.includes('Private'));
});
test('missing or ambiguous names never disclose a repository list',async()=>{
 for(const rows of [[{name:'Other',full_name:'Private/Other'}],[{name:'project',full_name:'One/project'},{name:'project',full_name:'Two/project'}]]){const f=await fixture(()=>new Response(JSON.stringify(rows)));await assert.rejects(f.github.resolveRepository('owner',f.blob()),e=>e instanceof GithubReadError&&e.code==='PROJECT'&&!e.message.includes('Private')&&!e.message.includes('One/'));}
});
test('resolver stops after three fixed pages and does not assume uniqueness in an incomplete scan',async()=>{
 const f=await fixture(page=>new Response(JSON.stringify([{name:page===1?'project':'other',full_name:page===1?'Team/project':`Team/other${page}`}]),{headers:{link:'<https://api.github.com/anything>; rel="next"'}}));await assert.rejects(f.github.resolveRepository('owner',f.blob()),e=>e instanceof GithubReadError&&e.code==='PROJECT');assert.equal(f.calls.length,3);
});
test('resolver rejects arbitrary paths, supplied URLs, extra query fields and envelope replay before network access',async()=>{
 const f=await fixture();for(const project of ['../outside','/Users/person','a/b','https://github.com/a/b','.','..'])await assert.rejects(f.github.resolveRepository('owner',f.blob(project)),e=>e instanceof GithubReadError&&e.code==='PROJECT');await assert.rejects(f.github.resolveRepository('owner',f.blob('project',{query:{url:'https://evil.invalid'}})),e=>e instanceof GithubReadError&&e.code==='PROJECT');assert.equal(f.calls.length,0);const envelope=f.blob();assert.equal(await f.github.resolveRepository('owner',envelope),'Team/Project');await assert.rejects(f.github.resolveRepository('owner',envelope));assert.equal(f.calls.length,1);
});
test('owner identity mismatch and typed HTTP authentication failures do not expose upstream bodies',async()=>{
 const f=await fixture();f.changeIdentity();await assert.rejects(f.github.resolveRepository('owner',f.blob()),e=>e instanceof GithubReadError&&e.code==='LOGIN_REQUIRED');assert.equal(f.calls.length,0);
 for(const [status,code] of [[401,'LOGIN_REQUIRED'],[403,'READ_PERMISSION'],[429,'RATE_LIMIT'],[500,'UPSTREAM']] as const){const denied=await fixture(()=>new Response('UPSTREAM-SECRET',{status}));await assert.rejects(denied.github.resolveRepository('owner',denied.blob()),e=>e instanceof GithubReadError&&e.code===code&&!e.message.includes('SECRET'));}
});
test('daemon explicit owner/repo bypasses discovery while short name uses an encrypted owner challenge',async()=>{
 let tokenCalls=0;const calls:Array<{url:string;options:RequestInit|undefined}>=[];const connection=new GithubConnection({serverUrl:'https://messenger.invalid',agentName:'owner',token:'messenger-token'} as any,{token:async()=>{tokenCalls++;return 'ghp_'+'x'.repeat(32);},request:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(String(url).endsWith('/challenge')?{nonce:'nonce'}:'Team/example-project'));}});
 assert.equal(await connection.resolveProject('Team/Project'),'Team/Project');assert.equal(tokenCalls,0);assert.equal(calls.length,0);assert.equal(await connection.resolveProject('example project'),'Team/example-project');assert.equal(tokenCalls,1);assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/api/github/challenge','/api/github/resolve']);assert(calls.every(c=>c.options?.method==='POST'));assert(!String(calls[1].options?.body).includes('ghp_'));assert.deepEqual(Object.keys(JSON.parse(String(calls[1].options?.body))),['envelope']);
 for(const bad of ['../private','C:\\Users','https://evil.invalid','team/repo/other'])await assert.rejects(connection.resolveProject(bad),e=>e instanceof GithubReadError&&e.code==='PROJECT');assert.equal(calls.length,2);
});
test('daemon missing authentication produces LOGIN_REQUIRED before resolve request',async()=>{
 const calls:string[]=[];const connection=new GithubConnection({serverUrl:'https://messenger.invalid',agentName:'owner',token:'messenger-token'} as any,{token:async()=>{throw Error('raw credential failure');},request:async url=>{calls.push(String(url));return new Response(JSON.stringify({nonce:'nonce'}));}});await assert.rejects(connection.resolveProject('project'),e=>e instanceof GithubReadError&&e.code==='LOGIN_REQUIRED'&&!e.message.includes('raw'));assert.equal(calls.length,1);
});
test('owner disconnection during lookup and malformed or oversized upstream data fail closed',async()=>{
 let active:GithubIdentities;const disconnected=await fixture(()=>{active.disconnect('owner');return new Response(JSON.stringify([{name:'project',full_name:'Team/project'}]));});active=disconnected.github;await assert.rejects(active.resolveRepository('owner',disconnected.blob()),e=>e instanceof GithubReadError&&e.code==='ACCOUNT_CHANGED');
 for(const response of [new Response('not-json'),new Response(JSON.stringify({items:[]})),new Response('x'.repeat(2000001))]){const f=await fixture(()=>response);await assert.rejects(f.github.resolveRepository('owner',f.blob()),e=>e instanceof GithubReadError&&['UPSTREAM','TOO_LARGE'].includes(e.code));}
});
