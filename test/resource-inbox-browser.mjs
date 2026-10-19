import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openDb,upsertUser} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
const db=openDb(':memory:');upsertUser(db,'소유자','test-token');const server=buildApp(db).listen(0);await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('token','test-token'));
 let requests=[{id:'r1',threadId:'room',owner:'소유자',requester:'동료',audience:['소유자','동료'],status:'waiting-owner',path:'src/main.ts'},{id:'r2',threadId:'room',owner:'동료',requester:'소유자',audience:['소유자','동료'],status:'waiting-owner',path:'숨긴 자료'},{id:'r3',threadId:'room',owner:'소유자',requester:'동료',audience:['소유자'],status:'completed',path:'완료 자료'}];
 await page.route('**/api/resources',route=>route.fulfill({json:requests,headers:{'X-User':encodeURIComponent('소유자')}}));
 await page.goto(`${base}/decisions.html`);const card=page.locator('[data-resource-id="r1"]');await card.waitFor();assert.equal(await page.locator('[data-resource-id]').count(),1);assert.match(await card.innerText(),/src\/main.ts/);assert.equal(await card.locator('button,form').count(),0);assert.equal(await card.getByRole('link',{name:'대화에서 확인'}).getAttribute('href'),'/#thread=room');assert.match(await page.locator('#connection').innerText(),/1건/);
 requests=[];await page.reload();await page.locator('#empty').waitFor();assert.equal(await page.locator('[data-resource-id]').count(),0);
 console.log('PASS own waiting resource only, source label, conversation link without fake approval, count, terminal removal');
}finally{await browser.close();server.closeAllConnections();server.close();db.close();}
