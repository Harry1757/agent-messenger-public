import {_electron as electron} from 'playwright';
import {openDb,upsertUser,createThread,addThreadMember} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const db=openDb(':memory:');upsertUser(db,'앱검증','desktop-test');const thread=createThread(db,'앱 연결 검증','앱검증');upsertUser(db,'동료','peer');addThreadMember(db,thread.id,'동료');
const server=buildApp(db).listen(43131,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const dir=mkdtempSync(join(tmpdir(),'desktop-test-'));
writeFileSync(join(dir,'config.json'),JSON.stringify({serverUrl:'http://127.0.0.1:43131',token:'desktop-test',agentName:'앱검증',tool:'codex',command:'codex',workspace:dir}));
let app;
try{
 app=await electron.launch({executablePath:join(process.cwd(),'release/mac-arm64/Agent Messenger.app/Contents/MacOS/Agent Messenger'),args:['--user-data-dir='+join(dir,'profile')],env:{...process.env,AGENT_MESSENGER_HOME:dir},timeout:30000});
 const page=await app.firstWindow();await page.locator('#accountName').filter({hasText:'앱검증'}).waitFor({timeout:30000});
 console.log('APP_LOGIN_OK');
 await app.evaluate(({Notification})=>{const show=Notification.prototype.show;Notification.prototype.show=function(){globalThis.__lastNotice=this;this.on('failed',(_e,error)=>{globalThis.__noticeFailure=error;});return show.call(this);};});

 for(let i=0;i<90;i++){
  const states=await fetch('http://127.0.0.1:43131/api/agents',{headers:{Authorization:'Bearer desktop-test'}}).then(r=>r.json());
  if(states.agents.some(a=>a.user==='앱검증'&&a.online))break;
  if(i===89)throw Error('Daemon not online');await page.waitForTimeout(1000);
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
 await page.waitForTimeout(300);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 if(!await app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isVisible()))throw Error('Close did not hide');
 await fetch(`http://127.0.0.1:43131/api/threads/${thread.id}/messages`,{method:'POST',headers:{Authorization:'Bearer peer','Content-Type':'application/json'},body:JSON.stringify({author:'동료',authorType:'agent',kind:'summary',body:'동료가 검토를 마쳤어요.'})});
 for(let i=0;i<70;i++){if(await app.evaluate(()=>globalThis.__lastNotice?.title==='대화 답변이 도착했어요'))break;await page.waitForTimeout(300);}
 if(!await app.evaluate(()=>globalThis.__lastNotice?.title==='대화 답변이 도착했어요'))throw Error('Peer completion notification missing while hidden');
 await app.evaluate(()=>globalThis.__lastNotice.emit('click'));
 await page.waitForURL(`**/#thread=${thread.id}`);await page.getByRole('heading',{name:'앱 연결 검증'}).waitFor();
 if(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()))throw Error('Notification did not restore minimized window');
 console.log('BACKGROUND_DAEMON_AND_PEER_COMPLETION_CLICK_OK');
 await fetch(`http://127.0.0.1:43131/api/threads/${thread.id}/messages`,{method:'POST',headers:{Authorization:'Bearer peer','Content-Type':'application/json'},body:JSON.stringify({author:'동료',authorType:'human',kind:'text',body:'직접 확인했습니다'})});
 for(let i=0;i<30;i++){if(await app.evaluate(()=>globalThis.__lastNotice?.title==='동료님의 메시지'))break;await page.waitForTimeout(300);}
 if(!await app.evaluate(()=>globalThis.__lastNotice?.title==='동료님의 메시지'))throw Error('Direct human notification missing');
 await app.evaluate(()=>globalThis.__lastNotice.emit('click'));await page.waitForURL(`**/#thread=${thread.id}`);
 console.log('DIRECT_MESSAGE_NOTIFICATION_AND_THREAD_OK');
 const request=await fetch(`http://127.0.0.1:43131/api/threads/${thread.id}/messages`,{method:'POST',headers:{Authorization:'Bearer desktop-test','Content-Type':'application/json'},body:JSON.stringify({author:'앱검증',authorType:'agent',kind:'decision_request',body:JSON.stringify({question:'앱 배너 답변 검증',summary:'격리된 테스트입니다.',options:['선택 A','선택 B']}),privateTo:'앱검증'})}).then(r=>r.json());
 for(let i=0;i<30;i++){if(await app.evaluate(()=>globalThis.__lastNotice?.title==='내 결정이 필요해요'))break;await page.waitForTimeout(300);}
 await app.evaluate(()=>globalThis.__lastNotice.emit('click'));
 await page.waitForURL(`**/#thread=${thread.id}`);
 console.log('DECISION_CLICK_IN_APP_OK');
 await app.evaluate(()=>{if(!globalThis.__lastNotice)throw new Error('no notification');globalThis.__lastNotice.emit('reply',{reply:'직접 답변; key=value 한글'},'직접 답변; key=value 한글');});
 await page.waitForTimeout(500);
 const messages=await fetch(`http://127.0.0.1:43131/api/threads/${thread.id}/messages`,{headers:{Authorization:'Bearer desktop-test'}}).then(r=>r.json());
 const answer=messages.find(m=>m.decisionRequestId===request.id);if(!answer||answer.body!=='@앱검증 직접 답변; key=value 한글'||answer.privateTo!=='앱검증')throw new Error('reply not stored correctly');
 console.log('NATIVE_REPLY_CALLBACK_OK');console.log('NATIVE_DISPLAY_FAILURE',await app.evaluate(()=>globalThis.__noticeFailure||null));
 const isolated=await page.evaluate(()=>({node:typeof require,bridge:typeof window.desktopSetup}));console.log('ISOLATION',JSON.stringify(isolated));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 console.log('CLOSE_HIDES',await app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isVisible()));
}finally{if(app)await app.close();server.close();db.close();}
