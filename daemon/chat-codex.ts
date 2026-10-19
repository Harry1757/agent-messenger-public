import {mkdtemp,copyFile,chmod,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {resolveInvocation} from './process.ts';
import type {AdapterResult} from './adapters/index.ts';

export function supportedChatProtocol(userAgent:unknown):boolean {
 return ['0.153.4','0.154.0-alpha.6.2'].some(v=>String(userAgent).includes(`/${v} `));
}

/** An environment-free app-server turn. No shell, file, MCP or plugin tools. */
export async function chatCodex(command:string,cwd:string,prompt:string,model?:string|null):Promise<AdapterResult>{
 const invocation=resolveInvocation(command,['app-server','--stdio','--disable','hooks','--disable','plugins','--disable','apps','--disable','remote_plugin']);
 const isolated=await mkdtemp(join(tmpdir(),'messenger-codex-'));
 try{await copyFile(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'auth.json'),join(isolated,'auth.json'));await chmod(join(isolated,'auth.json'),0o600);}catch{await rm(isolated,{recursive:true,force:true});return {ok:false,text:'',costUsd:0,sessionId:null,error:'Codex 로그인 정보를 확인할 수 없습니다'};}
 const p=spawn(invocation.command,invocation.args,{cwd,env:{...process.env,CODEX_HOME:isolated},stdio:['pipe','pipe','ignore'],windowsHide:true});
 const closed=new Promise<void>(resolve=>p.once('close',()=>resolve()));
 let next=0,buffer='',answer='',observed='';
 const pending=new Map<number,{resolve:(x:any)=>void;reject:(x:Error)=>void}>();
 let finish:(x:any)=>void=()=>{};
 const completed=new Promise<any>(r=>{finish=r});
 const timer=setTimeout(()=>{finish({error:'대화 응답 시간이 초과되었습니다'});p.kill();},180000);
 const fail=(error:Error)=>{for(const x of pending.values())x.reject(error);pending.clear();finish({error:error.message});};
 p.on('error',fail);p.on('exit',()=>fail(Error('대화 실행이 종료되었습니다')));
 p.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let m:any;try{m=JSON.parse(line)}catch{continue}
  if(m.id!==undefined && pending.has(m.id)){const q=pending.get(m.id)!;pending.delete(m.id);m.error?q.reject(Error(m.error.message)):q.resolve(m.result);continue;}
  // Never fulfill model-initiated requests (including permission or dynamic tool calls).
  if(m.id!==undefined && m.method){p.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Tools are disabled for messenger chat'}})+'\n');continue;}
  if(m.method==='item/completed' && m.params?.item?.type==='agentMessage')answer=m.params.item.text;
  if(m.method==='turn/completed')finish(m.params.turn);
 }});
 const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});p.stdin.write(JSON.stringify({id,method,params})+'\n');});
 try{
  const init=await rpc('initialize',{clientInfo:{name:'agent_messenger_chat',version:'1'},capabilities:{experimentalApi:true}});
  // Pin the protocol whose empty-environment semantics were verified. Fail closed on older clients.
  if(!supportedChatProtocol(init.userAgent))throw Error('현재 Codex CLI 버전은 안전한 대화 실행 검증이 필요합니다. 메신저 앱 업데이트를 확인해 주세요 (지원: 0.153.4, 0.154.0-alpha.6.2)');
  const effective=await rpc('config/read',{includeLayers:false});
  if(effective.config?.model_instructions_file)throw Error('개인 지침 파일이 설정되어 안전한 대화를 시작할 수 없습니다');
  const config:Record<string,any>={project_doc_max_bytes:0,web_search:'disabled',include_environment_context:false,developer_instructions:'',instructions:''};
  for(const name of Object.keys(effective.config?.mcp_servers??{})){if(!/^[A-Za-z0-9_-]+$/.test(name))throw Error('MCP 설정 이름을 안전하게 해석할 수 없습니다');config[`mcp_servers.${name}.enabled`]=false;}
  for(const name of ['shell_tool','view_image','apps','plugins','remote_plugin','hooks','browser_use','computer_use','multi_agent','multi_agent_v2','memories','skill_search','workspace_dependencies','tool_suggest','image_generation','code_mode_host'])config[`features.${name}`]=false;
  const t=await rpc('thread/start',{ephemeral:true,environments:[],runtimeWorkspaceRoots:[],selectedCapabilityRoots:[],approvalPolicy:'never',sandbox:'read-only',config,baseInstructions:'You are a conversational assistant. You have no tools or filesystem access. Never claim to read or modify files.',...(model?{model}:{}),cwd});
  if(t.instructionSources?.length)throw Error('개인 지침이 포함되어 대화를 중단했습니다');
  observed=t.model;
  await rpc('turn/start',{threadId:t.thread.id,environments:[],input:[{type:'text',text:prompt,text_elements:[]}]});
  const result=await completed;
  if(result.error || result.status==='failed' || !answer.trim())throw Error(result.error?.message??result.error??'대화 응답이 비어 있습니다');
  return {ok:true,text:answer,costUsd:0,sessionId:null,error:null,observedModels:[observed],modelSource:'response'};
 }catch(e){return {ok:false,text:'',costUsd:0,sessionId:null,error:(e as Error).message};}
 finally{
  clearTimeout(timer);p.kill();
  // Windows holds the working directory until the child process has actually exited.
  let stopTimer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([closed,new Promise<void>(resolve=>{stopTimer=setTimeout(resolve,5000);})]);
  if(stopTimer)clearTimeout(stopTimer);
  try{await rm(isolated,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  catch{console.error('[정리 지연] Codex 임시 인증 폴더를 정리하지 못했습니다');}
 }
}
