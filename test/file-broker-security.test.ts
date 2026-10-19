import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LocalFileBroker,fileDigest} from '../daemon/file-broker.ts';
import {safeMutateText} from '../daemon/safe-local-files.ts';
import {FileApprovals} from '../daemon/file-approval.ts';
import type {FileProposal} from '../daemon/file-approval.ts';
test('mutation requires snapshot, unchanged bytes, same root identity, one-use owner approval and backup',async()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mutate-safe-')));
 try {
  const root=path.join(home,'project'),backups=path.join(home,'backups');fs.mkdirSync(root);fs.mkdirSync(backups);fs.writeFileSync(path.join(root,'a'),'before');
  const broker=new LocalFileBroker(backups);
  const p:FileProposal={id:'p',owner:'a',requester:'b',threadId:'t',audience:['a','b'],rootId:'root-one',path:'a',operation:'read',expiresAt:Date.now()+60000};
  const call=(q:FileProposal)=>broker.execute(broker.approve(q,'a'),q,q.audience,root);
  await call(p);
  const write={...p,operation:'write' as const,beforeHash:fileDigest('before'),content:'after'};
  const nonce=broker.approve(write,'a');fs.writeFileSync(path.join(root,'a'),'changed');
  await assert.rejects(broker.execute(nonce,write,p.audience,root));
  fs.writeFileSync(path.join(root,'a'),'before');await assert.rejects(broker.execute(nonce,write,p.audience,root));
  const rootNonce=broker.approve(write,'a');await assert.rejects(broker.execute(rootNonce,{...write,rootId:'root-two'},p.audience,root));
  await call(write);assert.equal(fs.readFileSync(path.join(root,'a'),'utf8'),'after');
  assert.equal(fs.readFileSync(path.join(backups,fs.readdirSync(backups)[0]),'utf8'),'before');
  await assert.rejects(call({...write,content:'password="fake-secret"'}));
  const approval=new FileApprovals();const readNonce=approval.approve(p,'a');assert.throws(()=>approval.consume(readNonce,write,p.audience));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('native mutation compares original bytes again and never follows a replacement link',()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mutate-safe-')));
 try {
  const root=path.join(home,'project'),outside=path.join(home,'outside'),backups=path.join(home,'backups');fs.mkdirSync(root);fs.mkdirSync(backups);fs.writeFileSync(outside,'outside');fs.writeFileSync(path.join(root,'a'),'changed');
  assert.throws(()=>safeMutateText(root,'a','write','before','after',path.join(backups,'original.bak')));
  assert.equal(fs.readFileSync(path.join(root,'a'),'utf8'),'changed');
  fs.unlinkSync(path.join(root,'a'));fs.linkSync(outside,path.join(root,'a'));
  assert.throws(()=>safeMutateText(root,'a','delete','outside','',path.join(backups,'linked.bak')));
  assert.equal(fs.readFileSync(outside,'utf8'),'outside');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('normal configuration reads and owner-approved changes do not trigger secret blocking',async()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'normal-config-')));
 try {
  const root=path.join(home,'project');fs.mkdirSync(root);
  const original='const config = { tokenBudget: 4096, passwordMinLength: 8, apiKeyRequired: true, apiKey: process.env.API_KEY };';
  fs.writeFileSync(path.join(root,'config.ts'),original);const broker=new LocalFileBroker(path.join(home,'backups'));
  const p:FileProposal={id:'normal',owner:'a',requester:'b',threadId:'t',audience:['a','b'],operation:'read',path:'config.ts',expiresAt:Date.now()+60000};
  const call=(q:FileProposal)=>broker.execute(broker.approve(q,'a'),q,q.audience,root);
  assert.equal(await call(p),original);
  const content=original.replace('4096','8192');await call({...p,operation:'write',beforeHash:fileDigest(original),content});
  assert.equal(fs.readFileSync(path.join(root,'config.ts'),'utf8'),content);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
