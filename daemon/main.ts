import {LocalGithubEvidence} from './local-github-evidence.ts';
import {GithubReadError} from '../shared/github-read.ts';
import {completeGithubReads,resolveGithubProject} from './github-reads.ts';
import {join} from 'node:path';
import {GithubPending} from './github-pending.ts';
import {codexRuntime} from './codex-runtime.ts';
import {handleWithFailure,visibleFailure} from './request-failure.ts';
import {GithubConnection} from './github-connection.ts';
import {ResourceRunner} from './resource-runner.ts';
import {ShareRoots} from './share-roots.ts';
import {DATA_DIR} from './config.ts';
import {workspaceRoots} from './workspace.ts';
import {LatestRequests} from './latest-request.ts';
import {DirectNotifications} from './direct-notifications.ts';
import { loadConfig, type DaemonConfig } from './config.ts';
import { notify, notificationUrl } from './notify.ts';
import { runAgent } from './agent.ts';
import { getAdapter } from './adapters/index.ts';
import { detectTools, probeTool } from './doctor.ts';
import { readSession, writeSession } from './sessions.ts';
import { buildSystemPrompt, interpret } from './prompt.ts';
import { resolveActive, DEFAULT_MODELS, shouldNotifyQuestion, type ActiveTool } from './state.ts';
import {shouldReviewReply, unansweredMention, conversationPrompt, conversationSessionKey} from './conversation.ts';
import {DecisionReminders, CompletionNotifications} from './reminders.ts';
import {notifyDecision,dismissDecision} from './decision-actions.ts';
import { extractMentions } from '../shared/mentions.ts';
import type { AgentSettings, Message, ServerEvent, ExecutionInfo } from '../shared/types.ts';

// 알림은 터미널을 보지 않는 사람에게 닿으라고 만든 것이다 — 전체 경로와 원본 오류
// 문자열은 진단에 필요하니 콘솔에만 남기고, 알림 자체는 원인 한 줄 + 할 일 한 줄로
// 줄인다. 세 실패 경로(설정 로드·도구 점검·agentName 불일치) 모두 이 모양을 쓴다.
const SETUP_ACTION = '터미널에서 npm run setup 을 실행하세요.';
function notifyStartupFailure(cause: string): void {
  notify('에이전트를 시작할 수 없습니다', `${cause}\n${SETUP_ACTION}`);
}

// 설정을 읽다 실패하는 것도 "조용히 죽어 모든 질문을 놓치는" 실패의 한 갈래다 —
// 실패한 도구 확인과 똑같은 대접을 받아야 한다: 무엇이 왜 잘못됐는지 알리고,
// 터미널을 보지 않는 사람에게 알림으로 닿고, 0이 아닌 코드로 끝낸다.
let config: DaemonConfig;
try {
  config = loadConfig();
  if(config.tool==='codex')config={...config,command:codexRuntime()};
} catch (e) {
  const detail = (e as Error).message;
  console.error(`[설정 오류] ${detail}`);
  console.error('npm run setup 을 실행해 설정을 다시 만드세요.');
  notifyStartupFailure('설정을 불러오지 못했습니다.');
  process.exit(1);
}

// 첫 SSE 연결 전에 도구가 실제로 실행되는지 확인한다. 조용히 살아서 모든 질문을
// 놓치는 것보다, 지금 실패해 터미널을 보지 않는 사람에게도 알림으로 알리는 편이 낫다.
// tool 은 어댑터 선택용이고 실제로 실행되는 것은 command 이므로 command 를 확인한다.
const probe = await probeTool(config.tool, config.command);
if (!probe.ok) {
  console.error(`[사전 점검 실패] "${config.command}" 실행 확인 실패 — ${probe.detail}`);
  console.error('npm run setup 을 다시 실행하거나, npm run doctor 로 설치 상태를 확인하세요.');
  const cause = probe.detail.includes('ENOENT')
    ? `${config.tool} 를 찾을 수 없습니다.`
    : `${config.tool} 를 실행할 수 없습니다.`;
  notifyStartupFailure(cause);
  process.exit(1);
}

// 서버는 에이전트 메시지도 "author === 토큰이 속한 계정" 을 강제한다(사칭 방지,
// server/routes.ts). config.agentName 과 토큰의 실제 계정이 어긋나면 이 데몬은
// 첫 질문에서마다 조용히 403 을 받고 아무 답도 올리지 못한다 — 도구 점검 실패와
// 같은 부류의 "조용히 살아서 모든 질문을 놓치는" 실패이므로 시작할 때 바로 잡는다.
// 서버는 인증된 /api 응답마다 X-User 헤더(URI 인코딩)로 토큰의 계정을 알려준다.
try {
  const who = await fetch(`${config.serverUrl}/api/threads`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  const header = who.headers.get('x-user');
  if (who.ok && header !== null) {
    const tokenUser = decodeURIComponent(header);
    if (tokenUser !== config.agentName) {
      const detail = `agentName="${config.agentName}" 이 토큰이 속한 계정("${tokenUser}")과 다릅니다`;
      console.error(`[사전 점검 실패] ${detail}`);
      console.error('설정의 agentName 을 토큰 계정 이름과 같게 맞추세요 (npm run setup).');
      notifyStartupFailure('에이전트 이름이 토큰 계정과 다릅니다.');
      process.exit(1);
    }
  }
  // who.ok 가 아니거나(예: 토큰 불일치) 헤더가 없으면 이 확인은 결론을 못 낸다 —
  // 그 실패는 아래 SSE 구독 루프가 어차피 다시 마주치고, 그 루프는 이미 재시도를
  // 제 손으로 한다. 여기서는 이름 불일치만 선제적으로 잡는다.
} catch (e) {
  console.error(`[사전 점검] 서버에 연결해 계정을 확인하지 못했습니다 — ${(e as Error).message}`);
}

// 이 기계에서 실제로 도는 도구들. 웹의 도구 목록이 이것으로 채워진다 — 서버는
// 이 노트북 사정을 알 수 없으므로, 알려주지 않으면 고를 수 없는 것을 고르게 된다.
const availableTools = (await detectTools()).filter((p) => p.ok).map((p) => p.tool);
if(!availableTools.includes('codex')){
  try{if((await probeTool('codex',codexRuntime())).ok)availableTools.push('codex');}catch{}
}

// 작업 폴더 첫 번째가 작업 디렉토리, 나머지는 --add-dir 로 읽기를 허용한다.
// No project discovery until verified participant grants and isolated execution exist.
const roots: string[] = [];
const primaryCwd = ''; // runAgent creates its own empty working directory.
const addDirs = roots.slice(1);
const repoNames: string[] = [];
const systemPrompt = buildSystemPrompt(config.agentName, repoNames);
const github=new GithubConnection(config);
const githubPending=new GithubPending(join(DATA_DIR,'github-pending.json'));
// Background identity refresh is silent; file requests explain missing access when needed.
let githubSync: ReturnType<GithubConnection['sync']> | null = null;
function syncGithub(){
  if (!githubSync) githubSync = github.sync().then(result=>{
    if(result.ok) githubPending.resume(scheduled,enqueue);
    return result;
  }).finally(()=>{githubSync=null;});
  return githubSync;
}
process.on('message', (event:any) => {
  if(event?.type !== 'github-refresh' || typeof event.requestId !== 'string') return;
  void syncGithub().then(result => process.send?.({type:'github-refreshed',requestId:event.requestId,result}))
    .catch(()=>process.send?.({type:'github-refreshed',requestId:event.requestId,result:{ok:false,detail:'GitHub 확인에 실패했습니다. 다시 시도해 주세요.'}}));
});
void syncGithub();
setInterval(()=>void syncGithub(),5*60*1000).unref();
async function api(path:string,method='GET',body?:unknown){
 const res=await fetch(config.serverUrl+path,{method,headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const value=await res.json();if(!res.ok)throw Error(value.error||'서버 요청을 완료하지 못했습니다');return value;
}
const taskClaims=new Map<string,any>();
const taskKey=(m:Message)=>`${m.threadId}:${m.id}`;
async function claimTask(m:Message){const response=await api(`/api/threads/${m.threadId}/tasks`,'POST',{messageId:m.id});if(response.claimed)taskClaims.set(taskKey(m),response.task);return response.claimed;}
async function finishTask(m:Message,state:string,reason?:string){const task=taskClaims.get(taskKey(m));if(!task)return;taskClaims.delete(taskKey(m));await api(`/api/tasks/${task.id}/state`,'POST',{...task,state,reason}).catch(()=>{});}
const localGithubEvidence=new LocalGithubEvidence();
const resources=new ResourceRunner({home:DATA_DIR,owner:config.agentName,api,
 answer:async(source,context)=>{
   if(!taskClaims.has(taskKey(source))&&!(await claimTask(source)))throw Error('요청이 종료되었습니다');
   const history=await api(`/api/threads/${source.threadId}/messages?context=agent&private=${source.privateTo!==null}`);const audience=source.privateTo?[config.agentName]:await fileAudience(source.threadId);
   const visible=history.filter((m:Message)=>!m.resourceAudience||audience.every((u:string)=>m.resourceAudience!.includes(u)));
   taskClaims.get(taskKey(source)).contextMessageIds=visible.filter((m:Message)=>m.resourceAudience).map((m:Message)=>m.id).slice(-100);
   if(source.resourcePolicyIds&&!visible.some((m:Message)=>m.id===source.id))throw Error('원래 자료의 공유 허용이 변경되었습니다');
   const key=taskKey(source);
   const run=(remoteContext='')=>runAgent({tool:active.tool,command:active.command,cwd:'',prompt:conversationPrompt(source,visible,false)+context+remoteContext,threadId:conversationSessionKey(source.threadId,source.privateTo),sessionId:null,systemPrompt:buildSystemPrompt(config.agentName,new ShareRoots(DATA_DIR,config.agentName).listPolicies(source.threadId).filter(p=>!p.revoked&&(p.workFolder===true||audience.every((u:string)=>p.audience.includes(u)))).map(p=>p.label||p.rootId)),addDirs:[],model:active.model});
   try{
    const initial=await run(localGithubEvidence.get(key)?.context??'');
    const result=await localGithubEvidence.complete(key,initial,async query=>{const repo=await github.resolveProject(query.project!);return github.readRepository(repo,query,source.threadId,source.privateTo!==null);},run,()=>hiddenThreads.has(source.threadId)||latestRequests.superseded(source));
    if(!result.ok)throw Error('자료를 읽었지만 답변을 완료하지 못했습니다');return result.text;
   }catch(error){
    if(!(error instanceof GithubReadError))throw error;
    localGithubEvidence.clear(key);
    return 'DECISION'+JSON.stringify({question:'원격 기준 자료를 조회하지 못했습니다. 어떻게 이어갈까요?',summary:'허용된 로컬 자료는 확인했지만 GitHub 연결·공유 권한 또는 조회 대상을 확인해야 비교를 완료할 수 있습니다. 아직 비교 결과가 아닙니다.',options:['GitHub 연결·읽기 공유 설정 확인 후 다시 비교','확인한 로컬 자료만 정리']});
   }
 },
 publish:async(source,result,receiptIds,audience)=>{
   if(receiptIds.length&&!taskClaims.has(taskKey(source))&&!(await claimTask(source)))throw Error('원래 요청이 이미 종료되었거나 실행 중입니다');
   const task=receiptIds.length?taskClaims.get(taskKey(source)):undefined;
   const remote=receiptIds.length?localGithubEvidence.get(taskKey(source)):undefined;
   await post(source.threadId,result.kind,result.body,source.privateTo,undefined,receiptIds.length?audience:undefined,undefined,receiptIds.length&&remote?.grants.length?remote.grants:undefined,receiptIds.length?receiptIds:undefined,task,receiptIds.length&&source.authorType==='agent'&&source.agentAction==='request'?source.author:undefined,'reply',receiptIds.length&&source.authorType==='agent'&&source.agentAction==='request'?source.id:undefined);
   if(task)taskClaims.delete(taskKey(source));
   localGithubEvidence.clear(taskKey(source));
 },isCancelled:source=>hiddenThreads.has(source.threadId)||latestRequests.superseded(source)});
let resourcesRestoring=false;
const resourceNotices=new Map<string,string>();
async function resumeResources(){if(resourcesRestoring)return;resourcesRestoring=true;try{await resources.resumeReady();
 const requests=await api('/api/resources');for(const r of requests){const state=r.status+':'+(r.waitReason??'');if(r.status==='waiting-owner'&&resourceNotices.get(r.id)!==state&&!hiddenThreads.has(r.threadId))notify('자료 공유 확인이 필요합니다','요청한 파일·폴더와 공유 상대를 확인해 주세요.',notificationUrl(config.serverUrl,r.threadId),{requiresResponse:true});resourceNotices.set(r.id,state);}
}catch{console.warn('자료 요청 복구를 다음 연결에서 다시 확인합니다');}finally{resourcesRestoring=false;}}
process.on('message',event=>{if((event as any)?.type==='sharing-changed')void resumeResources();});
setInterval(()=>void resumeResources(),5000).unref();
async function fileAudience(threadId:string):Promise<string[]>{
 const r=await fetch(`${config.serverUrl}/api/threads/${threadId}/participants`,{headers:{Authorization:`Bearer ${config.token}`}});
 if(!r.ok)throw Error('공유 대상을 확인할 수 없습니다');return await r.json();
}

/** 웹에서 고른 값. 서버가 알려주기 전까지는 "정하지 않음" — 설정 파일을 따른다. */
let settings: AgentSettings = { tool: null, model: null };
/** 다음 실행에 쓸 도구·모델. 진행 중인 실행은 시작할 때의 값을 끝까지 쓴다. */
let active: ActiveTool = resolveActive(config, settings, availableTools);

/** 같은 스레드에서 두 번 동시에 돌지 않도록 잠근다. */
const running = new Set<string>();

/**
 * 서버에 올릴 "지금 무엇을 하고 있나". running 이 여러 개일 수 있지만 한 개만 싣는다.
 * ponytail: 한 사람이 동시에 두 스레드를 돌리면 화면에는 하나만 "실행 중"으로 보인다.
 * 실제로 그런 일이 잦아지면 배열로 바꾼다.
 */
function busyThreadId(): string | null {
  for (const id of running) return id;
  return null;
}

/**
 * 서버가 보낸 설정을 받아 다음 실행에 쓸 값을 다시 계산한다.
 * 바뀌었으면 true — 호출부가 바뀐 상태를 서버에 다시 보고한다.
 */
function applySettings(next: unknown): boolean {
  if (typeof next !== 'object' || next === null) return false;
  const s = next as Record<string, unknown>;
  settings = {
    tool: typeof s.tool === 'string' && s.tool !== '' ? s.tool : null,
    model: typeof s.model === 'string' && s.model !== '' ? s.model : null,
  };
  const before = JSON.stringify(active);
  active = resolveActive(config, settings, availableTools);
  if (JSON.stringify(active) === before) return false;

  // 요청된 도구를 쓸 수 없으면 조용히 넘어가지 않는다 — 로그에 남기고, 아래 report()
  // 가 같은 사실을 서버로 올려 화면에도 뜬다.
  if (!active.toolOk) console.error(`[설정] ${active.toolError}`);
  else console.log(`[설정] 다음 실행부터 ${active.tool} / 모델 ${active.model ?? '기본값'}`);
  return true;
}

/**
 * 자기 상태를 서버에 올리고, 서버가 보관 중인 설정을 받아 적용한다.
 * 실패해도 던지지 않는다 — 상태 보고가 안 된다고 질문에 답하지 못하면 더 나쁘다.
 */
async function report(online = true, depth = 0): Promise<void> {
  let data: unknown;
  try {
    const res = await fetch(`${config.serverUrl}/api/agent/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'X-Agent-Protocol':'resource-access-v2' },
      body: JSON.stringify({
        online,
        availableTools,
        configuredTool: config.tool,
        configuredModel: config.model ?? DEFAULT_MODELS[config.tool] ?? null,
        tool: active.tool,
        model: active.model,
        busyThreadId: online ? busyThreadId() : null,
        toolOk: active.toolOk,
        toolError: active.toolError,
      }),
    });
    if (!res.ok) {
      console.error(`[상태 보고 실패] ${res.status} ${await res.text()}`);
      return;
    }
    data = await res.json();
  } catch (e) {
    console.error(`[상태 보고 실패] ${(e as Error).message}`);
    return;
  }

  // 설정이 바뀌어 있었다면 방금 올린 상태가 이미 낡았다. 한 번만 다시 올린다 —
  // applySettings 는 같은 설정에 같은 결과를 주므로 두 번째는 반드시 false 다.
  if (applySettings((data as Record<string, unknown>)?.settings) && depth === 0) {
    await report(online, 1);
  }
}

/**
 * 일시정지된 스레드. 서버도 409로 막지만, 여기서 먼저 걸러야
 * 어차피 거부당할 에이전트 실행에 돈을 쓰지 않는다.
 */
const paused = new Set<string>();
const latestRequests = new LatestRequests();
const hiddenThreads=new Set<string>();
function forgetThread(threadId:string){
 try{new ShareRoots(DATA_DIR,config.agentName).revokeThread(threadId);}catch{}
 hiddenThreads.add(threadId);reminders.forgetThread(threadId);completions.forgetThread(threadId);githubPending.forgetThread(threadId);
 process.send?.({type:'thread-dismissed',threadId});
}

async function handle(message: Message): Promise<void> {
  if(hiddenThreads.has(message.threadId)||latestRequests.superseded(message))return;
  // 에이전트가 자기 답에 또 답하는 무한루프만 막는다. 사람이 자기 이름을 부르는
  // 혼잣말(@자기 이름)은 통과시켜야 한다 — 그래야 자기 에이전트에게 혼자 물어볼 수 있다.
  if (message.authorType === 'agent' && (/^(?:⚠️ 에이전트 실행 실패:|⚠️ GitHub 조회 중단:|⏸️ GitHub 연결 대기)/u.test(message.body.trim()) || message.author === config.agentName)) return;
  if (message.kind === 'decision_request') return;
  const mentioned = message.authorType==='agent'?message.agentTarget===config.agentName:message.kind!=='summary'&&extractMentions(message.body).includes(config.agentName);
  if (!mentioned && message.authorType !== 'agent') return;


  const response = await fetch(`${config.serverUrl}/api/threads/${message.threadId}/messages?context=agent&private=${message.privateTo!==null}`, {
    headers: {Authorization:`Bearer ${config.token}`}, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`대화 기록 조회 실패: ${response.status}`);
  const rawHistory = await response.json() as Message[];
  const audience=message.privateTo?[config.agentName]:await fileAudience(message.threadId);
  const history=rawHistory.filter(m=>!m.resourceAudience||audience.every(u=>m.resourceAudience!.includes(u)));
  if(message.authorType==='agent'&&message.agentTarget!==config.agentName)return;
  if(message.resourcePolicyIds&&!history.some(m=>m.id===message.id))return;
  const review = message.agentAction==='reply'||!mentioned && shouldReviewReply(message, history, config.agentName);
  if (!mentioned && !review) return;
  if (paused.has(message.threadId)) {
    console.log(`[skip] ${message.threadId} 는 일시정지 상태 — 사람의 확인 대기`);
    notify('확인이 필요합니다', '자동 진행이 멈췄습니다. 계속할지 정해주세요.', notificationUrl(config.serverUrl,message.threadId),{requiresResponse:true});
    return;
  }
  if (running.has(message.threadId)) {
    console.log(`[skip] ${message.threadId} 는 이미 실행 중`);
    return;
  }

  if(message.direct)return;
  if(!(await claimTask(message))){scheduled.delete(message.id);return;}
  taskClaims.get(taskKey(message)).contextMessageIds=history.filter(m=>m.resourceAudience).map(m=>m.id).slice(-100);
  running.add(message.threadId);

  console.log(`[run] request=${message.id}`);
  // 지금 돌기 시작했다는 사실을 서버에 알린다 — 화면이 "답하는 중"을 추측하지 않게 한다.
  void report();

  // 이 실행이 끝날 때까지는 시작할 때의 도구·모델을 쓴다. 중간에 설정이 바뀌어도
  // 진행 중인 실행은 건드리지 않는다 — 세션 이어가기가 도구를 갈아타면 깨진다.
  const use = active;
  const sessionKey = conversationSessionKey(message.threadId, message.privateTo);

  let githubRepoForRequest:string|undefined;
  try {
    const run = (sessionId: string | null, githubContext='') =>
      runAgent({
        tool: use.tool,
        command: use.command,
        cwd: primaryCwd,
        prompt: conversationPrompt(message, history, review)+githubContext,
        threadId: sessionKey,
        sessionId,
        systemPrompt:buildSystemPrompt(config.agentName,new ShareRoots(DATA_DIR,config.agentName).listPolicies(message.threadId).filter(p=>!p.revoked&&(p.workFolder===true||audience.every(u=>p.audience.includes(u)))).map(p=>p.label||p.rootId)),
        addDirs,
        model: use.model,
      });

    const stored = readSession(sessionKey, use.tool);
    let result = await run(stored);

    // 저장된 세션 id 가 실제 CLI 상태와 어긋났을 수 있다 — id 는 남았는데 도구 쪽 세션이
    // 만들어진 적이 없거나(첫 실행이 통째로 실패), 세션은 있는데 저장 파일이 유실됐거나.
    // 어긋난 채로 두면 그 스레드는 매번 같은 이유로 실패해 영구히 막힌다.
    // 반대 세션 상태로 딱 한 번 다시 시도해 스스로 교정한다.
    // 저장된 id 가 있으면 새 세션으로, 없으면 도구가 되찾을 수 있는 id 로(claude 는
    // 스레드 id, codex 는 되찾을 수 없으므로 재시도 없음).
    if (!result.ok) {
      const alt = stored === null ? getAdapter(use.tool).resumeIdFor(sessionKey) : null;
      if (alt !== stored) {
        const retried = await run(alt);
        if (retried.ok) result = retried;
      }
    }

    const githubResult=await completeGithubReads(result,async query=>{
      const repo=await github.resolveProject(query.project!);githubRepoForRequest=repo;
      return github.readRepository(repo,query,message.threadId,message.privateTo!==null);
    },context=>run(null,context),()=>hiddenThreads.has(message.threadId)||latestRequests.superseded(message));
    result=githubResult.result;

    // 성공했을 때만 저장한다 — 없는 세션을 적어 두는 것이 위 영구 정지의 원인이다.
    if (result.ok && result.sessionId !== null) writeSession(sessionKey, result.sessionId, use.tool);

    // A newer request is already queued with the full conversation history.
    // Do not publish an answer or error for superseded instructions.
    if(hiddenThreads.has(message.threadId)||latestRequests.superseded(message)){console.log('[merge] 추가 요청을 반영해 다시 답변합니다');return;}
    if (!result.ok) {
      console.error(`[fail] ${result.error}`);
      notify('에이전트 답변 실패', result.error, notificationUrl(config.serverUrl,message.threadId));
      await post(message.threadId, 'text', `⚠️ 에이전트 실행 실패: ${result.error}`, message.privateTo,undefined,undefined,undefined,undefined,undefined,taskClaims.get(taskKey(message)));taskClaims.delete(taskKey(message));
      return;
    }

    // 어떤 모델로 얼마를 썼는지 함께 남긴다 — 비용만 찍히면 모델별 비교가 안 된다.
    console.log(`[done] ${use.tool}/${use.model ?? '기본값'} $${result.costUsd.toFixed(4)}`);
    if(result.text.trim().startsWith('FILE_OPERATION'))localGithubEvidence.seed(taskKey(message),githubResult);
    if(await resources.handle(result.text,message,history)){await finishTask(message,resources.hasPending(message)?'waiting-owner':'failed','자료 접근 확인');return;}
    let agentTarget:string|undefined;
    if(result.text.trim().startsWith('ASK_AGENT')){const action=JSON.parse(result.text.trim().slice(9));if(typeof action.target!=='string'||!audience.includes(action.target)||action.target===config.agentName||typeof action.question!=='string'||action.question.length>2000)throw Error('추가 요청 대상을 확인할 수 없습니다');const agentStates=await api('/api/agents');const targetState=agentStates.agents.find((a:any)=>(a.user??a.name)===action.target);if(!targetState?.connections?.resourceAccess){result.text='DECISION'+JSON.stringify({question:`${action.target}님에게 어떻게 확인할까요?`,summary:'상대 에이전트가 새 대화 연결 기능을 지원하는 앱에 연결되어 있지 않습니다. 상대방은 일반 직접 대화를 사용할 수 있습니다.',options:['상대 앱 업데이트 후 다시 확인','제가 직접 답변','취소']});}else{agentTarget=action.target;result.text=`@${action.target} ${action.question}`;}}
    let agentAction:'request'|'reply'='request';let replyTo:number|undefined;
    if(!agentTarget&&message.authorType==='agent'&&message.agentAction==='request'){agentTarget=message.author;agentAction='reply';replyTo=message.id;}
    const { kind, body } = interpret(result.text);
    // 판단 요청 알림은 여기서 하지 않는다. 올린 메시지가 SSE 로 되돌아올 때
    // maybeNotifyDecision() 이 처리한다 — 그래야 물어본 사람에게도 알림이 간다.
    // 혼잣말에는 혼잣말로 답한다 — 원본 질문의 privateTo 를 답에도 그대로 싣는다.
    // 안 그러면 질문은 숨었는데 답만 공개돼 상대가 맥락 없는 답을 보게 된다.
    await post(message.threadId, kind, body, message.privateTo, {
      tool:use.tool, requestedModel:use.model, observedModels:result.observedModels ?? [], source:result.modelSource ?? 'unavailable',
    },githubResult.audience,undefined,githubResult.grants.length?githubResult.grants:undefined,undefined,taskClaims.get(taskKey(message)),agentTarget,agentAction,replyTo);taskClaims.delete(taskKey(message));
    if(githubResult.recovery)await post(message.threadId,'decision_request',JSON.stringify({question:'남은 GitHub 확인을 어떻게 이어갈까요?',summary:githubResult.recovery.message+' 이미 확인한 자료는 위 답변에 남겼습니다.',recovery:true,options:['연결·권한 확인 후 남은 내용 다시 시도','현재 확인 결과로 마무리','취소']}),message.privateTo);
  } catch(error) {
    if(hiddenThreads.has(message.threadId)||latestRequests.superseded(message)){await finishTask(message,'cancelled');return;}
    if(!(error instanceof GithubReadError)){await finishTask(message,'failed');throw error;}
    if(['LOGIN_REQUIRED','ACCOUNT_CHANGED','CONNECTION'].includes(error.code)){
      githubPending.hold(message);await finishTask(message,'waiting-connection','GitHub 연결 필요');
      await post(message.threadId,'text','⏸️ GitHub 연결 대기: 본인 GitHub 연결을 확인해 주세요. 연결되면 원래 질문을 이어갑니다. 일반 대화는 계속하실 수 있습니다.',message.privateTo);return;
    }
    const share=['MEMBER_LOGIN_REQUIRED','COMMON_ACCESS'].includes(error.code)&&githubRepoForRequest;
    const card=share?{question:'이 대화에 GitHub 저장소의 읽기 결과를 공유하시겠어요?',summary:'본인 계정으로 접근 가능한 자료만 확인합니다. 공유 상대에게 GitHub 로그인을 요구하지 않습니다. 수정·게시·병합은 허용하지 않습니다.',githubSharing:{repo:githubRepoForRequest,audience},options:['이 대화에서 저장소 읽기 결과 공유 허용','공유하지 않음']}:{question:'GitHub 확인을 어떻게 이어갈까요?',summary:error.message,recovery:true,options:['연결·권한 확인 후 원래 질문 다시 시도','자료 없이 확인된 대화 내용만 정리','취소']};
    await post(message.threadId,'decision_request',JSON.stringify(card),message.privateTo,undefined,undefined,undefined,undefined,undefined,taskClaims.get(taskKey(message)));taskClaims.delete(taskKey(message));
  } finally {
    if(taskClaims.has(taskKey(message)))await finishTask(message,latestRequests.superseded(message)?'cancelled':'failed');
    running.delete(message.threadId);
    void report(); // 끝났다는 사실도 알린다
  }
}

setInterval(()=>void restoreReminders().catch(()=>{}),15000).unref();
const directNotifications=new DirectNotifications(config.agentName,message=>notify(`${message.author}님의 메시지`,message.body.slice(0,500),notificationUrl(config.serverUrl,message.threadId)));
const completions = new CompletionNotifications(config.agentName, message => notify('대화의 결론이 정리됐어요', `${message.author}님의 에이전트: ${message.body.split('\n').find(line=>line.trim()) || '대화 정리를 확인해 주세요.'}`, notificationUrl(config.serverUrl,message.threadId)));
setInterval(() => completions.tick(), 1000).unref();
const reminders = new DecisionReminders(config.agentName, (_title,_body,message)=>notifyDecision(config,message,result=>{reminders.observe(result);dismissDecision(message.id);}));
process.on('message',(event:any)=>{if(event?.type==='decision-answered' && Number.isSafeInteger(event.id)){reminders.observe({kind:'decision_result',decisionRequestId:event.id} as Message);dismissDecision(event.id);}});
setInterval(() => reminders.tick(), 1000).unref();
async function restoreReminders(): Promise<void> {
  const headers = {Authorization:`Bearer ${config.token}`};
  const hidden=await fetch(`${config.serverUrl}/api/hidden-threads`,{headers,signal:AbortSignal.timeout(15000)});
  if(hidden.ok)for(const id of await hidden.json())forgetThread(id);
  const res = await fetch(`${config.serverUrl}/api/threads`, {headers,signal:AbortSignal.timeout(15000)});
  if (!res.ok) return;
  const threads = await res.json() as {id:string;paused:boolean;resolved:boolean}[];
  const history: Message[] = [];
  for (const thread of threads) {
    const response = await fetch(`${config.serverUrl}/api/threads/${thread.id}/messages`, {headers,signal:AbortSignal.timeout(15000)});
    if (response.ok) {
      const items = await response.json() as Message[];
      history.push(...items);
      const tasks=await api(`/api/threads/${thread.id}/tasks`).catch(()=>[]);
      for(const task of tasks)if(task.owner===config.agentName&&((task.state==='running'&&task.leaseUntil<=Date.now())||(task.state==='failed'&&task.reason==='실행 연결이 끊겨 다시 시도할 수 있습니다'&&task.attempts<4))){const source=items.find(m=>m.id===task.messageId);if(source){scheduled.delete(source.id);enqueue(source);}}
      const assigned=items.findLast(m=>m.authorType==='agent'&&m.agentTarget===config.agentName);
      if(assigned&&!tasks.some((t:any)=>t.owner===config.agentName&&t.messageId===assigned.id&&['completed','failed','cancelled','waiting-owner','waiting-connection','waiting-agent'].includes(t.state)))enqueue(assigned);
      const last = items.at(-1);
      const missed = unansweredMention(items,config.agentName);
      if (!thread.paused && !thread.resolved && missed) {enqueue(missed);continue;}
      // SSE has no durable replay. Recover the latest unanswered turn after reconnect.
      if (!thread.paused && !thread.resolved && last && last.kind !== 'decision_request' &&
          !(last.authorType === 'agent' && last.author === config.agentName) &&
          (extractMentions(last.body).includes(config.agentName) || shouldReviewReply(last,items,config.agentName))) enqueue(last);
    }
  }
  reminders.reconcile(history.filter(m=>!hiddenThreads.has(m.threadId)));
}

async function post(threadId: string, kind: string, body: string, privateTo: string | null, execution?:ExecutionInfo, fileAudience?:string[], fileReadGrant?:string, githubReadGrants?:string[],resourceReceipts?:string[],task?:any,agentTarget?:string,agentAction?:'request'|'reply',replyTo?:number): Promise<Message> {
  if(hiddenThreads.has(threadId))throw Error('삭제한 대화의 응답은 게시하지 않습니다');
  const res = await fetch(`${config.serverUrl}/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'X-Agent-Protocol':'resource-access-v2' },
    body: JSON.stringify({ authorType: 'agent', author: config.agentName, kind, body, privateTo, execution, ...(fileAudience?{fileAudience}:{}),...(fileReadGrant?{fileReadGrant}:{}),...(githubReadGrants?{githubReadGrants}:{}),...(resourceReceipts?{resourceReceipts}:{}),...(task?{task,...(task.contextMessageIds?{contextMessageIds:task.contextMessageIds}:{})}:{}),...(agentTarget?{agentTarget,agentAction:agentAction??'request',...(replyTo?{replyTo}:{})}:{}) }),
  });
  if (!res.ok) throw new Error(`[post 실패] ${res.status} ${await res.text()}`);
  return await res.json() as Message;
}

/** SSE 스트림을 한 줄씩 읽는다. 끊기면 밖에서 재연결한다. */
const queues = new Map<string, Promise<void>>();
const scheduled = new Set<number>();
let updatePaused=false;
process.on('message',(event:any)=>{
  if(event?.type!=='prepare-update')return;
  const ready=running.size===0 && queues.size===0;
  if(ready){updatePaused=true;setTimeout(()=>{updatePaused=false;},30000).unref();}
  process.send?.({type:'update-ready',ready});
});
function enqueue(message: Message): void {
  if (hiddenThreads.has(message.threadId) || updatePaused || scheduled.has(message.id)) return;
  latestRequests.observe(message,config.agentName);
  scheduled.add(message.id);
  if (scheduled.size > 5000) scheduled.delete(scheduled.values().next().value!);
  const previous = queues.get(message.threadId) ?? Promise.resolve();
  const next = previous.then(() => handleWithFailure(
    () => handle(message),
    error => post(message.threadId,'text',visibleFailure(error),message.privateTo),
    error => console.error('[handle 실패]',error),
  )).catch(e => {scheduled.delete(message.id);console.error('[오류 전달 실패]', e);});
  queues.set(message.threadId, next);
  void next.finally(() => { if (queues.get(message.threadId) === next) queues.delete(message.threadId); });
}

async function listen(): Promise<void> {
  // client=daemon&protocol=resource-access-v2 을 밝힌다. 서버는 이 연결이 끊기는 것으로 데몬이 죽은 것을 안다 —
  // 갑자기 죽으면 online:false 를 보낼 기회가 없다.
  const res = await fetch(`${config.serverUrl}/api/events?client=daemon&protocol=resource-access-v2`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!res.ok || res.body === null) throw new Error(`SSE 연결 실패: ${res.status}`);

  console.log(`구독 시작 — ${config.agentName} (${config.serverUrl})`);
  // 붙을 때마다 다시 보고한다. 서버가 재시작해 기억을 잃었어도 몇 초 안에 채워진다.
  void report();
  void syncGithub();
  void resumeResources();
  void restoreReminders().catch(e => console.error('[리마인드 복원 실패]', e.message));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line === undefined) continue;

      try {
        const event = JSON.parse(line.slice('data: '.length)) as ServerEvent;
        if(event.type==='resources-changed'){void resumeResources();continue;}
        if(event.type==='thread-hidden'){forgetThread(event.threadId);continue;}
        if(event.type==='threads-changed'){void restoreReminders().catch(()=>{});continue;}
        if (event.type === 'agent') completions.observeAgent(event.state);
        if (event.type === 'thread') {
          if (event.thread.paused) paused.add(event.thread.id);
          else paused.delete(event.thread.id);
        }
        // 설정 변경은 **다음 실행부터** 적용한다. 진행 중인 실행은 handle() 이
        // 시작할 때 잡아 둔 값을 끝까지 쓰므로 건드려지지 않는다.
        if (event.type === 'settings' && applySettings(event.settings)) {
          void report();
        }
        // handle 은 await 하지 않는다. 거부를 잡지 않으면 미처리 거부가 되고,
        // Node 는 그때 프로세스를 종료한다 — post() 의 fetch 는 서버 재시작이나
        // 네트워크 순단만으로도 거부되므로, 잡지 않으면 데몬이 조용히 죽는다.
        if (event.type === 'message') {
          if(hiddenThreads.has(event.message.threadId))continue;
          directNotifications.observe(event.message);
          const incoming=event.message;
          enqueue(incoming);
          reminders.observe(event.message);
          completions.observe(event.message);
          if(event.message.kind==='decision_result' && event.message.decisionRequestId) dismissDecision(event.message.decisionRequestId);
        }
      } catch (e) {
        console.error('이벤트 파싱 실패:', e);
      }
    }
  }
}

// 정상 종료(Ctrl+C, 서비스 중지)에는 스스로 꺼졌다고 알린다. 갑자기 죽는 경우는
// SSE 연결이 끊기는 것으로 서버가 알아채므로 여기서 다 잡을 필요는 없다.
let quitting = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (quitting) process.exit(0); // 두 번째 Ctrl+C 는 기다리지 않는다
    quitting = true;
    console.log('\n종료합니다.');
    void report(false).finally(() => process.exit(0));
  });
}

// 첫 보고. 서버가 보관 중인 도구·모델 설정도 이 왕복에서 함께 받아 적용한다.
await report();

for (;;) {
  try {
    await listen();
    console.log('연결이 끊겼습니다. 3초 후 재연결.');
  } catch (e) {
    console.error('연결 오류:', (e as Error).message, '— 3초 후 재시도');
  }
  await new Promise((r) => setTimeout(r, 3000));
}
