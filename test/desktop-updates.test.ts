import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {transformSync} from 'esbuild';
const code=transformSync(readFileSync('desktop/updates.ts','utf8'),{loader:'ts',format:'cjs'}).code;
function fixture(ready:boolean){
 let installed=0,checks=0;const labels:string[]=[];
 const updater=Object.assign(new EventEmitter(),{setFeedURL:()=>{},checkForUpdates:async()=>{checks++;return {updateInfo:{version:'0.2.0'}};},quitAndInstall:()=>installed++});
 const module={exports:{} as any};
 runInNewContext(code,{module,exports:module.exports,process:{platform:'win32',env:{}},URL,console,
  require:(name:string)=>name==='electron-updater'?{autoUpdater:updater}:{
   app:{getVersion:()=> '0.2.0',isPackaged:false},
   dialog:{showMessageBox:async()=>({response:0})},Notification:class extends EventEmitter{show(){}},shell:{}
  }});
 const controller=module.exports.startUpdates({serverUrl:'http://localhost:3000',prepare:async()=>ready,changed:(s:string)=>labels.push(s)});
 return {controller,updater,labels,get installed(){return installed;},get checks(){return checks;}};
}
test('새 버전을 자동 다운로드하되 종료 시 자동 설치하지 않는다',async()=>{
 const f=fixture(false);await f.controller.check();assert.equal(f.checks,1);
 assert.equal((f.updater as any).autoDownload,true);assert.equal((f.updater as any).autoInstallOnAppQuit,false);
});
test('작업 중에는 업데이트 설치를 막고, 작업이 없을 때만 재시작한다',async()=>{
 for(const ready of [false,true]){
  const f=fixture(ready);f.updater.emit('update-downloaded');await f.controller.check();
  assert.equal(f.installed,ready?1:0);assert.equal(f.labels.at(-1),'업데이트 후 다시 시작');
 }
});
test('다운로드 진행과 실패가 메뉴에 표시된다',()=>{
 const f=fixture(false);f.updater.emit('download-progress',{percent:42.2});assert.match(f.labels.at(-1)!,/42%/);
 f.updater.emit('error',new Error('offline'));assert.match(f.labels.at(-1)!,/다시 시도/);
});
