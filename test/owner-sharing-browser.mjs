import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openDb,upsertUser,createThread} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
const db=openDb(':memory:');upsertUser(db,'소유자','test-token');upsertUser(db,'동료','reader-token');
const thread=createThread(db,'자료 공유 확인','소유자');
const server=buildApp(db).listen(0);await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  localStorage.setItem('token','test-token');window.sharingCalls=[];let policies=[];
  window.desktopMessenger={sharingList:async()=>({policies}),sharingAdd:async(input)=>{window.sharingCalls.push(input);policies.push({id:'p1',label:'내 프로젝트',kind:input.kind,audience:input.audience,threadId:input.threadId,excluded:[]});return {policies};},sharingExclude:async(input)=>{policies[0].excluded=input.excluded;return {policies};},sharingRevoke:async()=>{policies=[];return {policies};}};
 });
 await page.goto(`${base}/#thread=${thread.id}`);
 await page.locator('#threadTitle').filter({hasText:'자료 공유 확인'}).waitFor();
 await page.locator('#accountSettings > summary').click();await page.locator('#sharingSettings > summary').click();
 await page.locator('#sharingAudience input').first().waitFor();
 assert.equal(await page.locator('#sharingAudience input:checked').count(),0);
 await page.locator('#sharingConfirm').check();await page.getByRole('button',{name:'폴더 선택',exact:true}).click();
 await page.locator('#sharingStatus').filter({hasText:'한 명 이상'}).waitFor();assert.equal(await page.evaluate(()=>window.sharingCalls.length),0);
 await page.locator('#sharingAudience input[value="동료"]').check();
 await page.getByRole('button',{name:'폴더 선택',exact:true}).click();
 await page.locator('.sharing-policy').waitFor();
 assert.deepEqual(await page.evaluate(()=>window.sharingCalls),[{kind:'directory',audience:['동료'],threadId:thread.id}]);
 assert.equal(await page.locator('#sharingConfirm').isChecked(),false);
 await page.locator('.sharing-policy summary').click();await page.locator('.sharing-policy textarea').fill('secrets\n.env');await page.getByRole('button',{name:'제외 목록 저장'}).click();
 await page.locator('.sharing-policy summary').filter({hasText:'2개'}).waitFor();
 const bounds=await page.locator('.settings-popover').evaluate(element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:element.scrollWidth,client:element.clientWidth};});
 assert.ok(bounds.left>=0&&bounds.right<=1200&&bounds.top>=0&&bounds.bottom<=900);assert.ok(bounds.width<=bounds.client+1);
 await page.screenshot({path:'/tmp/owner-sharing-ui.png'});
 await page.getByRole('button',{name:'공유 철회',exact:true}).click();await page.locator('#sharingPolicies').filter({hasText:'허용한 파일·폴더가 없습니다.'}).waitFor();
 await page.setViewportSize({width:600,height:800});
 const small=await page.locator('.settings-popover').boundingBox();assert.ok(small.x>=0&&small.x+small.width<=600);
 assert.deepEqual(errors,[]);console.log('PASS explicit audience, required confirmation, current-room scope, exclusions, revoke, responsive panel, no browser errors');
}finally{await browser.close();server.closeAllConnections();server.close();db.close();}
