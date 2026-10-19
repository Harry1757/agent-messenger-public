import {app,BrowserWindow,ipcMain,dialog,Tray,Menu,Notification,nativeImage,shell} from 'electron';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {parseConfig,type DaemonConfig} from '../daemon/config.ts';
import {decisionChoices,submitDecision} from '../daemon/decision-actions.ts';
import {randomUUID} from 'node:crypto';
import {NotificationLinks,toastXml} from './notification-links.ts';
import {APP_ID,TOAST_ACTIVATOR_ID,ensureNotificationShortcut} from './windows-notification-registration.ts';
import {revealWindow} from './notification-window.ts';
import {dismissNotifications} from './notification-cleanup.ts';
import {startUpdates} from './updates.ts';
import {ShareRoots} from '../daemon/share-roots.ts';
import type {Message} from '../shared/types.ts';
const dataDir=process.env.AGENT_MESSENGER_HOME || join(homedir(),'.agent-messenger');
const configPath=join(dataDir,'config.json');
const notificationLinks=new NotificationLinks(join(dataDir,'notification-links.json'));
function rememberNotification(id:string,url:string){if(config)try{notificationLinks.save(id,config.agentName,url,config.serverUrl);}catch(e){console.error('알림 대화 연결 저장 실패',e);}}
let config:DaemonConfig|null=null;
let win:BrowserWindow|null=null;
let tray:Tray;
let child:ReturnType<typeof spawn>|null=null;
let quitting=false;
let updates:ReturnType<typeof startUpdates>|null=null;
function menu(){tray.setContextMenu(Menu.buildFromTemplate([{label:'메신저 열기',click:()=>show()},{label:'GitHub 연결',click:()=>void connectGithub()},{label:'내 결정 요청함',click:()=>show(config?.serverUrl+'/decisions.html')},{type:'separator'},{label:`버전 ${app.getVersion()}`,enabled:false},{label:updates?.label||'업데이트 확인',click:()=>void updates?.check()},{type:'separator'},{label:'완전히 종료',click:()=>app.quit()}]));}
async function connectGithub(){
 let detail='GitHub의 이슈·PR·커밋 이력을 확인할 때 본인 계정을 연결해 주세요. 일반 대화와 허용된 로컬 폴더 읽기는 GitHub 연결 없이 가능합니다.';
 if(config)try{const r=await fetch(`${config.serverUrl}/api/github/status`,{headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(5000)});const state=await r.json();if(r.ok&&state?.login)detail=`현재 연결된 GitHub 계정: ${state.login}\n다른 계정으로 바꾸려면 로그인을 실행해 주세요.`;}catch{}
 const choice=await dialog.showMessageBox({type:'info',title:'GitHub 연결',message:'본인 GitHub 계정 연결',detail:detail+'\n로그인 완료 후 5분 이내 자동 반영됩니다. 앱을 다시 시작하면 바로 확인합니다.',buttons:['로그인 창 열기','GitHub CLI 설치 페이지','닫기'],defaultId:0,cancelId:2});
 if(choice.response===1){await shell.openExternal('https://cli.github.com/');return;}
 if(choice.response!==0)return;
 const command=process.platform==='darwin'?'/usr/bin/osascript':'powershell.exe';
 const args=process.platform==='darwin'?['-e','tell application "Terminal" to do script "gh auth login --hostname github.com --web"','-e','tell application "Terminal" to activate']:['-NoProfile','-Command',"Start-Process powershell.exe -ArgumentList '-NoExit','-Command','gh auth login --hostname github.com --web'"];
 const login=spawn(command,args,{stdio:'ignore',windowsHide:true});
 login.on('error',()=>void dialog.showMessageBox({type:'info',message:'터미널에서 로그인해 주세요',detail:'gh auth login --hostname github.com --web'}));
}
async function prepareUpdate():Promise<boolean>{
 const daemon=child;if(!daemon)return true;
 return new Promise(resolve=>{
  const timer=setTimeout(()=>finish(false),5000);
  const receive=(event:any)=>{if(event.type==='update-ready')finish(event.ready===true);};
  function finish(ready:boolean){clearTimeout(timer);daemon!.off('message',receive);resolve(ready);}
  daemon.on('message',receive);daemon.send({type:'prepare-update'},error=>{if(error)finish(false);});
 });
}
const pending=new Map<number,Message>();
const notices=new Map<number,Notification>();
const ordinaryNotices=new Set<Notification>();
const hiddenNotificationThreads=new Set<string>();
let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
function scheduleNotificationCleanup(){
 clearTimeout(cleanupTimer);
 // On macOS, activating a hidden app can precede the notification click event.
 // Let the click route finish before removing its native notification object.
 cleanupTimer=setTimeout(()=>{cleanupTimer=undefined;clearVisibleNotifications();},300);
}
let clearingHistory:Promise<void>|null=null;
function clearVisibleNotifications(){
 dismissNotifications(notices,ordinaryNotices,()=>{
  if(process.platform==='darwin'){try{Notification.removeAll();}catch(error){console.error('알림 센터 정리 실패',error);}return;}
  if(process.platform!=='win32'||clearingHistory)return;
  const script="[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('"+APP_ID+"')";
  clearingHistory=new Promise<void>(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000},error=>{clearingHistory=null;if(error)console.error('알림 센터 정리 실패',error.message);resolve();}));
 });
}
let lastNotificationHandled=0;
function notificationOpened(url?:string){lastNotificationHandled=Date.now();show(url);scheduleNotificationCleanup();}

const submitting=new Set<number>();
const root=__dirname;
const setupUrl=pathToFileURL(join(root,'setup.html')).href;
if(process.platform==='win32')app.setToastActivatorCLSID(TOAST_ACTIVATOR_ID);
if(!app.requestSingleInstanceLock()){app.quit();}
else {
 app.on('second-instance',()=>show());
 app.on('before-quit',()=>{quitting=true;child?.kill();});
 app.on('window-all-closed',()=>{});
 app.on('activate',()=>show());
 app.whenReady().then(boot).catch(e=>{dialog.showErrorBox('앱 시작 실패',String(e));app.quit();});
}
function trustedSetup(event:Electron.IpcMainInvokeEvent){if(event.senderFrame?.url!==setupUrl)throw new Error('허용되지 않은 요청');}
ipcMain.handle('github:refresh',async event=>{
 if(!config || !win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || new URL(event.senderFrame.url).origin!==new URL(config.serverUrl).origin)throw Error('허용되지 않은 요청');
 const daemon=child;
 if(!daemon?.connected)throw Error('백그라운드 연결이 끊겼습니다. 앱을 다시 시작해 주세요.');
 const requestId=randomUUID();
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(new Error('GitHub 확인 시간이 초과되었습니다. 다시 시도해 주세요.')),45000);
  function receive(reply:any){if(reply?.type==='github-refreshed'&&reply.requestId===requestId)finish(null,reply.result);}
  function finish(error:Error|null,result?:unknown){clearTimeout(timer);daemon!.off('message',receive);error?reject(error):resolve(result);}
  daemon.on('message',receive);
  daemon.send({type:'github-refresh',requestId},error=>{if(error)finish(error);});
 });
});
ipcMain.handle('github:connect',async event=>{
 if(!config || !win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || new URL(event.senderFrame.url).origin!==new URL(config.serverUrl).origin)throw Error('허용되지 않은 요청');
 await connectGithub();
});
function trustedMessenger(event:Electron.IpcMainInvokeEvent){
 if(!config || !win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || new URL(event.senderFrame.url).origin!==new URL(config.serverUrl).origin)throw Error('허용되지 않은 요청');
 return config;
}
async function sharingApi(path:string,method='GET',body?:unknown){
 if(!config)throw Error('먼저 메신저에 로그인해 주세요');
 const r=await fetch(`${config.serverUrl}/api/${path}`,{method,headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
 const data=await r.json();if(!r.ok)throw Error(data.error||'공유 설정을 동기화하지 못했습니다');return data;
}
function sharingSnapshot(){const roots=new ShareRoots(dataDir,config!.agentName);return {deviceId:roots.deviceId,policies:roots.listPolicies(),workFolders:true,relatedPackages:true};}
ipcMain.handle('sharing:list',event=>{trustedMessenger(event);return sharingSnapshot();});
ipcMain.handle('sharing:add',async(event,input)=>{
 const cfg=trustedMessenger(event);
 if(input?.workFolder===true)input={...input,kind:'directory',audience:[cfg.agentName],threadId:null};
 if(!input||!['file','directory'].includes(input.kind)||!Array.isArray(input.audience)||input.audience.length>100||!input.audience.every((x:unknown)=>typeof x==='string'&&x.length>0&&x.length<128)||!(input.threadId===null||typeof input.threadId==='string'&&input.threadId.length>0))throw Error('공유 대상과 대화 범위를 선택해 주세요');
 const audience=[...new Set([cfg.agentName,...input.audience])] as string[];
 const chosen=await dialog.showOpenDialog(win!,{title:input.kind==='file'?'읽기를 허용할 파일 선택':'하위 파일 읽기를 허용할 폴더 선택',properties:[input.kind==='file'?'openFile':'openDirectory']});
 if(chosen.canceled||!chosen.filePaths[0])return sharingSnapshot();
 const confirmation=await dialog.showMessageBox(win!,{type:'question',message:input.workFolder?'이 폴더를 사내 대화용 업무 폴더로 지정할까요?':'선택한 자료의 읽기·내용 공유를 허용하시겠어요?',detail:input.workFolder?'이 폴더와 하위 파일을 사내 대화에서 추가 승인 없이 읽고 요약합니다. 비밀 값은 가리며 수정·삭제는 실행하지 않습니다. 폴더 밖 일반 자료는 읽지 않으며, package.json에 직접 연결된 관련 패키지 코드는 이 대화에서 읽을 수 있습니다.':`공유 상대: ${audience.join(', ')}\n범위: ${input.threadId?'현재 대화':'선택한 상대와의 모든 대화'}\n${input.kind==='directory'?'이 폴더의 현재·새 하위 파일을 포함합니다.':'선택한 파일만 포함합니다.'} 폴더는 직접 의존하는 관련 패키지 코드도 이 대화에서 읽을 수 있습니다. 민감한 값은 가리며 수정·삭제는 포함하지 않습니다.`,buttons:['허용','취소'],defaultId:1,cancelId:1});
 if(confirmation.response!==0)return sharingSnapshot();
 const roots=new ShareRoots(dataDir,cfg.agentName);const policy=input.workFolder?roots.registerWorkFolder(chosen.filePaths[0]):roots.register(chosen.filePaths[0],input.kind,audience,input.threadId);
 try{await sharingApi(`sharing/policies/${policy.id}`,'PUT',policy);}catch(e){roots.revoke(policy.id);throw e;}
 child?.send({type:'sharing-changed'});return sharingSnapshot();
});
ipcMain.handle('sharing:revoke',async(event,input)=>{
 const cfg=trustedMessenger(event);if(typeof input?.id!=='string')throw Error('공유 허용을 선택해 주세요');
 const roots=new ShareRoots(dataDir,cfg.agentName);roots.revoke(input.id);
 await sharingApi(`sharing/policies/${encodeURIComponent(input.id)}`,'DELETE');child?.send({type:'sharing-changed'});return sharingSnapshot();
});
ipcMain.handle('sharing:exclude',async(event,input)=>{
 const cfg=trustedMessenger(event);if(typeof input?.id!=='string'||!Array.isArray(input.excluded))throw Error('제외할 상대 경로를 입력해 주세요');
 const roots=new ShareRoots(dataDir,cfg.agentName);const existing=roots.listPolicies().find(p=>p.id===input.id);
 if(existing?.excluded.some(p=>!input.excluded.includes(p))){const confirmation=await dialog.showMessageBox(win!,{type:'question',message:'제외했던 자료의 읽기를 다시 허용하시겠어요?',detail:'해제한 경로와 하위 파일이 기존 공유 대상에게 읽기 허용됩니다.',buttons:['읽기 허용','취소'],defaultId:1,cancelId:1});if(confirmation.response!==0)return sharingSnapshot();}
 const policy=roots.setExcluded(input.id,input.excluded);
 await sharingApi(`sharing/policies/${encodeURIComponent(input.id)}`,'PUT',policy);child?.send({type:'sharing-changed'});return sharingSnapshot();
});
ipcMain.handle('setup:folder',async event=>{trustedSetup(event);const result=await dialog.showOpenDialog({properties:['openDirectory']});return result.canceled?null:result.filePaths[0];});
ipcMain.handle('setup:save',async(event,data)=>{
 trustedSetup(event);
 try{
  const url=new URL(String(data.serverUrl));if(!['http:','https:'].includes(url.protocol))throw new Error('서버 주소를 확인하세요');
  if(!['codex','claude'].includes(data.tool)||typeof data.workspace!=='string'||!existsSync(data.workspace))throw new Error('에이전트와 작업 폴더를 선택하세요');
  const response=await fetch(new URL('/api/login',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:data.name,password:data.password}),signal:AbortSignal.timeout(15000)});
  const user=await response.json();if(!response.ok)throw new Error(user.error||'로그인 실패');
  config=parseConfig({serverUrl:url.origin,agentName:data.name,token:user.token,tool:data.tool,command:data.tool,workspace:data.workspace});
  mkdirSync(dataDir,{recursive:true});if(existsSync(configPath))copyFileSync(configPath,configPath+`.backup-${Date.now()}`);
  writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});
  win?.destroy();win=null;show();startDaemon();return {ok:true};
 }catch(e){return {ok:false,error:(e as Error).message};}
});
function createWindow(local=false){
 const w=new BrowserWindow({width:local?580:1280,height:local?820:880,minWidth:360,minHeight:480,title:'에이전트 메신저',icon:join(root,'icon.png'),webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:join(root,local?'preload.cjs':'messenger-preload.cjs')}});
 w.on('focus',scheduleNotificationCleanup);
 w.on('close',e=>{if(!quitting){e.preventDefault();w.hide();}});
 let retry:ReturnType<typeof setTimeout>|undefined;
 let normalBounds:Electron.Rectangle|null=null;
 w.on('closed',()=>clearTimeout(retry));
 w.webContents.on('did-fail-load',(_event,code,_description,url,isMainFrame)=>{
  if(local||!isMainFrame||code===-3||!config)return;
  try{if(new URL(url).origin!==new URL(config.serverUrl).origin)return;}catch{return;}
  clearTimeout(retry);w.setTitle('에이전트 메신저 · 서버에 다시 연결하는 중');
  retry=setTimeout(()=>{if(!w.isDestroyed())void w.loadURL(url).catch(()=>{});},3000);
 });
 w.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)clearTimeout(retry);});
 w.webContents.on('did-finish-load',()=>{if(!w.webContents.getURL().startsWith('chrome-error:'))w.setTitle('에이전트 메신저');});

 w.webContents.setWindowOpenHandler(({url,frameName})=>{
  if(config && new URL(url).origin===new URL(config.serverUrl).origin){
   if(frameName==='decision-inbox-compact' && new URL(url).pathname==='/decisions.html'){
    if(normalBounds){w.setBounds(normalBounds);normalBounds=null;}
    else{normalBounds=w.getBounds();if(w.isMaximized())w.unmaximize();w.setSize(560,760);}
    void w.webContents.executeJavaScript(`document.getElementById('compact').textContent=${JSON.stringify(normalBounds?'기본 크기로':'작은 창으로')}`).catch(()=>{});
   }else show(url);
  }else if(/^https?:/.test(url))void shell.openExternal(url);
  return {action:'deny'};
 });
 w.webContents.on('did-navigate',(_event,url)=>{
  if(normalBounds && new URL(url).pathname!=='/decisions.html'){w.setBounds(normalBounds);normalBounds=null;}
 });
 w.webContents.on('will-navigate',(event,url)=>{if(local?url!==setupUrl:!config||new URL(url).origin!==new URL(config.serverUrl).origin)event.preventDefault();});
 w.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 return w;
}
function show(url?:string){
 if(!config){if(!win){win=createWindow(true);void win.loadFile(join(root,'setup.html'));}revealWindow(win);return;}
 if(win?.isDestroyed())win=null;
 if(!win){
  win=createWindow();
  win.webContents.on('did-finish-load',async()=>{
   if(!win||!config||new URL(win.webContents.getURL()).origin!==new URL(config.serverUrl).origin)return;
   const changed=await win.webContents.executeJavaScript(`(()=>{const token=${JSON.stringify(config.token)};if(localStorage.getItem('token')===token)return false;localStorage.setItem('token',token);return true;})()`);
   if(changed)win.webContents.reload();
  });
  void win.loadURL(url||config.serverUrl).catch(()=>{});
 }else if(url)void win.loadURL(url).catch(()=>{});
 revealWindow(win);
}
function clear(id:number){pending.delete(id);try{notices.get(id)?.close();}catch{}notices.delete(id);tray?.setToolTip(`에이전트 메신저 · 결정 대기 ${pending.size}건`);}
function notificationThread(url:unknown):string|undefined {
 try{return new URLSearchParams(new URL(String(url)).hash.slice(1)).get('thread')??undefined;}catch{return undefined;}
}
function dismissThread(threadId:string){
 hiddenNotificationThreads.add(threadId);
 for(const [id,message] of pending)if(message.threadId===threadId)clear(id);
 if(!config)return;
 const ids=notificationLinks.forgetThread(config.agentName,threadId);
 for(const n of ordinaryNotices)if(ids.includes(n.id)){try{n.close();}catch{}ordinaryNotices.delete(n);}
 if(!ids.length)return;
 if(process.platform==='darwin'){try{Notification.remove(ids);}catch(error){console.error('삭제한 대화 알림 정리 실패',error);}return;}
 if(process.platform==='win32'){
  const encoded=Buffer.from(JSON.stringify(ids)).toString('base64');
  const script=`[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
$ids=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
$history=[Windows.UI.Notifications.ToastNotificationManager]::History
foreach($toast in $history.GetHistory('${APP_ID}')) { foreach($id in $ids) { if($toast.Tag -ceq $id) { $history.Remove($toast.Tag,$toast.Group,'${APP_ID}'); break } }`;
  execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000},error=>{if(error)console.error('삭제한 대화 알림 정리 실패',error.message);});
 }
}
async function answer(message:Message,body:string){
 if(!config||submitting.has(message.id)||!body.trim())return;
 lastNotificationHandled=Date.now();
 submitting.add(message.id);
 try{await submitDecision(config,message,body);clear(message.id);child?.send?.({type:'decision-answered',id:message.id});}
 catch(e){dialog.showErrorBox('답변 전송 실패',`${String(e)}\n결정 요청함에서 다시 답해주세요.`);}
 finally{submitting.delete(message.id);}
}
function decision(message:Message){
 if(!config||message.author!==config.agentName||hiddenNotificationThreads.has(message.threadId))return;
 pending.set(message.id,message);notices.get(message.id)?.close();
 const d=decisionChoices(message);const choices=d.fileAccess?[]:d.options.slice(0,2);
 const target=new URL('/',config.serverUrl);target.hash='thread='+encodeURIComponent(message.threadId);
 const id=`decision-${message.id}`;
 rememberNotification(id,target.href);
 const body=[d.question,d.summary,...choices.map((x,i)=>`${i+1}. ${x}`)].filter(Boolean).join('\n').slice(0,1000);
 const n=new Notification({id,groupId:'decisions',title:'내 결정이 필요해요',body,hasReply:!d.fileAccess,replyPlaceholder:'다른 의견을 직접 입력하세요',actions:choices.map((_,i)=>({type:'button',text:`${i+1}번 선택`})),timeoutType:'never',...(process.platform==='win32'?{toastXml:toastXml(id,'내 결정이 필요해요',body,choices.map((_,i)=>`${i+1}번 선택`),!d.fileAccess)}:{})});
 n.on('action',(event,index)=>{const i=event.actionIndex??index;if(choices[i])void answer(message,choices[i]);});
 n.on('reply',(event,reply)=>{if(!d.fileAccess)void answer(message,event.reply??reply);});
 n.on('click',()=>notificationOpened(target.href));
 n.on('failed',(_e,error)=>{console.error('결정 알림 표시 실패:',error);tray.setToolTip('결정 요청이 있습니다. 앱에서 확인해주세요.');});
 notices.set(message.id,n);tray.setToolTip(`에이전트 메신저 · 결정 대기 ${pending.size}건`);n.show();
}
function startDaemon(){
 if(child||!config||process.env.MESSENGER_DESKTOP_TEST==='1')return;
 mkdirSync(dataDir,{recursive:true});const fd=openSync(join(dataDir,'desktop-daemon.log'),'a');
 // Finder에서 실행하면 로그인 셸 PATH를 상속하지 않으므로 CLI 설치 경로를 복원한다.
 let path=process.env.PATH||'';
 if(process.platform==='darwin'){
  try{path=execFileSync('/bin/zsh',['-lc','print -r -- "$PATH"'],{encoding:'utf8',timeout:5000}).trim();}catch{}
 }
 child=spawn(process.execPath,[join(root,'daemon.mjs')],{cwd:homedir(),env:{...process.env,PATH:path,ELECTRON_RUN_AS_NODE:'1',AGENT_MESSENGER_HOME:dataDir},stdio:['ignore',fd,fd,'ipc'],windowsHide:true});closeSync(fd);
 child.on('message',async(event:any)=>{
  await clearingHistory;
  if(event.type==='decision'||event.type==='notify'&&event.requiresResponse===true){
   // Clear old notices before showing a new request, including during focus activation.
   if(cleanupTimer){clearTimeout(cleanupTimer);cleanupTimer=undefined;clearVisibleNotifications();}
   await clearingHistory;
  }
  if(event.type==='thread-dismissed'){dismissThread(event.threadId);return;}
  if(event.type==='decision')decision(event.message);
  if(event.type==='decision-dismissed')clear(event.id);
  if(event.type==='notify'){
   if((win?.isFocused()&&event.requiresResponse!==true)||hiddenNotificationThreads.has(notificationThread(event.url)??''))return;
   const id=randomUUID();
   if(config && typeof event.url==='string')rememberNotification(id,event.url);
   const n=new Notification({id,title:event.title,body:event.body,...(process.platform==='win32'?{toastXml:toastXml(id,event.title,event.body)}:{})});
   ordinaryNotices.add(n);
   n.on('click',()=>{let url:string|undefined;try{if(config && typeof event.url==='string' && new URL(event.url).origin===new URL(config.serverUrl).origin)url=event.url;}catch{}notificationOpened(url);ordinaryNotices.delete(n);});
   n.on('close',(event:any)=>{if(event.reason!=='timedOut')ordinaryNotices.delete(n);});
   n.on('failed',(_e,error)=>{ordinaryNotices.delete(n);console.error('알림 표시 실패',error);});
   // Windows 알림 센터에 남은 항목을 클릭할 때까지 객체를 유지한다.
   if(ordinaryNotices.size>200){const oldest=ordinaryNotices.values().next().value!;oldest.close();ordinaryNotices.delete(oldest);}
   n.show();
  }
 });
 child.on('exit',()=>{child=null;if(!quitting){tray.setToolTip('에이전트 연결 재시도 중');setTimeout(startDaemon,5000);}});
 child.on('error',error=>console.error('데몬 시작 실패',error));
}
async function boot(){
 app.setAppUserModelId(APP_ID);
 if(process.platform==='win32' && app.isPackaged){
  try{ensureNotificationShortcut({directory:join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs'),executable:process.execPath,shell});}
  catch(error){console.error('알림 클릭 연결 등록 실패',error);}
 }
 if(existsSync(configPath)){try{config=parseConfig(JSON.parse(readFileSync(configPath,'utf8')));}catch{}}
 const icon=nativeImage.createFromPath(join(root,'icon.png')).resize({width:20,height:20});
 tray=new Tray(icon);tray.setToolTip('에이전트 메신저');
 updates=startUpdates({serverUrl:config?.serverUrl||'http://localhost:3000',prepare:prepareUpdate,changed:()=>menu()});
 menu();tray.on('click',()=>show());
 if(process.platform==='win32')Notification.handleActivation(details=>{
  // 재시작 이전 알림 등 개별 객체가 없는 경우도 창 열기를 보장한다.
  // 개별 click/action/reply가 먼저 처리되면 해당 대화 이동·답변을 유지한다.
  const received=Date.now();
  setTimeout(()=>{if(lastNotificationHandled<received){const target=config?notificationLinks.resolve(details.arguments,config.agentName,config.serverUrl):undefined;notificationOpened(target||config?.serverUrl);}},100);
 });
 const session=(await import('electron')).session.defaultSession;
 session.on('will-download',(_event,item)=>{
  item.once('done',async(_event,state)=>{
   if(state==='completed'){const choice=await dialog.showMessageBox({message:'다운로드가 완료되었습니다.',detail:item.getSavePath(),buttons:['폴더에서 보기','닫기'],cancelId:1});if(choice.response===0)shell.showItemInFolder(item.getSavePath());}
   else if(state!=='cancelled')await dialog.showMessageBox({type:'warning',message:'다운로드가 중단되었습니다.',detail:'네트워크 연결을 확인하고 다시 다운로드해 주세요.'});
  });
 });
 show();startDaemon();
}
