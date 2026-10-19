import {app,dialog,Notification,shell} from 'electron';
import {autoUpdater} from 'electron-updater';

/** 설치는 자동 종료 시 실행하지 않는다. 사용자가 재시작을 선택하고 데몬이 비었을 때만 한다. */
export function startUpdates(options:{serverUrl:string; prepare:()=>Promise<boolean>; changed:(label:string)=>void}) {
  let ready=false,checking=false,label='업데이트 확인';
  const updateLabel=(value:string)=>{label=value;options.changed(value);};
  const feed=new URL('/downloads/apps/',options.serverUrl).href;
  async function install(){
    const result=await dialog.showMessageBox({type:'info',message:'업데이트를 설치하고 다시 시작할까요?',detail:'대화와 연결 설정은 유지됩니다. 에이전트가 작업 중이면 설치를 미룹니다.',buttons:['업데이트 후 다시 시작','나중에'],defaultId:0,cancelId:1});
    if(result.response!==0)return;
    if(!await options.prepare()){
      await dialog.showMessageBox({message:'에이전트가 작업 중입니다.',detail:'작업이 끝난 뒤 앱 아이콘 메뉴에서 다시 업데이트해 주세요.'});return;
    }
    autoUpdater.quitAndInstall(false,true);
  }
  async function check(manual=false){
    if(ready){if(manual)await install();return;}
    if(checking)return;
    checking=true;
    try{
      if(process.platform==='win32'){
        const result=await autoUpdater.checkForUpdates();
        if(manual && result?.updateInfo.version===app.getVersion())await dialog.showMessageBox({message:`최신 버전입니다 (${app.getVersion()})`});
      }else{
        const res=await fetch(new URL('version.json',feed),{signal:AbortSignal.timeout(15000),cache:'no-store'});
        if(!res.ok)throw new Error(`버전 확인 실패 (${res.status})`);
        const info=await res.json();
        if(newer(info.version,app.getVersion())){
          updateLabel(`새 버전 ${info.version} 설치 안내`);
          if(manual){
            const choice=await dialog.showMessageBox({message:`새 버전 ${info.version}이 있습니다`,detail:'Mac은 현재 설치 파일로 업데이트합니다. 설정과 대화는 유지됩니다.',buttons:['다운로드 페이지 열기','나중에'],cancelId:1});
            if(choice.response===0)await shell.openExternal(new URL('/start.html',options.serverUrl).href);
          }
        }else if(manual)await dialog.showMessageBox({message:`최신 버전입니다 (${app.getVersion()})`});
      }
    }catch(e){
      console.error('업데이트 확인 실패',e);updateLabel('업데이트 확인 실패 · 다시 시도');
      if(manual)await dialog.showMessageBox({type:'warning',message:'업데이트 서버에 연결하지 못했습니다.',detail:'사내 네트워크 연결을 확인하고 다시 시도해 주세요.'});
    }finally{checking=false;}
  }
  if(process.platform==='win32'){
    autoUpdater.setFeedURL({provider:'generic',url:feed});
    autoUpdater.autoDownload=true;
    autoUpdater.autoInstallOnAppQuit=false;
    autoUpdater.disableDifferentialDownload=true;
    autoUpdater.on('error',error=>{console.error('업데이트 오류',error);updateLabel('업데이트 실패 · 다시 시도');});
    autoUpdater.on('download-progress',progress=>updateLabel(`업데이트 다운로드 ${Math.round(progress.percent)}%`));
    autoUpdater.on('update-downloaded',()=>{
      ready=true;updateLabel('업데이트 후 다시 시작');
      const notice=new Notification({title:'업데이트 준비 완료',body:'앱 아이콘 메뉴에서 업데이트 후 다시 시작을 선택하세요.'});
      notice.on('click',()=>void install());notice.show();
    });
  }
  if(app.isPackaged && process.env.MESSENGER_DESKTOP_TEST!=='1'){
    setTimeout(()=>void check(),10000).unref();
    setInterval(()=>void check(),30*60*1000).unref();
  }
  return {check:()=>check(true),get label(){return label;}};
}
function newer(next:unknown,current:string){
  if(typeof next!=='string'||!/^\d+\.\d+\.\d+$/.test(next))return false;
  const a=next.split('.').map(Number),b=current.split('.').map(Number);
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
