import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {openDb,upsertUser,createThread,addThreadMember,addMessage} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
import {ResourceStore} from '../server/resource-store.ts';
const out=process.env.UI_TEST_OUTPUT||'.superpowers/sdd/2026-09-15-responsive/browser';mkdirSync(out,{recursive:true});
const db=openDb(':memory:');for(const [name,token]of[['예제사용자','qa-owner'],['예제동료','qa-peer'],['서연','qa-other']])upsertUser(db,name,token);
const thread=createThread(db,'긴 대화 제목 · 디자인 킷과 API 변경 사항을 함께 확인하기','예제사용자');addThreadMember(db,thread.id,'예제동료');
for(let i=0;i<15;i++)createThread(db,`대화 ${i} · 디자인과 개발 진행 확인`,'예제사용자');
const source=addMessage(db,{threadId:thread.id,author:'예제동료',authorType:'human',kind:'text',body:'@예제사용자 디자인 킷의 Drawer 지원 여부를 확인해 주세요.'});
addMessage(db,{threadId:thread.id,author:'예제사용자',authorType:'agent',kind:'text',body:'긴 메시지를 확인합니다.\n\n'+('창이 작아져도 대화가 잘 보여야 합니다.\n').repeat(12)+'\n```ts\nconst path = "'+('long-path/'.repeat(30))+'";\n```'});
addMessage(db,{threadId:thread.id,author:'예제사용자',authorType:'agent',kind:'decision_request',body:JSON.stringify({question:'변경 사항을 확인하고 다음 작업을 선택해 주세요.',options:['확인한 내용을 기준으로 다음 작업을 진행하고 결과를 이 대화의 참여자들에게 공유해 주세요','추가 설명을 확인할게요']})});
const resources=new ResourceStore(db);for(let i=0;i<10;i++){const r=resources.request('예제사용자',thread.id,{messageId:source.id,owner:'예제사용자',deviceId:'preview-device',source:'local',action:'read',rootId:'project',path:`notes-${i}.md`});if(i<8){const status=['completed','failed','denied','cancelled'][i%4];db.prepare('UPDATE resource_requests SET data=? WHERE id=?').run(JSON.stringify({...r,status}),r.id);}}
addMessage(db,{threadId:thread.id,author:'예제사용자',authorType:'agent',kind:'summary',body:('확인한 내용을 정리했습니다. 중요한 결정과 다음 작업을 확인해 주세요.\n').repeat(20)});
const srv=buildApp(db).listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${srv.address().port}`;
await fetch(base+'/api/agent/status',{method:'POST',headers:{Authorization:'Bearer qa-owner','Content-Type':'application/json'},body:JSON.stringify({online:true,availableTools:['codex'],tool:'codex',model:'gpt-5.6-sol',busyThreadId:null,toolOk:true})});
const browser=await chromium.launch({channel:'chrome',headless:true});const results=[];
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('token','qa-owner'));
 await page.goto(base+'/#thread='+thread.id);await page.locator('#composer').waitFor();await page.locator('.decision .options button').first().waitFor();
 const fit=async(label)=>{const m=await page.evaluate(()=>{const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};return{viewport:[innerWidth,innerHeight],page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],scroll:box('scroll'),composer:box('composer'),send:box('send'),threads:box('threads')}});assert(m.page[0]<=m.viewport[0]+1,label+' horizontal overflow');assert(m.page[1]<=m.viewport[1]+1,label+' page overflow');assert(m.scroll.h>=100,label+' conversation lost: '+m.scroll.h);assert(m.send.bottom<=m.viewport[1]+1,label+' send button cut');assert(m.composer.right<=m.viewport[0]+1,label+' composer overflow');results.push({label,...m});};
 for(const [width,height]of[[360,448],[480,448],[360,640],[480,600],[768,600],[1000,580],[1280,800],[1440,900],[800,400]]){
  await page.setViewportSize({width,height});await fit(`${width}x${height}`);
  assert.equal(await page.locator('#threadHeader #summaryToggle').count(),1);
  const beforeSummary=await page.locator('#scroll').evaluate(e=>e.scrollTop);await page.locator('#summaryToggle').click();await fit(`header summary ${width}x${height}`);
  await page.screenshot({animations:'disabled',path:`${out}/summary-open-${width}x${height}.png`});
  await page.locator('#scroll').evaluate(e=>e.scrollTop=e.scrollHeight);
  const toggleBox=await page.locator('#summaryToggle').boundingBox();assert(toggleBox.y>=0&&toggleBox.y+toggleBox.height<=height);
  await page.screenshot({animations:'disabled',path:`${out}/summary-header-${width}x${height}.png`});
  await page.locator('#summaryToggle').click();assert.equal(await page.locator('#sharedSummary').isVisible(),false);assert(Math.abs((await page.locator('#scroll').evaluate(e=>e.scrollTop))-beforeSummary)<2,'restore conversation scroll');
  await page.screenshot({animations:'disabled',path:`${out}/${width}x${height}.png`});
  await page.locator('[data-route-mode="agents"]').click();
  await page.getByRole('checkbox',{name:'예제동료',exact:true}).check();await page.getByRole('checkbox',{name:'예제사용자',exact:true}).check();
  await page.getByRole('checkbox',{name:'예제동료',exact:true}).press('Tab');
  const chips=await page.locator('#routePeople').evaluate(e=>({overflow:e.scrollWidth>e.clientWidth,items:[...e.querySelectorAll('label')].map(l=>{const i=l.querySelector('input'),r=l.getBoundingClientRect(),b=i.getBoundingClientRect();return{checked:i.checked,w:b.width,h:b.height,padding:b.x-r.x,gap:parseFloat(getComputedStyle(l).gap),focus:i.matches(':focus-visible'),outline:getComputedStyle(l).outlineStyle,offset:getComputedStyle(l).outlineOffset,inputOutline:getComputedStyle(i).outlineStyle};})}));
  assert(!chips.overflow,'agent choices overflow');assert.equal(chips.items.filter(i=>i.checked).length,2);assert(chips.items.every(i=>i.w===16&&i.h===16&&i.padding>=12&&i.gap>=8),'cramped checkbox');assert(chips.items.some(i=>i.focus&&i.outline==='solid'&&i.offset==='-3px'&&i.inputOutline==='none'),'single keyboard focus ring');
  await fit(`selected agents ${width}x${height}`);await page.locator('#summaryToggle').click();await fit(`summary with selected agents ${width}x${height}`);await page.locator('#summaryToggle').click();await page.locator('#composer').screenshot({animations:'disabled',path:`${out}/agents-${width}x${height}.png`});
  await page.getByRole('checkbox',{name:'예제사용자',exact:true}).press('Space');assert.equal(await page.getByRole('checkbox',{name:'예제사용자',exact:true}).isChecked(),false);await page.getByRole('checkbox',{name:'예제사용자',exact:true}).press('Space');
  await page.locator('[data-route-mode="auto"]').click();
  if(width<=900){await page.locator('#sidebarToggle').click();assert.equal(await page.locator('#main').evaluate(e=>e.inert),true);await page.locator('#sidebarClose').waitFor({state:'visible'});await page.locator('#sidebarClose').focus();await page.locator('#sidebarClose').press('Shift+Tab');assert.equal(await page.locator('#sidebar').evaluate(e=>e.contains(document.activeElement)),true);}
  await page.locator('#accountSettings>summary').click();await page.locator('#settingsDialog').waitFor();
  const box=await page.locator('#settingsDialog').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,'settings off screen');
  await page.locator('#toolSelectButton').click();await page.locator('#toolSelectOptions').waitFor();const field=await page.locator('#toolSelectButton').boundingBox(),menu=await page.locator('#toolSelectOptions').boundingBox();assert(menu.y>=field.y+field.height,'select covers field');assert(menu.y+menu.height<=height+1,'select outside viewport');
  await page.locator('#toolSelectOptions button').first().press('Escape');assert.equal(await page.locator('#settingsDialog').evaluate(e=>e.open),true,'first Escape only closes select');
  await page.locator('.settings-body').evaluate(e=>e.scrollTop=e.scrollHeight);assert(await page.locator('#closeSettings').isVisible());const closeBox=await page.locator('#closeSettings').boundingBox();assert(closeBox.y>=0&&closeBox.y+closeBox.height<=height,'close button lost');await page.locator('#closeSettings').click();await page.locator('#settingsDialog').waitFor({state:'hidden'});
  if(width<=900){await page.locator('#sidebarClose').press('Escape');assert.equal(await page.locator('#main').evaluate(e=>e.inert),false);assert.equal(await page.locator('#sidebarToggle').getAttribute('aria-expanded'),'false');}
 }
 await page.setViewportSize({width:480,height:600});
 // Every terminal state remains identifiable without relying on color alone.
 for (const theme of ['light','dark']) {
  if((await page.locator('#themeToggle').getAttribute('aria-checked'))!==(theme==='dark'?'true':'false'))await page.locator('#themeToggle').click();
  const history=page.locator('[data-resource-group=history]');if(!(await history.evaluate(e=>e.open)))await history.locator('summary').click();
  const counts=history.locator('summary .resource-status');assert.equal(await counts.count(),4);
  for(const [status,text]of[['completed','완료'],['failed','실패'],['denied','거절'],['cancelled','취소']]){
   assert.equal(await history.locator(`summary [data-resource-status="${status}"]`).textContent(),`${text} 2건`);
   const cards=history.locator(`.resource-card[data-resource-status="${status}"]`);assert.equal(await cards.count(),2);
   assert((await cards.first().locator('.resource-status').textContent()).includes(text));
  }
  const colors=await counts.evaluateAll(es=>es.map(e=>getComputedStyle(e).color));assert.equal(new Set(colors).size,4,'terminal states need distinct colors');
  const contrast=await history.locator('.resource-status').evaluateAll(es=>es.map(e=>{
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d'),ancestors=[];
   for(let parent=e;parent;parent=parent.parentElement)ancestors.unshift(parent);
   ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);for(const parent of ancestors){ctx.fillStyle=getComputedStyle(parent).backgroundColor;ctx.fillRect(0,0,1,1);}
   const luminance=rgb=>[...rgb].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
   const bg=luminance(ctx.getImageData(0,0,1,1).data);ctx.fillStyle=getComputedStyle(e).color;ctx.fillRect(0,0,1,1);const fg=luminance(ctx.getImageData(0,0,1,1).data);
   return{label:e.textContent,ratio:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)};
  }));assert(contrast.every(x=>x.ratio>=4.5),JSON.stringify({theme,contrast}));
  await history.locator('summary').scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${out}/resource-states-${theme}.png`});
  await history.locator('.resource-card[data-resource-status="completed"]').first().scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${out}/resource-completed-${theme}.png`});
  await history.locator('summary').click();
 }
 const flow=()=>page.evaluate(()=>{const s=document.getElementById('scroll'),summary=document.getElementById('sharedSummary'),requests=document.getElementById('resourceRequests');return{summaryHeight:summary.getBoundingClientRect().height,requestsTop:requests.getBoundingClientRect().top+s.scrollTop,contextOverflow:getComputedStyle(document.getElementById('conversationContext')).overflowY};});
 await page.locator('#scroll').evaluate(e=>e.scrollTop=0);await page.screenshot({animations:'disabled',path:`${out}/aligned-headings.png`});
 const folded=await flow();await page.locator('#summaryToggle').click();const unfolded=await flow();assert(unfolded.summaryHeight>folded.summaryHeight+100);assert(Math.abs((unfolded.requestsTop-folded.requestsTop)-(unfolded.summaryHeight-folded.summaryHeight))<2,'requests must follow expanded summary');assert.equal(unfolded.contextOverflow,'visible','context must not clip expanded sections');
 await page.locator('[data-resource-group=history]>summary').click();assert.equal(await page.locator('#sharedSummary').isVisible(),true);await page.locator('#scroll').evaluate(e=>e.scrollTop=0);await page.screenshot({animations:'disabled',path:`${out}/expanded-summary.png`});await page.locator('[data-resource-group=history]>summary').scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${out}/expanded-history.png`});await page.locator('#summaryToggle').click();assert.equal(await page.locator('[data-resource-group=history]').evaluate(e=>e.open),true,'disclosures must stay independent');await fit('both disclosures independent');await page.locator('[data-resource-group=history]>summary').click();
 await page.locator('#summaryToggle').click();await fit('expanded summary and resource requests');await page.locator('#summaryToggle').click();await page.locator('[data-resource-group=history]>summary').click();await fit('expanded request history');await page.locator('[data-resource-group=history]>summary').click();await page.locator('#input').fill(('긴 입력 내용입니다.\n').repeat(35));await fit('long draft');await page.locator('#input').fill('');
 await page.locator('#privateToggle').click();await fit('private mode');await page.locator('#privateToggle').click();
 // Exercise actual send behavior against the isolated server, never a live account.
 await page.locator('[data-route-mode="direct"]').click();await page.locator('#input').fill('직접 대화 전송 확인');const posted=page.waitForResponse(r=>r.url().endsWith('/messages')&&r.request().method()==='POST');await page.locator('#send').click();assert.equal((await (await posted).json()).body,'직접 대화 전송 확인');
 const decided=page.waitForResponse(r=>r.url().endsWith('/messages')&&r.request().method()==='POST');await page.locator('.decision .options button').first().click();assert.equal((await (await decided).json()).kind,'decision_result');
 await page.locator('#scroll').evaluate(e=>e.scrollTop=0);await page.locator('#latestMessage').waitFor();await page.locator('#latestMessage').click();assert(await page.locator('#scroll').evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight<50));
 await page.locator('#themeToggle').click();await fit('switched theme');await page.screenshot({animations:'disabled',path:`${out}/theme-switched-480.png`});await page.locator('[data-route-mode=agents]').click();await page.getByRole('checkbox',{name:'예제동료',exact:true}).check();await page.getByRole('checkbox',{name:'예제사용자',exact:true}).check();await page.locator('#input').click();await page.locator('#composer').screenshot({animations:'disabled',path:`${out}/agents-theme-switched-480.png`});
 await page.locator('#sidebarToggle').click();await page.locator('#newThreadBtn').click();await page.locator('#newThreadTitle').fill('반응형 새 대화 테스트');await page.getByRole('button',{name:'만들기',exact:true}).click();await page.locator('#threadTitle').filter({hasText:'반응형 새 대화 테스트'}).waitFor();assert.equal(await page.locator('#sidebarToggle').getAttribute('aria-expanded'),'false');await fit('new conversation');assert.equal(await page.locator('#summaryToggle').isVisible(),false);assert.equal(await page.locator('#sharedSummary').isVisible(),false);
 await page.goto(base);await page.locator('.empty .btn').click();assert.equal(await page.locator('#sidebarToggle').getAttribute('aria-expanded'),'true');await page.locator('#newThreadCancel').click();await page.locator('#accountSettings>summary').click();await page.locator('#logoutBtn').click();await page.locator('#startScreen').waitFor();assert.equal(await page.locator('#settingsDialog').evaluate(e=>e.open),false);
 assert.deepEqual(errors,[]);writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));console.log('PASS: independent disclosures, selected agents and keyboard focus, 9 viewports, navigation, focus, settings, dropdown, long drafts, privacy, direct send, latest message, theme, new conversation, decision reply, logout');
}finally{await browser.close();srv.closeAllConnections();srv.close();db.close();}
