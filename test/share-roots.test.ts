import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ShareRoots} from '../daemon/share-roots.ts';
import type {SharePolicy,ResourceRequest} from '../shared/resource-access.ts';
function request(p:SharePolicy):ResourceRequest{return {id:'q',owner:'a',deviceId:p.deviceId,requester:'b',threadId:'thread',audience:['a','b'],generation:1,source:'local',rootId:p.rootId,relativePath:'notes.txt',action:'read'};}
test('persists device/root grants, inherits new files, isolates thread and revokes across restart',()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'share-roots-')));try{
  const storage=path.join(home,'settings');const root=path.join(home,'project');fs.mkdirSync(root);
  const store=new ShareRoots(storage,'a');assert.equal(store.listPolicies().length,0);
  const p=store.register(root,'directory',['a','b'],'thread');assert.equal(JSON.stringify(p).includes(root),false);
  const restored=new ShareRoots(storage,'a');assert.equal(restored.deviceId,store.deviceId);
  assert.equal(restored.resolve(request(p)).decision.kind,'allow');
  assert.notEqual(restored.resolve({...request(p),threadId:'other'}).decision.kind,'allow');
  restored.setExcluded(p.id,['private']);assert.notEqual(restored.resolve({...request(p),relativePath:'private/a'}).decision.kind,'allow');
  restored.revoke(p.id);assert.notEqual(new ShareRoots(storage,'a').resolve(request(p)).decision.kind,'allow');
  assert.throws(()=>restored.getRootPath(p.rootId));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('empty audience shares nothing; corrupted state never creates fresh authorization',()=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'share-roots-')));try{
  const storage=path.join(home,'settings');const root=path.join(home,'project');fs.mkdirSync(root);
  const store=new ShareRoots(storage,'a');const p=store.register(root,'directory',[]);
  assert.notEqual(store.resolve(request(p)).decision.kind,'allow');
  fs.writeFileSync(path.join(storage,'share-roots.json'),'{broken');assert.throws(()=>new ShareRoots(storage,'a'));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
