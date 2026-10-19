import {duplicateDecision} from './duplicate-decision.ts';
import {randomUUID,createHash} from 'node:crypto';
import {activeContextMessages,contextProvenance} from './context-provenance.ts';
import {mountTopicTasks} from './topic-tasks.ts';
import {mountResourceRoutes} from './resource-routes.ts';
import {GithubReadError} from '../shared/github-read.ts';
import {FileReadGrants} from './file-read-grants.ts';
import {approvedFileResult} from './approved-file-result.ts';
import {connectionReadiness,pendingFileQuestion} from './github-readiness.ts';
import {DaemonConnections} from './daemon-connections.ts';
import {GithubIdentities} from './github-identity.ts';
import {extractMentions} from '../shared/mentions.ts';
import {sensitiveRequest,hasSecret} from './content-safety.ts';
import {directForLegacyDaemon, directEvent} from './direct-delivery.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthorType, Message, MessageKind, ExecutionInfo, AgentState, ServerEvent, Thread } from '../shared/types.ts';
import {
  hideThread, listVisibleThreads, createThread, listThreads, getThread, addMessage, listMessages, findUserByToken, createUser,
  canAccessThread, verifyLogin, setResolved, getSettings, setSettings, listMembers,
} from './db.ts';
import { onAgentMessage, onHumanMessage, resumeThread } from './autoflow.ts';
import { addClient, broadcast } from './sse.ts';
import { reportState, listStates, daemonConnected, daemonDisconnected } from './agents.ts';

const KINDS: MessageKind[] = ['text', 'decision_request', 'decision_result', 'summary'];

/**
 * 도구·모델 이름처럼 "골랐거나 안 골랐거나" 인 값. 빈 값과 null 은 "정하지 않음"(null),
 * 그 외에는 짧은 한 줄 이름만 받는다. 잘못된 값이면 undefined 를 돌려 호출부가 400 을 낸다.
 * 공백과 경로 구분자를 막아, 저장된 값이 나중에 명령이나 경로로 쓰이지 않게 한다.
 */
function optionValue(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s === '') return null;
  if (s.length > 40 || /[\s\\/]/.test(s)) return undefined;
  return s;
}

export function buildApp(db: DatabaseSync, options: {securityLock?:boolean; github?:GithubIdentities} = {}) {
  const connections=new DaemonConnections();
  const app = express();
  app.use(express.json());

  function visibleThread(thread: Thread, user: string) {
    const messages = listMessages(db, thread.id, user);
    const answered = new Set(messages.filter(m => m.kind === 'decision_result').map(m => m.decisionRequestId));
    return {...thread, activity: {
      decisionCount: messages.filter(m => m.kind === 'decision_request' && m.author === user && !answered.has(m.id)).length+resources.list(user,thread.id).filter(r=>r.owner===user&&r.status==='waiting-owner').length,
      lastReplyId: messages.findLast(m => m.authorType === 'agent' && (m.kind === 'text' || m.kind === 'summary'))?.id ?? 0,
    }};
  }
  function visibleState(state: AgentState, user: string): AgentState {
    return state.busyThreadId && !canAccessThread(db, state.busyThreadId, user)
      ? {...state, busyThreadId: null} : state;
  }
  const fileReadGrants=new FileReadGrants();
  db.exec('CREATE TABLE IF NOT EXISTS github_sharing(thread_id TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, audience TEXT NOT NULL, PRIMARY KEY(thread_id,owner,repo));');
  const githubReadGrants=new Map<string,{owner:string;thread:string;audience:string[];binding:string;bindingOwners?:string[];expiresAt:number}>();
  function isHidden(thread:string,user:string){return Boolean(db.prepare('SELECT 1 FROM hidden_threads WHERE thread_id=? AND user_name=?').get(thread,user));}
  function visibleEvent(event: ServerEvent, user: string): ServerEvent | null {
    if(event.type==='tasks-changed')return canAccessThread(db,event.threadId,user)&&!isHidden(event.threadId,user)?event:null;
    if(event.type==='resources-changed')return event.owner===user?event:null;
    if(event.type==='message'&&event.message.resourceAudience&&!event.message.resourceAudience.includes(user))return null;
    if(event.type==='message'&&isHidden(event.message.threadId,user)&&!(event.message.kind==='decision_result'&&event.message.author===user))return null;
    if(event.type==='thread'&&isHidden(event.thread.id,user))return null;
    if (event.type === 'thread') return canAccessThread(db, event.thread.id, user) ? {...event, thread: visibleThread(event.thread, user)} : null;
    if (event.type === 'message' && (!canAccessThread(db, event.message.threadId, user) ||
      (event.message.privateTo !== null && event.message.privateTo !== user))) return null;
    if (event.type === 'agent') return {...event, state: visibleState(event.state, user)};
    return event;
  }

  // 가입은 인증 앞에 둔다 — 토큰이 없는 사람이 쓰는 유일한 경로다.
  app.post('/api/signup', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (name === '') {
      res.status(400).json({ error: '이름이 비어 있습니다' });
      return;
    }
    // @멘션으로 부를 수 있어야 하므로 mentions.ts 의 문자 집합과 같아야 한다.
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
      res.status(400).json({ error: '이름에는 글자·숫자·_·- 만 쓸 수 있습니다 (공백 불가)' });
      return;
    }
    const password = String(req.body?.password ?? '');
    if (password.length < 8) {
      res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
      return;
    }
    const user = createUser(db, name, password);
    if (user === null) {
      res.status(409).json({ error: '이미 있는 이름입니다' });
      return;
    }
    broadcast({ type: 'members', members: listMembers(db) });
    res.json(user);
  });

  // 로그인도 가입과 같은 이유로 인증 앞에 둔다 — 유효한 토큰이 없는 사람이 쓰는
  // 경로다. 비밀번호가 맞으면 가입 때 발급된 토큰을 그대로 돌려준다: 비밀번호가
  // 토큰의 복구 수단이 되는 지점이 여기다.
  app.post('/api/login', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const password = String(req.body?.password ?? '');
    const result = verifyLogin(db, name, password);
    if (result === null) {
      // 틀린 비밀번호와 없는 이름을 구분하지 않는다 — 구분하면 이름 존재 여부를
      // 알아낼 수 있다.
      res.status(401).json({ error: '이름 또는 비밀번호가 맞지 않습니다' });
      return;
    }
    res.json(result);
  });

  // 인증: Bearer 토큰 하나. 사내망 전용이라 이 이상 두지 않는다.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    // EventSource 는 헤더를 못 붙인다. SSE 경로에 한해 쿼리 토큰을 허용한다.
    const query = req.path === '/events' ? String(req.query.token ?? '') : '';
    const token = bearer || query;
    const name = token ? findUserByToken(db, token) : null;
    if (name === null) {
      res.status(401).json({ error: '인증 실패' });
      return;
    }
    res.locals.user = name;
    // 클라이언트가 자기 이름을 알아야 혼잣말 대상을 자기 자신으로 지정할 수 있다.
    // 헤더 값은 라틴1 범위만 허용되므로(한글 이름은 그대로 못 들어간다) 인코딩해 싣는다.
    res.set('X-User', encodeURIComponent(name));
    next();
  });

  const resources=mountResourceRoutes(app,db,{broadcast:event=>broadcast(event,event.owner)});
  const topics=mountTopicTasks(app,db,threadId=>broadcast({type:'tasks-changed',threadId}));
  app.get('/api/capabilities',(_req,res)=>res.json({resourceAccess:2,githubOptional:true}));

  app.post('/api/github/resolve',async(req,res)=>{if(!options.github){res.status(503).json({code:'UNAVAILABLE',error:'GitHub 연결 준비 중입니다'});return;}try{res.json(await options.github.resolveRepository(res.locals.user,req.body?.envelope));}catch(e){res.status(403).json({code:e instanceof GithubReadError?e.code:'VERIFICATION_FAILED',error:e instanceof GithubReadError?e.message:'GitHub 저장소 확인에 실패했습니다'});}});
  app.post('/api/github/challenge',(_req,res)=>{
    if(!options.github){res.status(503).json({error:'GitHub 연결 준비 중'});return;}
    res.json(options.github.challenge(res.locals.user));
  });
  app.post('/api/github/connect',async(req,res)=>{
    if(!options.github){res.status(503).json({error:'GitHub 연결 준비 중'});return;}
    try{res.json(await options.github.connect(res.locals.user,req.body?.envelope));}
    catch{res.status(400).json({error:'GitHub 연결 확인에 실패했습니다. 다시 로그인해 주세요'});}
  });
  app.delete('/api/github/connect',(_req,res)=>{options.github?.disconnect(res.locals.user);res.json({ok:true});});
  app.get('/api/github/status',(_req,res)=>{res.json(options.github?.get(res.locals.user)??null);});

  app.get('/api/hidden-threads',(_req,res)=>{res.json(db.prepare('SELECT thread_id FROM hidden_threads WHERE user_name=?').all(res.locals.user).map(r=>r.thread_id));});

  app.get('/api/threads', (_req, res) => {
    res.json(listVisibleThreads(db, res.locals.user).map(t => visibleThread(t, res.locals.user)));
  });

  // 읽음/창 닫기는 답변이 아니다. 저장된 결정 결과가 있을 때만 요청함에서 빠진다.
  app.get('/api/decisions', (_req, res) => {
    const me = res.locals.user as string;
    const pending = listVisibleThreads(db, me).flatMap(thread => {
      const messages = listMessages(db, thread.id, me);
      const answered = new Set(messages.filter(m => m.kind === 'decision_result').map(m => m.decisionRequestId));
      return messages.filter(m => m.kind === 'decision_request' && m.author === me && !answered.has(m.id))
        .map(request => ({request, threadTitle: thread.title,
          context: messages.filter(m => m.id < request.id && m.kind === 'text' &&
            (m.privateTo === null || (request.privateTo !== null && m.privateTo === request.privateTo)))
            .slice(-3).map(m => ({author: m.author, body: m.body.slice(0, 1600)})),
        }));
    });
    res.json(pending.sort((a,b) => a.request.id - b.request.id));
  });

  app.post('/api/threads', (req, res) => {
    const title = String(req.body?.title ?? '').trim();
    if (title === '') {
      res.status(400).json({ error: '제목이 비어 있음' });
      return;
    }
    const t = createThread(db, title, res.locals.user);
    broadcast({ type: 'thread', thread: t });
    res.json(t);
  });

  app.use('/api/threads/:id', (req, res, next) => {
    if (!canAccessThread(db, req.params.id, res.locals.user)) {
      res.status(404).json({error:'대화를 찾을 수 없거나 참여 권한이 없습니다'});
      return;
    }
    next();
  });

  app.delete('/api/threads/:id', (req,res)=>{
    db.prepare('DELETE FROM github_sharing WHERE thread_id=? AND owner=?').run(req.params.id,res.locals.user);
    topics.cancelThread(res.locals.user,req.params.id);
    resources.cleanupThread(res.locals.user,req.params.id);
    const cancelled=hideThread(db,req.params.id,res.locals.user);
    for(const message of cancelled) broadcast({type:'message',message},res.locals.user);
    broadcast({type:'thread-hidden',threadId:req.params.id},res.locals.user);
    broadcast({type:'threads-changed'},res.locals.user);
    res.json({ok:true});
  });

  app.get('/api/threads/:id/participants',(req,res)=>{res.json((db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(req.params.id) as {user_name:string}[]).map(x=>x.user_name));});

  app.post('/api/threads/:id/file-read-grant',async(req,res)=>{
    if(options.securityLock){res.status(426).json({error:'새 폴더 공유 기능을 사용하려면 앱 업데이트가 필요합니다'});return;}
    const owner=res.locals.user as string,repo=String(req.body?.repo??''),path=String(req.body?.path??'');
    if(!options.github||!path||path.startsWith('/')||path.includes('..')||path.includes('\\')||path.includes(':')){res.status(400).json({error:'파일 범위를 확인할 수 없습니다'});return;}
    const audience=req.body?.private===true?[owner]:(db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(req.params.id) as {user_name:string}[]).map(x=>x.user_name);
    try {
      const binding=await options.github.readScope(owner,req.body?.envelope,repo,audience);
      res.json({grant:fileReadGrants.issue({owner,thread:req.params.id,repo,path,audience,binding})});
    }catch{res.status(403).json({error:'공통 GitHub 저장소 권한이 확인되지 않았습니다'});}
  });

  app.get('/api/threads/:id/github-readiness',(_req,res)=>res.json({active:false}));

  app.post('/api/threads/:id/github/read',async(req,res)=>{
    if(!options.github){res.status(503).json({code:'UNAVAILABLE',error:'GitHub 연결 준비 중입니다.'});return;}
    const members=()=> (db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(req.params.id) as {user_name:string}[]).map(m=>m.user_name);
    const before=members();
    try{
      const value=await options.github.readRepository(res.locals.user,req.body?.envelope,req.params.id,before,repo=>{const row=db.prepare('SELECT audience FROM github_sharing WHERE thread_id=? AND owner=? AND repo=?').get(req.params.id,res.locals.user,repo);return !!row&&String(row.audience)===JSON.stringify(before);});
      if(JSON.stringify(before)!==JSON.stringify(members()))throw new GithubReadError('AUDIENCE_CHANGED','대화 참여자가 변경되었습니다. 다시 요청해 주세요.');
      for(const [id,g] of githubReadGrants)if(g.expiresAt<=Date.now())githubReadGrants.delete(id);
      const grant=randomUUID();githubReadGrants.set(grant,{owner:res.locals.user,thread:req.params.id,audience:value.audience,binding:value.binding,bindingOwners:value.bindingOwners,expiresAt:Date.now()+10*60*1000});
      res.json({result:value.result,grant,audience:value.audience});
    }catch(error){res.status(403).json({code:error instanceof GithubReadError?error.code:'VERIFICATION_FAILED',error:error instanceof GithubReadError?error.message:'GitHub 조회 권한 확인에 실패했습니다. 연결 상태를 확인해 주세요.'});}
  });

  app.get('/api/threads/:id/github',(req,res)=>{
    const members=db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(req.params.id) as {user_name:string}[];
    if(!options.github){res.status(503).json({error:'GitHub 연결 준비 중'});return;}
    const nonce=String(req.query.nonce??'');if(!/^[a-f0-9-]{36}$/.test(nonce)){res.status(400).json({error:'잘못된 조회'});return;}
    res.json(options.github.signedScope(req.params.id,nonce,members.map(m=>({name:m.user_name,identity:options.github!.get(m.user_name)}))));
  });

  app.get('/api/threads/:id/messages', (req, res) => {
    if (getThread(db, req.params.id) === null) {
      res.status(404).json({ error: '스레드 없음' });
      return;
    }
    const audience=req.query.private==='true'?[res.locals.user]:(db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(req.params.id) as {user_name:string}[]).map(r=>r.user_name);
    res.json((req.query.context==='agent'?activeContextMessages(db,req.params.id,res.locals.user,audience):listMessages(db, req.params.id, res.locals.user as string)).map(directForLegacyDaemon));
  });

  app.post('/api/threads/:id/messages', (req, res) => {
    const threadId = req.params.id;
    const thread = getThread(db, threadId);
    if (thread === null) {
      res.status(404).json({ error: '스레드 없음' });
      return;
    }

    const authorType = req.body?.authorType as AuthorType;
    const kind = req.body?.kind as MessageKind;
    let body = String(req.body?.body ?? '');
    // Preserve approved file bytes, including the final newline used by the digest.
    if (!(authorType==='agent' && /^(?:소유자가 승인한|공통 저장소에서 확인한) 파일 내용: /.test(body))) body=body.trim();

    if(authorType==='agent' && isHidden(threadId,res.locals.user)){res.status(409).json({error:'삭제한 대화에는 에이전트 응답이나 결정 요청을 추가하지 않습니다.'});return;}

    if (authorType !== 'human' && authorType !== 'agent') {
      res.status(400).json({ error: 'authorType 이 잘못됨' });
      return;
    }

    // 일시정지된 스레드에는 에이전트가 더 쓸 수 없다. 사람이 계속을 눌러야 풀린다.
    // 이 검사가 자동 진행 체크포인트를 실제로 강제하는 유일한 지점이다.
    if (authorType === 'agent' && thread.paused) {
      res.status(409).json({ error: '일시정지된 스레드입니다. 사람의 확인이 필요합니다.' });
      return;
    }
    if (!KINDS.includes(kind)) {
      res.status(400).json({ error: 'kind 가 잘못됨' });
      return;
    }
    if (kind === 'summary' && authorType !== 'agent') {
      res.status(400).json({error:'대화 요약은 에이전트만 작성할 수 있습니다'});
      return;
    }
    if (body === '') {
      res.status(400).json({ error: '본문이 비어 있음' });
      return;
    }

    // 사람 메시지의 작성자는 토큰이 정한다. 에이전트는 본문에 이름을 스스로 밝히지만,
    // 그 이름이 토큰의 계정과 같아야 한다 — 아니면 누구든 유효한 토큰 하나로 아무
    // 에이전트 이름이나 사칭해 답을 지어낼 수 있다. 데몬은 자기 소유자의 토큰으로
    // 인증하고 config.agentName 으로 쓰므로(daemon/main.ts) 정상 경로는 항상 같다.
    const author =
      authorType === 'agent' ? String(req.body?.author ?? '').trim() : (res.locals.user as string);
    if (author === '') {
      res.status(400).json({ error: 'author 가 비어 있음' });
      return;
    }
    if (authorType === 'agent' && author !== (res.locals.user as string)) {
      res.status(403).json({
        error:
          `에이전트 이름("${author}")이 토큰이 속한 계정("${res.locals.user}")과 다릅니다 — ` +
          'agentName 은 토큰을 발급받은 계정 이름과 같아야 합니다',
      });
      return;
    }

    // 혼잣말 대상. 사람은 자기 이름만 지정할 수 있다 — 남을 지정해 숨기는 것은 막는다.
    // 에이전트는 원본 질문의 privateTo 를 그대로 싣는 경로이므로 그대로 허용한다.
    const rawPrivateTo = req.body?.privateTo;
    let privateTo: string | null = null;
    if (rawPrivateTo !== undefined && rawPrivateTo !== null) {
      privateTo = String(rawPrivateTo).trim();
      if (privateTo === '') privateTo = null;
    }
    if (authorType === 'human' && privateTo !== null && privateTo !== (res.locals.user as string)) {
      res.status(400).json({ error: '다른 사람을 지정해 숨길 수 없습니다' });
      return;
    }

    const legacyRestricted=authorType==='agent'&&req.get('X-Agent-Protocol')!=='resource-access-v2'&&listMessages(db,threadId,author).some(m=>m.resourceAudience);
    if(options.securityLock && authorType==='agent' && (legacyRestricted||!['conversation-only-v1','resource-access-v2'].includes(req.get('X-Agent-Protocol')||''))){
      const error='⚠️ 답변 게시가 차단되었습니다. 이 에이전트의 실행 방식이 현재 보안 기준과 호환되지 않습니다. 앱 업데이트가 필요합니다. 기다리지 않으셔도 됩니다.';
      const last=listMessages(db,threadId,author).at(-1);
      if(last?.body!==error || last.author!==author || last.privateTo!==privateTo){
        const notice=addMessage(db,{threadId,author,authorType:'agent',kind:'text',body:error,privateTo});
        broadcast({type:'message',message:notice},notice.privateTo??undefined);
      }
      res.status(423).json({error});return;
    }

    if(options.securityLock&&authorType==='agent'&&req.get('X-Agent-Protocol')!=='resource-access-v2'&&((kind==='decision_request'&&/"fileAccess"\s*:\s*true/.test(body))||/^(소유자가 승인한|공통 저장소에서 확인한) 파일 내용:/.test(body))){res.status(426).json({error:'파일 공유에는 앱 업데이트가 필요합니다'});return;}
    let decisionRequestId: number | undefined;let decisionAudience:string[]|undefined,decisionPolicies:string[]|undefined;
    if (kind === 'decision_request' && authorType !== 'agent') {
      res.status(400).json({error:'결정 요청은 에이전트만 만들 수 있습니다'}); return;
    }
    if (kind === 'decision_result') {
      decisionRequestId = req.body?.decisionRequestId;
      const visible = listMessages(db, threadId, res.locals.user as string);
      const request = visible.find((m) => m.id === decisionRequestId && m.kind === 'decision_request');
      if (!request) { res.status(400).json({error:'결정 요청을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.'}); return; }
      if (authorType !== 'human' || request.author !== res.locals.user) {
        res.status(403).json({error:`${request.author}님만 답할 수 있는 요청입니다`}); return;
      }
      if (visible.some((m) => m.kind === 'decision_result' && m.decisionRequestId === decisionRequestId)) {
        res.status(409).json({error:'이미 답변한 요청입니다'}); return;
      }
      privateTo = request.privateTo;decisionAudience=request.resourceAudience;decisionPolicies=request.resourcePolicyIds;
      try{
        const card=JSON.parse(request.body);const share=card.githubSharing;
        if(share && body==='이 대화에서 저장소 읽기 결과 공유 허용'){
          const members=(db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(threadId) as {user_name:string}[]).map(r=>r.user_name);
          if(typeof share.repo!=='string'||!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(share.repo)||JSON.stringify(share.audience)!==JSON.stringify(members)){res.status(409).json({error:'공유 대상이 바뀌었습니다. 다시 확인해 주세요'});return;}
          db.prepare('INSERT INTO github_sharing VALUES(?,?,?,?) ON CONFLICT(thread_id,owner,repo) DO UPDATE SET audience=excluded.audience').run(threadId,res.locals.user,share.repo,JSON.stringify(members));
        }
      }catch{/* ordinary decision */}

      // 선택 결과도 담당 에이전트가 이어서 처리한다. 구버전 데몬도 멘션으로 인식한다.
      body = `@${request.author} ${body}`;
    }
    let execution: ExecutionInfo | undefined;
    const reported = req.body?.execution;
    if (authorType === 'agent' && reported && typeof reported === 'object') {
      execution = {
        tool: typeof reported.tool === 'string' ? reported.tool.slice(0,40) : '',
        requestedModel: typeof reported.requestedModel === 'string' ? reported.requestedModel.slice(0,80) : null,
        observedModels: Array.isArray(reported.observedModels) ? reported.observedModels.filter((m:unknown)=>typeof m==='string').slice(0,8).map((m:string)=>m.slice(0,80)) : [],
        source: ['response','session'].includes(reported.source) ? reported.source : 'unavailable',
      };
    }
    const directRequested=req.body?.deliveryMode==='direct'||req.body?.direct===true;
    if(authorType==='human'&&kind==='text'&&!directRequested&&!privateTo&&extractMentions(body).some(name=>isHidden(threadId,name))){res.status(409).json({error:'요청 대상이 현재 이 대화에서 에이전트 요청을 받지 않습니다. 새 대화에서 다시 요청해 주세요.'});return;}
    if (!privateTo && hasSecret(body)) {res.status(422).json({error:'인증 정보로 보이는 내용이 포함되어 전송을 차단했습니다. 비밀 값을 제거해 주세요.'});return;}
    const participants=(db.prepare('SELECT user_name FROM thread_members WHERE thread_id=? ORDER BY user_name').all(threadId) as {user_name:string}[]).map(x=>x.user_name);
    if(authorType==='human' && !privateTo && db.prepare('SELECT 1 FROM file_shared_threads WHERE thread_id=?').get(threadId) && extractMentions(body).some(n=>!participants.includes(n))){res.status(409).json({error:'파일 공유 당시의 참여 범위를 보호하기 위해 새 참여자는 별도 대화에서 초대해 주세요.'});return;}
    if(req.body?.fileAudience!==undefined){
      const audience=req.body.fileAudience;
      if(authorType!=='agent'||!Array.isArray(audience)||audience.some(x=>typeof x!=='string')||JSON.stringify([...audience].sort())!==JSON.stringify(privateTo?[privateTo]:participants)){res.status(409).json({error:'파일 공유 대상이 변경되어 결과 전달을 차단했습니다'});return;}
    }
    if(req.body?.githubReadGrants!==undefined){
      const ids=req.body.githubReadGrants;
      const audience=privateTo?[privateTo]:participants;
      if(authorType!=='agent'||!Array.isArray(ids)||!ids.length||ids.length>8||req.body?.fileAudience===undefined||new Set(ids).size!==ids.length||ids.some(id=>{
        const g=githubReadGrants.get(id);
        return !g||g.owner!==author||g.thread!==threadId||g.expiresAt<=Date.now()||g.binding!==options.github?.binding(g.bindingOwners??audience)||JSON.stringify(g.audience)!==JSON.stringify(audience);
      })){res.status(403).json({error:'GitHub 조회 후 연결 또는 공유 범위가 변경되었습니다. 다시 요청해 주세요.'});return;}
      for(const id of ids)githubReadGrants.delete(id);
    }
    let commonRead=false;
    const resourceIds=req.body?.resourceReceipts;
    if(resourceIds!==undefined && (authorType!=='agent'||req.get('X-Agent-Protocol')!=='resource-access-v2'||!Array.isArray(resourceIds)||!resourceIds.length||resourceIds.length>8||new Set(resourceIds).size!==resourceIds.length)){res.status(400).json({error:'자료 공유 증명이 올바르지 않습니다'});return;}
    if(req.body?.fileReadGrant!==undefined){
      if(req.get('X-Agent-Protocol')==='resource-access-v2'){res.status(403).json({error:'새 공유 권한으로 다시 요청해 주세요'});return;}
      const audience=privateTo?[privateTo]:participants;
      commonRead=authorType==='agent'&&kind==='text'&&req.body?.fileAudience!==undefined&&fileReadGrants.consume(req.body.fileReadGrant,author,threadId,audience,options.github?.binding(audience)??'',body);
      if(!commonRead){res.status(403).json({error:'파일 읽기 권한이 만료되었거나 공유 범위가 변경되었습니다'});return;}
    }
    if (!directRequested && kind==='text') {
      const reason=sensitiveRequest(body);
      const approved=authorType==='agent' && req.body?.fileAudience!==undefined && approvedFileResult(body,listMessages(db,threadId,author),author);
      if(reason&&!approved&&!commonRead&&!resourceIds){res.status(422).json({error:reason});return;}
    }
    if(req.body?.fileAudience!==undefined && !privateTo && !resourceIds)db.prepare('INSERT OR IGNORE INTO file_shared_threads(thread_id) VALUES (?)').run(threadId);
    if(kind==='decision_request'){const previous=duplicateDecision(listMessages(db,threadId,author),author,privateTo,body);if(previous){res.json(previous);return;}}
    const agentTarget=req.body?.agentTarget,agentAction=req.body?.agentAction??'request',replyTo=req.body?.replyTo;
    if(agentTarget!==undefined&&(authorType!=='agent'||typeof agentTarget!=='string'||agentTarget===author||!participants.includes(agentTarget)||!['request','reply'].includes(agentAction)||(agentAction==='request'&&kind!=='text'))){res.status(400).json({error:'에이전트 요청 대상을 확인해 주세요'});return;}
    if(agentAction==='reply'&&agentTarget){const q=listMessages(db,threadId,author).find(m=>m.id===replyTo&&m.author===agentTarget&&m.agentTarget===author&&m.agentAction==='request'&&m.privateTo===privateTo);if(!q){res.status(409).json({error:'응답할 에이전트 요청을 확인할 수 없습니다'});return;}}
    const taskProof=req.body?.task;
    try{if(taskProof)topics.check(author,threadId,taskProof);}catch{res.status(409).json({error:'종료되거나 대체된 요청입니다'});return;}
    db.exec('SAVEPOINT publish_resource');
    let m:Message;
    let resourceAudience:string[]|undefined=decisionAudience,resourcePolicyIds:string[]|undefined=decisionPolicies;
    try{
      if(resourceIds){
        const hash=createHash('sha256').update(body).digest('hex');
        for(const id of resourceIds){const proof=resources.consumeReceipt(author,threadId,id,hash);if(JSON.stringify(proof.audience)!==JSON.stringify(privateTo?[privateTo]:participants))throw Error("자료 공유 대상 불일치");resourceAudience=proof.audience;resourcePolicyIds=[...(resourcePolicyIds??[]),`${proof.policyId}@${proof.revision}`];}
      }
      if(req.body?.contextMessageIds!==undefined){const inherited=contextProvenance(db,threadId,author,req.body.contextMessageIds,privateTo?[privateTo]:participants);if(inherited.resourceAudience){resourceAudience=inherited.resourceAudience;resourcePolicyIds=[...new Set([...(resourcePolicyIds??[]),...(inherited.resourcePolicyIds??[])])];}}
    m = addMessage(db, { threadId, author, authorType, kind, body, privateTo,
      ...(agentTarget?{agentTarget,agentAction,...(replyTo?{replyTo}: {})}:{}),
      ...(resourceAudience?{resourceAudience,resourcePolicyIds}:{}),
      ...((req.body?.deliveryMode === 'direct' || req.body?.direct === true) && authorType === 'human' && kind === 'text' && !privateTo ? {direct:true} : {}),
      ...(execution ? {execution} : {}),
      ...(decisionRequestId === undefined ? {} : {decisionRequestId}) });
    if(taskProof)topics.finish(author,threadId,taskProof,kind==='decision_request'?'waiting-owner':agentTarget&&agentAction==='request'?'waiting-agent':body.startsWith('⚠️')?'failed':'completed',m.id);
    if(kind==='decision_result'&&decisionRequestId)topics.answerDecision(threadId,decisionRequestId);
    if(agentAction==='reply'&&replyTo)topics.answerDelegation(threadId,replyTo);
    db.exec('RELEASE publish_resource');
    }catch{db.exec('ROLLBACK TO publish_resource; RELEASE publish_resource');res.status(409).json({error:'공유 허용 또는 요청 상태가 변경되어 결과를 보내지 않았습니다'});return;}
    const t = authorType === 'agent' ? onAgentMessage(db, threadId) : onHumanMessage(db, threadId);

    // 혼잣말이면 그 사람에게만 실시간으로 전달한다 — 조회뿐 아니라 배달도 서버가 거른다.
    broadcast({ type: 'message', message: m }, m.privateTo ?? undefined);
    broadcast({ type: 'thread', thread: t });
    res.json(m);
  });

  app.post('/api/threads/:id/resolve', (req, res) => {
    const resolved = req.body?.resolved;
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'resolved 가 잘못됨' });
      return;
    }
    const history=listMessages(db,req.params.id,res.locals.user);
    if(resolved&&history.some(m=>m.kind==='decision_request'&&!history.some(r=>r.decisionRequestId===m.id&&r.kind==='decision_result'))){res.status(409).json({error:'아직 응답이 필요한 질문이 있습니다'});return;}
    if(resolved&&(topics.pending(req.params.id)||resources.list(res.locals.user,req.params.id).some(r=>['waiting-owner','waiting-connection','running'].includes(r.status)))){res.status(409).json({error:'아직 응답이나 자료 확인을 기다리는 요청이 있습니다'});return;}
    const t = setResolved(db, req.params.id, resolved);
    if (t === null) {
      res.status(404).json({ error: '스레드 없음' });
      return;
    }
    broadcast({ type: 'thread', thread: t });
    res.json(t);
  });

  app.post('/api/threads/:id/resume', (req, res) => {
    if (getThread(db, req.params.id) === null) {
      res.status(404).json({ error: '스레드 없음' });
      return;
    }
    const t = resumeThread(db, req.params.id);
    broadcast({ type: 'thread', thread: t });
    res.json(t);
  });

  // 화면이 "답하는 중"과 "데몬 꺼짐"을 추측하지 않게 하는 자리. 상태는 전원이 보고
  // (남의 에이전트가 도는지도 보여야 한다), 설정은 자기 것만 본다.
  app.get('/api/agents', (_req, res) => {
    res.json({ members: listMembers(db), agents: listStates().map(state => ({...visibleState(state, res.locals.user),connections:connections.status(state.user)})), settings: getSettings(db, res.locals.user as string) });
  });

  // 데몬이 자기 상태를 올린다. **자기 것만** — 사용자 이름은 토큰이 정하고 본문의
  // 어떤 이름도 쓰지 않는다. 에이전트 메시지에서 막은 사칭 경로를 여기서 다시 열지 않는다.
  app.post('/api/agent/status', (req, res) => {
    const user = res.locals.user as string;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const state = reportState(user, {
      online: b.online !== false,
      availableTools: Array.isArray(b.availableTools)
        ? b.availableTools.filter((t) => typeof t === 'string').slice(0, 20)
        : [],
      configuredTool: typeof b.configuredTool === 'string' ? b.configuredTool : undefined,
      configuredModel: typeof b.configuredModel === 'string' ? b.configuredModel : null,
      tool: typeof b.tool === 'string' ? b.tool : '',
      model: typeof b.model === 'string' && b.model !== '' ? b.model : null,
      busyThreadId: typeof b.busyThreadId === 'string' && b.busyThreadId !== '' ? b.busyThreadId : null,
      toolOk: b.toolOk !== false,
      toolError: typeof b.toolError === 'string' && b.toolError !== '' ? b.toolError : null,
    });
    broadcast({ type: 'agent', state });
    // 설정을 함께 돌려준다 — 데몬이 시작하자마자 한 번의 왕복으로 따라야 할 값을 안다.
    res.json({ state, settings: getSettings(db, user) });
  });

  app.post('/api/agent/settings', (req, res) => {
    const user = res.locals.user as string;
    const tool = optionValue(req.body?.tool);
    const model = optionValue(req.body?.model);
    if (tool === undefined || model === undefined) {
      res.status(400).json({ error: '도구 또는 모델 이름이 잘못되었습니다' });
      return;
    }
    const settings = setSettings(db, user, { tool, model });
    // 그 사람의 데몬과 그 사람의 다른 화면에만 간다 — 남의 설정을 받아볼 이유가 없다.
    broadcast({ type: 'settings', settings }, user);
    res.json(settings);
  });

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
    heartbeat.unref();
    res.on('close', () => clearInterval(heartbeat));
    const user = res.locals.user as string;
    addClient(res, user, event => { if(options.securityLock && req.query.client==='daemon' && !['conversation-only-v1','resource-access-v2'].includes(String(req.query.protocol)) && event.type==='message' && !event.message.direct)return null; if(req.query.client==='daemon' && event.type==='message' && event.message.body.startsWith('⚠️ 답변 게시가 차단되었습니다.'))return null; const visible=visibleEvent(event,user); return visible && String(req.query.client ?? '')==='daemon' ? directEvent(visible,user) : visible; });

    // 데몬임을 밝힌 연결만 센다. 브라우저 탭도 같은 토큰으로 붙으므로 구분이 필요하다.
    // 갑자기 죽은 데몬은 online:false 를 보낼 기회가 없다 — 이 연결이 끊기는 것이
    // 서버가 얻는 유일한 신호다.
    if (String(req.query.client ?? '') === 'daemon') {
      const disconnect=connections.add(user,String(req.query.protocol??''));
      daemonConnected(user);
      res.on('close', () => {
        disconnect();
        const state = daemonDisconnected(user);
        if (state !== null) broadcast({ type: 'agent', state });
      });
    }
  });

  app.use('/downloads/apps', (_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  app.use(express.static('web', {setHeaders(res,path){
    if (/\.(exe|dmg)$/.test(path)) res.setHeader('Content-Disposition','attachment');
  }}));
  return app;
}
