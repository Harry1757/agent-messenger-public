import {test} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,randomUUID} from 'node:crypto';
import {openDb,upsertUser} from '../server/db.ts';import {buildApp} from '../server/routes.ts';
import {GithubIdentities} from '../server/github-identity.ts';import {sealIdentity} from '../shared/github-envelope.ts';
test('GitHub routes verify identity and restrict signed participant records to thread members',async()=>{
 const db=openDb(':memory:');for(const n of ['owner','stranger'])upsertUser(db,n,n);
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const github=new GithubIdentities(privateKey,async()=>({id:1,login:'verified'}));
 const srv=buildApp(db,{github}).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 const call=(path:string,body?:object,user='owner')=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const challenge=await(await call('/github/challenge',{})).json();
  const envelope=sealIdentity(publicKey,{...challenge,owner:'owner',token:'FIXTURE_SECRET'});
  assert.equal((await call('/github/connect',{envelope},'stranger')).status,400);
  assert.equal((await call('/github/connect',{envelope})).status,200);
  assert.equal((await call('/github/connect',{envelope})).status,400);
  const t=await(await call('/threads',{title:'private'})).json();const nonce=randomUUID();
  assert.equal((await call(`/threads/${t.id}/github?nonce=${nonce}`,undefined,'stranger')).status,404);
  assert.equal((await call(`/threads/${t.id}/github-readiness`,undefined,'stranger')).status,404);
  assert.deepEqual(await(await call(`/threads/${t.id}/github-readiness`)).json(),{active:false});
  const signed=await(await call(`/threads/${t.id}/github?nonce=${nonce}`)).json();
  assert(verify('sha256',Buffer.from(signed.payload),publicKey,Buffer.from(signed.signature,'base64')));
  assert.equal(JSON.parse(signed.payload).members[0].identity.login,'verified');assert(!JSON.stringify(signed).includes('FIXTURE_SECRET'));
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});

test('legacy compatibility: common read HTTP grant verifies every participant and cannot bypass scope or secrets',async()=>{
 const {createThread,addThreadMember}=await import('../server/db.ts');
 const {createHash}=await import('node:crypto');
 const db=openDb(':memory:');for(const name of ['owner','peer','stranger'])upsertUser(db,name,name);
 const t=createThread(db,'common read','owner');addThreadMember(db,t.id,'peer');
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let allowed=true;const verified:string[]=[];
 const github=new GithubIdentities(privateKey,async token=>({id:token==='owner-token'?1:2,login:token==='owner-token'?'owner-gh':'peer-gh'}),async(_token,repo,login)=>{assert.equal(repo,'team/project');verified.push(login);return allowed;});
 const srv=buildApp(db,{github,securityLock:false}).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 const call=(path:string,body?:object,user='owner')=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','X-Agent-Protocol':'conversation-only-v1'},...(body?{body:JSON.stringify(body)}:{})});
 const envelope=async(owner:string,purpose?:'common-read')=>{const challenge=await(await call('/github/challenge',{},owner)).json();return sealIdentity(publicKey,{...challenge,owner,token:owner+'-token',...(purpose?{purpose,repo:'team/project'}:{})});};
 const grant=async()=>call(`/threads/${t.id}/file-read-grant`,{repo:'team/project',path:'README.md',envelope:await envelope('owner','common-read')});
 const post=(id:string,content='Docs use /Users/example/Desktop/project\n',audience=['owner','peer'],path='README.md')=>call(`/threads/${t.id}/messages`,{author:'owner',authorType:'agent',kind:'text',body:`공통 저장소에서 확인한 파일 내용: ${path}\n내용 해시: ${createHash('sha256').update(content).digest('hex')}\n\n${content}`,fileAudience:audience,fileReadGrant:id});
 try{
  assert.equal((await call('/github/connect',{envelope:await envelope('owner')})).status,200);
  assert.equal((await grant()).status,403,'missing peer identity blocks automatic read');
  assert.equal((await call('/github/connect',{envelope:await envelope('peer')},'peer')).status,200);
  allowed=false;assert.equal((await grant()).status,403,'no repo access blocks automatic read');allowed=true;
  const issued=await(await grant()).json();assert.deepEqual(new Set(verified),new Set(['owner-gh','peer-gh']));
  assert.equal((await post(issued.grant)).status,200,'content keeps final newline and needs no owner decision');
  assert.equal((await post(issued.grant)).status,403,'grant cannot replay');
  assert.equal((await post('invented')).status,403);
  assert.equal((await post((await(await grant()).json()).grant,'hello',['owner','peer'],'other.md')).status,403);
  assert.equal((await post((await(await grant()).json()).grant,'hello',['owner'])).status,409);
  assert.equal((await post((await(await grant()).json()).grant,'-----BEGIN OPENSSH PRIVATE KEY-----')).status,422);
  const beforeDisconnect=await(await grant()).json();github.disconnect('peer');
  assert.equal((await post(beforeDisconnect.grant)).status,403,'disconnect invalidates previously granted read');
  assert.equal((await call(`/threads/${t.id}/file-read-grant`,{repo:'team/project',path:'README.md',envelope:'invalid'},'stranger')).status,404);
  const messages=await(await call(`/threads/${t.id}/messages`)).json();assert.equal(messages.filter((m:any)=>m.kind==='decision_request').length,0);
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});

test('background identity refresh cannot replace an in-flight read challenge',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const github=new GithubIdentities(privateKey,async()=>({id:1,login:'owner'}),async()=>true);
 const seal=(purpose?:'common-read')=>sealIdentity(publicKey,{...github.challenge('owner'),owner:'owner',token:'fixture',...(purpose?{purpose,repo:'team/project'}:{})});
 await github.connect('owner',seal());const read=seal('common-read');const refresh=seal();
 await github.connect('owner',refresh);assert.equal(await github.readScope('owner',read,'team/project',['owner']),'[1]');
 await assert.rejects(github.readScope('owner',read,'team/project',['owner']));
});

test('GitHub read API requires every member, binds query, hides secrets and rejects sharing after account change',async()=>{
 const {createThread,addThreadMember}=await import('../server/db.ts');
 const db=openDb(':memory:');for(const n of ['owner','peer','stranger'])upsertUser(db,n,n);
 const t=createThread(db,'repo read','owner');addThreadMember(db,t.id,'peer');
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let allowed=true,calls=0;
 const github=new GithubIdentities(privateKey,async token=>({id:token==='owner'?1:2,login:token}),async()=>allowed,
 async()=>{calls++;return new Response(JSON.stringify({number:26,title:'CDN issue',body:'Details'}));});
 const srv=buildApp(db,{github,securityLock:true}).listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 const call=(path:string,body?:object,user='owner')=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','X-Agent-Protocol':'conversation-only-v1'},...(body?{body:JSON.stringify(body)}:{})});
 const seal=async(owner:string,read=false)=>sealIdentity(publicKey,{...(await(await call('/github/challenge',{},owner)).json()),owner,token:owner,...(read?{purpose:'github-read' as const,repo:'team/project',query:{resource:'issue',number:26},thread:t.id}: {})});
 const read=async(user='owner')=>call(`/threads/${t.id}/github/read`,{envelope:await seal(user,true)},user);
 try{
  await call('/github/connect',{envelope:await seal('owner')});
  assert.equal((await read()).status,403);assert.equal(calls,0);
  await call('/github/connect',{envelope:await seal('peer')},'peer');
  allowed=false;assert.equal((await read()).status,403);assert.equal(calls,0);allowed=true;
  const r=await read();assert.equal(r.status,200);const value=await r.json();assert.equal(value.result.data.number,26);
  assert.equal((await read('stranger')).status,404);
  const post=(grant:string)=>call(`/threads/${t.id}/messages`,{author:'owner',authorType:'agent',kind:'summary',body:'CDN issue summary',githubReadGrants:[grant],fileAudience:['owner','peer']});
  assert.equal((await post(value.grant)).status,200);
  assert.equal((await post(value.grant)).status,403);
  const next=await(await read()).json();github.disconnect('peer');assert.equal((await post(next.grant)).status,403);
 }finally{await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});
test('GitHub read refuses account change during fetch and mismatched encrypted thread',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let began:()=>void;let finish:()=>void;
 const started=new Promise<void>(r=>began=r);const wait=new Promise<void>(r=>finish=r);
 const github=new GithubIdentities(privateKey,async token=>({id:token==='owner'?1:2,login:token}),async()=>true,async()=>{began();await wait;return new Response('{}');});
 const seal=(owner:string,extra={})=>sealIdentity(publicKey,{...github.challenge(owner),owner,token:owner,...extra});
 for(const owner of ['owner','peer'])await github.connect(owner,seal(owner));
 const blob=()=>seal('owner',{purpose:'github-read',repo:'team/project',thread:'t',query:{resource:'issue',number:26}});
 await assert.rejects(github.readRepository('owner',blob(),'other',['owner','peer']),/대화/);
 const request=github.readRepository('owner',blob(),'t',['owner','peer']);await started;github.disconnect('peer');finish();await assert.rejects(request,/계정 연결/);
});
