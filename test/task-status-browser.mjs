import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openDb,upsertUser,createThread,addMessage} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
const db=openDb(':memory:');upsertUser(db,'소유자','test-token');upsertUser(db,'동료','reader-token');
const thread=createThread(db,'작업 상태 확인','소유자');
const message=addMessage(db,{threadId:thread.id,author:'소유자',authorType:'human',kind:'text',body:'@동료 확인해 주세요'});
const server=buildApp(db).listen(0);await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('token','test-token'));
 let state='waiting-owner';
 await page.route('**/api/threads/*/tasks',route=>route.fulfill({json:[{id:'task',owner:'동료',messageId:message.id,state,reason:null}],headers:{'X-User':encodeURIComponent('소유자')}}));
 for(const [next,label] of [['waiting-owner','소유자 확인 대기'],['waiting-connection','PC 연결 대기'],['waiting-agent','다른 에이전트 대기'],['completed','작업 완료'],['failed','작업 실패'],['cancelled','요청 취소됨'],['running','작업 중']]){
  state=next;if (page.url().startsWith(base)) await page.reload(); else await page.goto(`${base}/#thread=${thread.id}`);
  const row=page.locator(`#pendingText [data-task-state="${state}"]`);await row.waitFor();
  assert.match(await row.innerText(),new RegExp(label));assert.doesNotMatch(await row.innerText(),/초|지연/);
  assert.equal(await row.locator('.pulse').count(),state==='running'?1:0);
  assert.equal(await page.locator('#pendingText .pending-agent').count(),1);
 }
 assert.deepEqual(errors,[]);console.log('PASS all 7 explicit task states, one row per agent, no waiting/terminal pulse or elapsed warning');
}finally{await browser.close();server.closeAllConnections();server.close();db.close();}
