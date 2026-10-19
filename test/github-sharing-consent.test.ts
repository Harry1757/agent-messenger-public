import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {GithubIdentities} from '../server/github-identity.ts';
import {GithubReadError} from '../shared/github-read.ts';
import {sealIdentity} from '../shared/github-envelope.ts';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
async function fixture(){
 let verifiedId=1,permissionCalls=0,status=200;const calls:Array<{url:string;options:RequestInit|undefined}>=[];
 const github=new GithubIdentities(privateKey,async()=>({id:verifiedId,login:'actual-owner'}),async()=>{permissionCalls++;return true;},async(url,options)=>{calls.push({url:String(url),options});return new Response(status===200?JSON.stringify({number:26,title:'verified issue',html_url:'https://github.com/team/project/issues/26'}):'untrusted upstream secret',{status});});
 const seal=(query:unknown={resource:'issue',number:26})=>sealIdentity(publicKey,{...github.challenge('owner'),owner:'owner',token:'fixture-token',purpose:'github-read',repo:'team/project',thread:'thread',query});
 await github.connect('owner',sealIdentity(publicKey,{...github.challenge('owner'),owner:'owner',token:'fixture-token'}));
 return {github,seal,calls,permissionCalls:()=>permissionCalls,changeOwner:()=>{verifiedId=9;},status:(value:number)=>{status=value;}};
}
test('explicit owner sharing permits verified GitHub GET while recipient remains unconnected',async()=>{
 const f=await fixture();assert.equal(f.github.get('peer'),null);const checked:string[]=[];
 const result=await f.github.readRepository('owner',f.seal(),'thread',['owner','peer'],repo=>{checked.push(repo);return true;});
 assert.deepEqual(checked,['team/project']);assert.deepEqual(result.audience,['owner','peer']);assert.deepEqual(result.bindingOwners,['owner']);assert.equal(f.permissionCalls(),0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options?.method,'GET');assert.equal(f.calls[0].options?.redirect,'error');assert.equal(new URL(f.calls[0].url).hostname,'api.github.com');assert.equal((result.result.data as any).number,26);assert.equal(f.github.get('peer'),null);
});
test('missing sharing consent still requires recipient verification and never fetches content',async()=>{
 const f=await fixture();await assert.rejects(f.github.readRepository('owner',f.seal(),'thread',['owner','peer'],()=>false),e=>e instanceof GithubReadError&&e.code==='MEMBER_LOGIN_REQUIRED');assert.equal(f.calls.length,0);
});
test('owner sharing cannot bypass changed identity or actual GitHub repository denial',async()=>{
 const changed=await fixture();changed.changeOwner();await assert.rejects(changed.github.readRepository('owner',changed.seal(),'thread',['owner','peer'],()=>true),e=>e instanceof GithubReadError&&e.code==='LOGIN_REQUIRED');assert.equal(changed.calls.length,0);
 const denied=await fixture();denied.status(403);await assert.rejects(denied.github.readRepository('owner',denied.seal(),'thread',['owner','peer'],()=>true),e=>e instanceof GithubReadError&&e.code==='READ_PERMISSION'&&!e.message.includes('upstream'));assert.equal(denied.calls.length,1);
});
test('owner consent does not permit mutation endpoints or envelope replay',async()=>{
 const f=await fixture();for(const query of [{resource:'issues',method:'DELETE'},{resource:'delete'},{resource:'contents',path:'../secret'}])await assert.rejects(f.github.readRepository('owner',f.seal(query),'thread',['owner','peer'],()=>true),e=>e instanceof GithubReadError&&e.code==='INVALID_REQUEST');assert.equal(f.calls.length,0);
 const envelope=f.seal();await f.github.readRepository('owner',envelope,'thread',['owner','peer'],()=>true);await assert.rejects(f.github.readRepository('owner',envelope,'thread',['owner','peer'],()=>true));assert.equal(f.calls.length,1);
});
test('disconnecting the verified owner during a consented read invalidates the result',async()=>{
 let github:GithubIdentities;github=new GithubIdentities(privateKey,async()=>({id:1,login:'owner'}),async()=>true,async()=>{github.disconnect('owner');return new Response('{}');});
 const envelope=(extra={})=>sealIdentity(publicKey,{...github.challenge('owner'),owner:'owner',token:'fixture-token',...extra});await github.connect('owner',envelope());
 await assert.rejects(github.readRepository('owner',envelope({purpose:'github-read',repo:'team/project',thread:'thread',query:{resource:'issues'}}),'thread',['owner','peer'],()=>true),e=>e instanceof GithubReadError&&e.code==='ACCOUNT_CHANGED');
});
