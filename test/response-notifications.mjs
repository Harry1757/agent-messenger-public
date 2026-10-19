import {_electron as electron} from 'playwright';import assert from 'node:assert/strict';
import {openDb,upsertUser,createThread} from '../server/db.ts';import {buildApp} from '../server/routes.ts';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const db=openDb(':memory:');upsertUser(db,'알림검증','qa-notify');const thread=createThread(db,'알림 검사','알림검증');
const server=buildApp(db).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
const dir=mkdtempSync(join(tmpdir(),'response-notice-'));writeFileSync(join(dir,'config.json'),JSON.stringify({serverUrl:base,token:'qa-notify',agentName:'알림검증',tool:'codex',command:'codex',workspace:dir}));let app;
try{
 app=await electron.launch({args:['.','--user-data-dir='+join(dir,'profile')],env:{...process.env,AGENT_MESSENGER_HOME:dir},timeout:30000});
 const page=await app.firstWindow();await page.locator('#accountName').filter({hasText:'알림검증'}).waitFor();
 await app.evaluate(({Notification,BrowserWindow})=>{globalThis.qaShown=[];Notification.prototype.show=function(){qaShown.push(this)};Notification.prototype.close=function(){this.qaClosed=true};const w=BrowserWindow.getAllWindows()[0];w.isFocused=()=>true;globalThis.qaDaemon=process._getActiveHandles().find(h=>h.spawnargs?.some(a=>a.endsWith('daemon.mjs')));if(!qaDaemon)throw Error('daemon missing')});
 const url=base+'/#thread='+thread.id;
 await app.evaluate((_,url)=>qaDaemon.emit('message',{type:'notify',title:'자료 공유 확인이 필요합니다',body:'fixture',url,requiresResponse:true}),url);
 await page.waitForTimeout(100);assert.equal(await app.evaluate(()=>qaShown.length),1,'focused resource approval must notify');
 await app.evaluate((_,url)=>qaDaemon.emit('message',{type:'notify',title:'일반 결과',body:'fixture',url}),url);await page.waitForTimeout(50);assert.equal(await app.evaluate(()=>qaShown.length),1,'ordinary foreground notification stays quiet');
 await app.evaluate(({BrowserWindow},url)=>{BrowserWindow.getAllWindows()[0].emit('focus');qaDaemon.emit('message',{type:'notify',title:'새 승인',body:'fixture',url,requiresResponse:true})},url);await page.waitForTimeout(450);assert.equal(await app.evaluate(()=>qaShown.at(-1).qaClosed===true),false,'focus cleanup must not erase newly arrived approval');
 const message={id:901,threadId:thread.id,author:'알림검증',authorType:'agent',kind:'decision_request',privateTo:'알림검증',body:JSON.stringify({question:'의견이 필요합니다',options:['예','아니요']})};
 await app.evaluate((_,message)=>qaDaemon.emit('message',{type:'decision',message}),message);await page.waitForTimeout(100);assert.equal(await app.evaluate(()=>qaShown.at(-1).title),'내 결정이 필요해요');
 await app.evaluate((_,threadId)=>qaDaemon.emit('message',{type:'thread-dismissed',threadId}),thread.id);await page.waitForTimeout(100);const before=await app.evaluate(()=>qaShown.length);
 await app.evaluate((_,url)=>qaDaemon.emit('message',{type:'notify',title:'삭제한 방',body:'fixture',url,requiresResponse:true}),url);await page.waitForTimeout(100);assert.equal(await app.evaluate(()=>qaShown.length),before,'deleted room must stay silent');
 console.log('PASS focused resource/decision notices, foreground ordinary suppression, focus cleanup race, deleted room suppression');
}finally{if(app)await app.close();server.closeAllConnections();server.close();db.close();rmSync(dir,{recursive:true,force:true});}
