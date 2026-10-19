import {codexRuntime} from './codex-runtime.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chatCodex} from './chat-codex.ts';
import {runCommand} from './process.ts';
import {getAdapter} from './adapters/index.ts';
import type { AdapterArgs, AdapterResult } from './adapters/index.ts';
export type { AdapterArgs, AdapterResult };
export interface RunOptions extends AdapterArgs {tool:string;command:string;cwd:string;}
export function chatClaudeArgs(o:RunOptions):string[]{
 return ['--safe-mode','--restricted','--strict-mcp-config','--tools','','--no-session-persistence','--output-format','json',...(o.model?['--model',o.model]:[]),'--system-prompt',o.systemPrompt,'-p',o.prompt];
}
/** Fresh conversation-only process; never attach a user project or an old CLI session. */
export async function runAgent(o:RunOptions):Promise<AdapterResult>{
 const cwd=await mkdtemp(join(tmpdir(),'messenger-chat-'));
 try{
  if(o.tool==='codex')return await chatCodex(codexRuntime(),cwd,`${o.systemPrompt}\n\n${o.prompt}`,o.model);
  if(o.tool!=='claude')throw Error('지원하지 않는 대화 도구입니다');
  const r=await runCommand(o.command,chatClaudeArgs(o),{cwd,timeout:180000});
  const parsed=getAdapter('claude').parseOutput(r.stdout||r.stderr);
  if(r.error)return {ok:false,text:'',costUsd:0,sessionId:null,error:'Claude 대화 실행 실패. 안전한 대화 옵션을 지원하는 최신 CLI인지 확인해 주세요.'};
  return {...parsed,sessionId:null};
 }catch(e){return {ok:false,text:'',costUsd:0,sessionId:null,error:(e as Error).message};}
 finally{
  try{await rm(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  catch{console.error('[정리 지연] 임시 작업 폴더 정리를 미뤘습니다. 답변 결과는 유지합니다');}
 }
}
