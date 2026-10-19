import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {FileRequests,FILE_APPROVE} from '../daemon/file-requests.ts';import type {Message} from '../shared/types.ts';
test('a file is shared only after owner approves its private fixed proposal, once',async()=>{
 const home=await mkdtemp(join(tmpdir(),'am-requests-'));try{const root=join(home,'project');await mkdir(join(root,'.git'),{recursive:true});await writeFile(join(root,'a.txt'),'UNCOMMITTED_SAMPLE');const f=new FileRequests({home});const source:Message={id:1,threadId:'t',author:'peer',authorType:'human',kind:'text',body:'read file',privateTo:null,createdAt:''};let question='';const posted:string[]=[];
 await f.propose('FILE_OPERATION'+JSON.stringify({operation:'read',project:'project',path:'a.txt'}),source,'owner',[home],['owner','peer'],async body=>{question=body;return {...source,id:2,author:'owner',authorType:'agent',kind:'decision_request',body,privateTo:'owner'};});
 assert.match(question,/공유 대상/);assert(!question.includes('UNCOMMITTED_SAMPLE'));
 const decision={...source,id:3,author:'owner',kind:'decision_result' as const,body:'@owner '+FILE_APPROVE,decisionRequestId:2,privateTo:'owner'};
 assert(await f.decision(decision,'owner',async()=>['owner','peer'],async(_t,b,p)=>{assert.equal(p,null);posted.push(b);}));assert.match(posted[0],/UNCOMMITTED_SAMPLE/);
 await f.decision(decision,'owner',async()=>['owner','peer'],async(_t,b)=>{assert.match(b,/만료/);});
 }finally{await rm(home,{recursive:true,force:true});}
});
test('changed GitHub binding invalidates approved file and shows exception explicitly',async()=>{
 const home=await mkdtemp(join(tmpdir(),'am-github-'));try{
  const root=join(home,'project');await mkdir(join(root,'.git'),{recursive:true});await writeFile(join(root,'a.txt'),'PRIVATE_SENTINEL');
  let binding='1';const f=new FileRequests({home,scopeCheck:async()=>({common:false,reason:'미연결',binding})});
  const source:Message={id:1,threadId:'t',author:'peer',authorType:'human',kind:'text',body:'read',privateTo:null,createdAt:''};
  await f.propose('FILE_OPERATION'+JSON.stringify({operation:'read',project:'project',path:'a.txt'}),source,'owner',[home],['owner','peer'],async body=>{assert.match(body,/예외 공유 승인/);return {...source,id:2,body};});
  binding='2';const output:string[]=[];
  await f.decision({...source,author:'owner',kind:'decision_result',decisionRequestId:2,privateTo:'owner',body:'@owner '+FILE_APPROVE},'owner',async()=>['owner','peer'],async(_t,b,p)=>{assert.equal(p,'owner');output.push(b);});
  assert.match(output[0],/변경/);assert(!output.join('').includes('PRIVATE_SENTINEL'));
 }finally{await rm(home,{recursive:true,force:true});}
});

test('verified common read shares uncommitted file without decision; write still asks approval',async()=>{
 const home=await mkdtemp(join(tmpdir(),'am-common-'));try{
  const root=join(home,'project');await mkdir(join(root,'.git'),{recursive:true});await writeFile(join(root,'a.txt'),'UNCOMMITTED_CONTENT');
  const f=new FileRequests({home,scopeCheck:async()=>({common:true,reason:'verified',repo:'team/project',binding:'[1,2]'}),readGrant:async()=> 'server-grant'});
  const source:any={id:1,threadId:'t',author:'peer',authorType:'human',kind:'text',body:'read',privateTo:null,createdAt:''};let decisions=0;let output='';
  const ask=async(body:string)=>{decisions++;return {...source,id:3,body};};
  await f.propose('FILE_OPERATION'+JSON.stringify({operation:'read',project:'project',path:'a.txt'}),source,'owner',[home],['owner','peer'],ask,async(body,audience,grant)=>{output=body;assert.equal(grant,'server-grant');assert.deepEqual(audience,['owner','peer']);});
  assert.equal(decisions,0);assert.match(output,/UNCOMMITTED_CONTENT/);
  const {fileDigest}=await import('../daemon/file-broker.ts');
  await f.propose('FILE_OPERATION'+JSON.stringify({operation:'write',project:'project',path:'a.txt',content:'changed',beforeHash:fileDigest('UNCOMMITTED_CONTENT')}),source,'owner',[home],['owner','peer'],ask);
  assert.equal(decisions,1);
  await f.propose('FILE_OPERATION'+JSON.stringify({operation:'delete',project:'project',path:'a.txt',beforeHash:fileDigest('UNCOMMITTED_CONTENT')}),source,'owner',[home],['owner','peer'],ask);
  assert.equal(decisions,2);const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(root,'a.txt'),'utf8'),'UNCOMMITTED_CONTENT');
 }finally{await rm(home,{recursive:true,force:true});}
});
test('unverified common grant falls back to explicit approval without reading',async()=>{
 const home=await mkdtemp(join(tmpdir(),'am-grant-'));try{await mkdir(join(home,'project','.git'),{recursive:true});const f=new FileRequests({home,scopeCheck:async()=>({common:true,reason:'cached',repo:'team/project'}),readGrant:async()=>{throw Error('permission changed');}});let asks=0;await f.propose('FILE_OPERATION'+JSON.stringify({operation:'read',project:'project',path:'missing.txt'}),{id:1,threadId:'t',author:'peer',privateTo:null} as any,'owner',[home],['owner','peer'],async body=>{asks++;assert.match(body,/승인/);return {id:2} as any;},async()=>{throw Error('must not share');});assert.equal(asks,1);}finally{await rm(home,{recursive:true,force:true});}
});

test('failed fresh common proof can still use the owner-approved exception',async()=>{
 const home=await mkdtemp(join(tmpdir(),'am-exception-'));try{
 const root=join(home,'project');await mkdir(join(root,'.git'),{recursive:true});await writeFile(join(root,'a.txt'),'EXCEPTION_CONTENT');
 const f=new FileRequests({home,scopeCheck:async()=>({common:true,reason:'cached',repo:'team/project',binding:'[1,2]'}),readGrant:async()=>{throw Error('API unavailable');}});
 const source:any={id:1,threadId:'t',author:'peer',authorType:'human',kind:'text',privateTo:null};
 await f.propose('FILE_OPERATION'+JSON.stringify({operation:'read',project:'project',path:'a.txt'}),source,'owner',[home],['owner','peer'],async body=>({...source,id:2,body}),async()=>{throw Error('must wait for approval');});
 let output='';await f.decision({...source,id:3,author:'owner',kind:'decision_result',decisionRequestId:2,privateTo:'owner',body:'@owner '+FILE_APPROVE},'owner',async()=>['owner','peer'],async(_t,b)=>{output=b;});
 assert.match(output,/EXCEPTION_CONTENT/);
 }finally{await rm(home,{recursive:true,force:true});}
});
