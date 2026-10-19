import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {GithubPending} from '../daemon/github-pending.ts';
test('GitHub waiting requests survive restart, keep newest and drain once',()=>{const dir=mkdtempSync(join(tmpdir(),'gh-pending-'));try{const path=join(dir,'pending.json');const q:any={id:1,threadId:'one',privateTo:null};let p=new GithubPending(path);assert(p.hold(q));assert(!p.hold(q));assert(p.hold({...q,id:2}));assert(p.hold({...q,id:3,privateTo:'owner'}));p=new GithubPending(path);assert.deepEqual(p.drain().map(m=>m.id),[2,3]);assert.equal(p.drain().length,0);assert.equal(new GithubPending(path).drain().length,0);}finally{rmSync(dir,{recursive:true,force:true});}});

test('resuming previously scheduled request re-enqueues once instead of losing it to deduplication',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gh-resume-'));try{
  const p=new GithubPending(join(dir,'pending.json'));const q:any={id:42,threadId:'same',privateTo:null};const scheduled=new Set([42]);const runs:number[]=[];
  const enqueue=(m:any)=>{if(scheduled.has(m.id))return;scheduled.add(m.id);runs.push(m.id);};
  p.hold(q);p.resume(scheduled,enqueue);p.resume(scheduled,enqueue);assert.deepEqual(runs,[42]);assert(scheduled.has(42));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
