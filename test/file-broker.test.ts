import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {LocalFileBroker,fileDigest} from '../daemon/file-broker.ts';import type {FileProposal} from '../daemon/file-approval.ts';
test('local uncommitted file read, exact approved write, backup; escape and sensitive files denied',async()=>{
 const d=await realpath(await mkdtemp(join(tmpdir(),'am-broker-')));try{await writeFile(join(d,'a.txt'),'local uncommitted');await writeFile(join(d,'.env'),'secret');let linked=false;try{await symlink('a.txt',join(d,'link.txt'));linked=true;}catch(e){if(process.platform!=='win32'||(e as NodeJS.ErrnoException).code!=='EPERM')throw e;}
 const b=new LocalFileBroker(join(d,'backups'));const p:FileProposal={id:'x',owner:'me',requester:'peer',threadId:'t',audience:['me','peer'],operation:'read',path:'a.txt',expiresAt:Date.now()+60000};
 const call=(q:FileProposal)=>b.execute(b.approve(q,'me'),q,q.audience,d);
 assert.equal(await call(p),'local uncommitted');
 for(const path of ['../outside','.env',...(linked?['link.txt']:[])])await assert.rejects(call({...p,path}));
 await assert.rejects(call({...p,operation:'write',content:'new'}));
 await call({...p,operation:'write',content:'new',beforeHash:fileDigest('local uncommitted')});assert.equal(await readFile(join(d,'a.txt'),'utf8'),'new');assert.equal((await readdir(join(d,'backups'))).length,1);
 await assert.rejects(call({...p,operation:'delete',beforeHash:fileDigest('new')}));
 await call(p);await call({...p,operation:'delete',beforeHash:fileDigest('new')});await assert.rejects(readFile(join(d,'a.txt')));assert.equal((await readdir(join(d,'backups'))).length,2);
 }finally{await rm(d,{recursive:true,force:true});}
});
