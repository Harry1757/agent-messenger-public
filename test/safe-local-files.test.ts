import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {safeReadText,safeList,validateRoot} from '../daemon/safe-local-files.ts';
function fixture(){const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shared-safe-')));return {home,cleanup:()=>fs.rmSync(home,{recursive:true,force:true})};}
test('non-git selected folder: bounded read, latest content, secret checks and no path leaks',()=>{
 const f=fixture();try {
  fs.writeFileSync(path.join(f.home,'a.txt'),'first');
  const root=validateRoot(f.home,'directory');const first=safeReadText(root,'a.txt');assert.equal(first.text,'first');
  fs.writeFileSync(path.join(f.home,'a.txt'),'second');assert.notEqual(safeReadText(root,'a.txt').hash,first.hash);
  fs.writeFileSync(path.join(f.home,'secret.txt'),'const token="ghp_'+'x'.repeat(32)+'";');
  const checked=safeReadText(root,'secret.txt');assert.equal(checked.sensitive,true);assert.equal(checked.text.includes('ghp_'),false);
  fs.writeFileSync(path.join(f.home,'.env'),'hidden');assert.throws(()=>safeReadText(root,'.env'));
  fs.writeFileSync(path.join(f.home,'binary'),Buffer.from([0,1,2]));assert.throws(()=>safeReadText(root,'binary'));
  assert.throws(()=>safeReadText(root,'a.txt',{maxBytes:2}));
  try{safeReadText(root,'missing');assert.fail();}catch(e){assert.equal(String(e).includes(root),false);}
 }finally{f.cleanup();}
});
test('traversal, links, sibling prefixes and file roots do not broaden access',()=>{
 const f=fixture();try {
  const root=path.join(f.home,'project');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'ok'),'ok');
  fs.writeFileSync(path.join(f.home,'outside'),'outside');
  fs.linkSync(path.join(f.home,'outside'),path.join(root,'hard'));assert.throws(()=>safeReadText(root,'hard'));
  fs.symlinkSync(f.home,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');assert.throws(()=>safeReadText(root,'linked/outside'));
  for(const name of ['../outside','/outside','C:\\outside','//server/a','ok:stream'])assert.throws(()=>safeReadText(root,name));
  const file=validateRoot(path.join(root,'ok'),'file');assert.equal(safeReadText(file,'').text,'ok');assert.throws(()=>safeReadText(file,'other'));
  assert.throws(()=>validateRoot(os.homedir(),'directory'));assert.throws(()=>validateRoot(path.parse(f.home).root,'directory'));
 }finally{f.cleanup();}
});
test('listing filters exclusions and secret names, follows no links and is bounded',()=>{
 const f=fixture();try {
  fs.mkdirSync(path.join(f.home,'sub'));fs.writeFileSync(path.join(f.home,'sub','a'),'a');fs.writeFileSync(path.join(f.home,'.env'),'secret');
  fs.mkdirSync(path.join(f.home,'private'));fs.writeFileSync(path.join(f.home,'private','hidden'),'hidden');
  const list=safeList(f.home,'',{excluded:['private']});assert.deepEqual(list.paths,['sub/','sub/a']);
  assert.equal(safeList(f.home,'',{maxEntries:1}).truncated,true);
  assert.deepEqual(safeList(f.home,'private',{excluded:['private']}).paths,[]);
 }finally{f.cleanup();}
});
test('native descriptor traversal never reads outside during concurrent ancestor symlink swaps',{skip:process.platform==='win32'},async()=>{
 const {Worker}=await import('node:worker_threads');
 const f=fixture();let worker:InstanceType<typeof Worker>|undefined;
 try {
  const root=path.join(f.home,'project'),outside=path.join(f.home,'outside');fs.mkdirSync(root);fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root,'sub'));fs.writeFileSync(path.join(root,'sub','value'),'SAFE');fs.writeFileSync(path.join(outside,'value'),'OUTSIDE-MUST-NEVER-BE-READ');
  worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const path=require('node:path');const [root,outside]=workerData;const sub=path.join(root,'sub'),park=path.join(root,'park');parentPort.postMessage('ready');for(;;){try{fs.renameSync(sub,park);fs.symlinkSync(outside,sub,'dir');fs.unlinkSync(sub);fs.renameSync(park,sub);}catch{}}`,{eval:true,workerData:[root,outside]});
  await new Promise<void>((resolve,reject)=>{worker!.once('message',()=>resolve());worker!.once('error',reject);});
  for(let i=0;i<80;i++) {let result;try{result=safeReadText(root,'sub/value');}catch{continue;}assert.equal(result.text,'SAFE');}
 }finally{if(worker)await worker.terminate();f.cleanup();}
});
test('Windows real junction, alternate stream, UNC/device paths, hardlinks and case aliases',{skip:process.platform!=='win32'},async()=>{
 const {execFileSync}=await import('node:child_process');
 const f=fixture();try {
  const root=path.join(f.home,'project'),outside=path.join(f.home,'outside'),junction=path.join(root,'junction');
  fs.mkdirSync(root);fs.mkdirSync(outside);fs.writeFileSync(path.join(root,'normal.txt'),'normal');fs.writeFileSync(path.join(outside,'value'),'OUTSIDE');
  fs.symlinkSync(outside,junction,'junction');
  const kind=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$q=[Console]::In.ReadToEnd() | ConvertFrom-Json; [Console]::Out.Write((Get-Item -LiteralPath $q.path -Force).LinkType)"],{input:JSON.stringify({path:junction}),encoding:'utf8',windowsHide:true});
  assert.equal(kind.trim(),'Junction');
  assert.throws(()=>safeReadText(root,'junction/value'));
  assert.equal(safeList(root).paths.includes('junction/'),false);
  assert.throws(()=>validateRoot(junction,'directory'));
  assert.equal(safeReadText(validateRoot(root.toUpperCase(),'directory'),'NORMAL.TXT').text,'normal');
  for(const p of ['normal.txt:secret','normal.txt::$DATA','C:/outside','../outside/value','\\\\localhost\\c$\\outside','\\\\?\\C:\\outside']) assert.throws(()=>safeReadText(root,p));
  for(const p of ['\\\\localhost\\c$\\outside','\\\\?\\C:\\outside','\\\\.\\C:'])assert.throws(()=>validateRoot(p,'directory'));
  fs.linkSync(path.join(outside,'value'),path.join(root,'hard.txt'));assert.throws(()=>safeReadText(root,'hard.txt'));
 }finally{f.cleanup();}
});
test('generated folders cannot consume the source listing budget but remain explicitly readable',()=>{const f=fixture();try{for(const dir of ['.git','node_modules','src'])fs.mkdirSync(path.join(f.home,dir));for(let i=0;i<30;i++)fs.writeFileSync(path.join(f.home,'.git',String(i)),'metadata');fs.writeFileSync(path.join(f.home,'src','api.ts'),'actual source');fs.writeFileSync(path.join(f.home,'node_modules','dependency.js'),'library');const listing=safeList(f.home,'',{maxEntries:10});assert(listing.paths.includes('src/api.ts'));assert(!listing.paths.some(p=>p.startsWith('.git/')&&p!=='.git/'));assert(listing.truncated);assert(safeList(f.home,'.git',{maxEntries:10}).paths.some(p=>p.startsWith('.git/')));}finally{f.cleanup();}});
