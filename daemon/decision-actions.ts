import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import notifier from 'node-notifier';
import type {Message} from '../shared/types.ts';
import {notify,notificationUrl,openDecisionInbox} from './notify.ts';

type Config={serverUrl:string;token:string;agentName:string};
export function decisionChoices(message:Message):{question:string;summary:string;options:string[];fileAccess?:boolean} {
 try{const p=JSON.parse(message.body);return {...(p.fileAccess===true?{fileAccess:true}:{}),question:typeof p.question==='string'?p.question:'판단이 필요합니다',summary:typeof p.summary==='string'?p.summary:'',options:Array.isArray(p.options)?p.options.filter((x:unknown)=>typeof x==='string'&&x.trim()):[]};}
 catch{return {question:'판단이 필요합니다',summary:'',options:[]};}
}
export async function submitDecision(config:Config,message:Message,body:string):Promise<Message|null> {
 if(message.author!==config.agentName || message.kind!=='decision_request')throw new Error('내 결정 요청이 아닙니다');
 if(!body.trim())throw new Error('답변을 입력해 주세요');
 const res=await fetch(`${config.serverUrl}/api/threads/${encodeURIComponent(message.threadId)}/messages`,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify({authorType:'human',kind:'decision_result',body:body.trim(),decisionRequestId:message.id}),signal:AbortSignal.timeout(15000)});
 if(res.status===409)return null; // 다른 창에서 이미 답한 요청
 if(!res.ok)throw new Error(`답변 전송 실패 (${res.status})`);
 return await res.json() as Message;
}
const active=new Map<number,{cancel:()=>void}>();
export function dismissDecision(id:number):void {process.send?.({type:'decision-dismissed',id});active.get(id)?.cancel();active.delete(id);}
export function notifyDecision(config:Config,message:Message,onAnswered:(m:Message)=>void):void {
 if(message.author!==config.agentName || active.has(message.id))return;
 if(process.send){process.send({type:'decision',message});return;}
 const data=decisionChoices(message);
 if(data.fileAccess){notify('파일 작업 승인이 필요합니다','앱에서 대상 파일과 변경 내용을 확인한 뒤 승인해 주세요.',notificationUrl(config.serverUrl,message.threadId));return;}
 const options=data.options.slice(0,2);
 const labels=options.map((_,i)=>`${i+1}번 선택`);
 const body=[data.question,data.summary,...options.map((s,i)=>`${i+1}. ${s}`)].filter(Boolean).join('\n').slice(0,700);
 const url=notificationUrl(config.serverUrl);
 let cancelled=false;
 let child:ReturnType<typeof execFile>|undefined;
 const state={cancel:()=>{cancelled=true;child?.kill();}};
 active.set(message.id,state);
 const finish=()=>{if(active.get(message.id)===state)active.delete(message.id);};
 const send=async(answer:string)=>{
  if(cancelled)return;
  try{const result=await submitDecision(config,message,answer);if(result)onAnswered(result);else onAnswered({...message,kind:'decision_result',decisionRequestId:message.id});}
  catch(e){notify('답변을 보내지 못했어요',`${(e as Error).message}. 요청함에서 다시 답해주세요.`,url);}
  finally{finish();}
 };
 const selected=(value:string)=>{
  if(cancelled)return;
  const index=labels.indexOf(value);
  if(index>=0){void send(options[index]);return;}
  if(value==='직접 입력'){input();return;}
  finish();
  if(value==='자세히 보기'||value==='@ACTIONCLICKED'||value==='activate')openDecisionInbox(config.serverUrl,config.agentName);
 };
 const native=['/opt/homebrew/bin/terminal-notifier','/usr/local/bin/terminal-notifier'].find(existsSync);
 const mac=(reply:boolean)=>{
  if(!native){finish();notify('판단이 필요합니다',body,url);return;}
  const args=['-title','에이전트 메신저 · 내 결정','-message',` ${body}`,'-group',`messenger-decision-${message.id}`,'-timeout','110',...(reply?['-reply','답변을 입력하세요']:['-action',[...labels,'직접 입력','자세히 보기'].join(',')])];
  child=execFile(native,args,{timeout:115000},(error,stdout)=>{
   if(cancelled)return;
   const value=stdout.trim();
   if(value.startsWith('@') && value!=='@ACTIONCLICKED'){finish();return;}
   if(error){finish();if((error as NodeJS.ErrnoException).code!==6)notify('판단이 필요합니다',body,url);return;}
   if(reply&&value&&value!=='@ACTIONCLICKED')void send(value);else selected(value);
  });
 };
 const input=()=>{
  if(process.platform==='darwin'){mac(true);return;}
  // node-notifier의 Windows 텍스트 파서는 ;, =가 들어간 답변을 손실시킨다.
  // 정확한 답변 전달을 위해 Windows 자유 입력은 기존 요청함으로 연결한다.
  finish();openDecisionInbox(config.serverUrl,config.agentName);
 };
 if(process.platform==='darwin'){mac(false);return;}
 if(process.platform==='win32'){
  const timer=setTimeout(()=>{state.cancel();finish();},115000);timer.unref();
  notifier.notify({title:'에이전트 메신저 · 내 결정',message:body,actions:[...labels,'직접 입력','자세히 보기'],id:message.id,sound:false,wait:true},(error,response)=>{
   clearTimeout(timer);if(cancelled)return;
   if(error){finish();notify('판단이 필요합니다',body,url);return;}
   selected(String(response??''));
  });return;
 }
 finish();notify('판단이 필요합니다',body,url);
}
