import {createSelectMenu} from './select-menu.js?v=2';
import {createWorkspaceLayout} from './workspace-layout.js?v=1';
import {routeMessage, previousTargets, conversationMembers, mentions as routingMentions} from './routing.js?v=direct-2';
const $ = (id) => document.getElementById(id);

/** 동적 텍스트는 전부 textContent 로만 들어간다. innerHTML 은 이 파일에 없다. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const selectMenus = ['toolSelect','modelSelect'].map(id => createSelectMenu($(id)));
const workspaceLayout = createWorkspaceLayout();

let token = localStorage.getItem('token') ?? '';
let threads = [];
const locallyHiddenThreads = new Set();
let current = null;
let messages = [];
let githubConnected = null;
let myName = ''; // 서버가 응답 헤더로 알려준 내 이름. 혼잣말 대상을 나 자신으로 지정할 때 쓴다.
let privateOn = false;
let members = [];
let agents = [];                            // 데몬들이 보고한 상태
const taskStatesByThread = new Map();
let settings = { tool: null, model: null }; // 내가 고른 도구·모델 (null = 데몬 설정 따름)

const GROUP_GAP_MS = 5 * 60 * 1000;
const SLOW_REPLY_MS = 120 * 1000;

/* ------------------------------------------------------------------ 통신 */

function headers() {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, { ...options, headers: headers() });
  if (!res.ok) {
    if (res.status === 401) throw new Error('토큰이 올바르지 않습니다');
    throw new Error(await res.text());
  }
  // 서버가 매 응답에 내 이름을 인코딩해 실어 준다 — 혼잣말 토글이 자기 이름을 알아야 한다.
  const encoded = res.headers.get('X-User');
  if (encoded) myName = decodeURIComponent(encoded);
  return res.json();
}

function setStatus(kind, text) {
  $('statusDot').className = `dot ${kind}`;
  $('statusText').textContent = text;
}

/* -------------------------------------------------------------- 시작 화면 */

function showStart(message) {
  workspaceLayout.closeNavigation();
  $('accountSettings').open = false;
  $('settingsDialog').close();
  $('startScreen').hidden = false;
  $('sidebar').hidden = true;
  $('main').hidden = true;
  $('startError').textContent = message ?? '';
  $('startError').hidden = !message;
}

function showApp() {
  $('startScreen').hidden = true;
  $('sidebar').hidden = false;
  $('main').hidden = false;
}

function selectTab(name) {
  $('tabSignup').setAttribute('aria-selected', String(name === 'signup'));
  $('tabLogin').setAttribute('aria-selected', String(name === 'login'));
  $('tabToken').setAttribute('aria-selected', String(name === 'token'));
  $('signupForm').hidden = name !== 'signup';
  $('loginForm').hidden = name !== 'login';
  $('tokenForm').hidden = name !== 'token';
}

$('tabSignup').addEventListener('click', () => selectTab('signup'));
$('tabLogin').addEventListener('click', () => selectTab('login'));
$('tabToken').addEventListener('click', () => selectTab('token'));

function setFieldError(id, text) {
  $(id).textContent = text;
  $(id).hidden = text === '';
}

async function postAuth(path, body, failLabel) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('서버에 연결하지 못했습니다. 네트워크 상태를 확인하세요.');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    // 본문이 JSON 이 아니면 아래에서 상태 코드로만 메시지를 만든다.
  }
  if (!res.ok) throw new Error(data.error || `${failLabel} (${res.status})`);
  return data;
}

function signup(name, password) {
  return postAuth('/api/signup', { name, password }, '가입에 실패했습니다');
}

function login(name, password) {
  return postAuth('/api/login', { name, password }, '로그인에 실패했습니다');
}

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('signupName').value.trim();
  const password = $('signupPassword').value;
  setFieldError('signupError', '');
  if (name === '') {
    setFieldError('signupError', '이름을 입력하세요');
    return;
  }
  try {
    const user = await signup(name, password);
    token = user.token;
    localStorage.setItem('token', token);
    $('startAuth').hidden = true;
    $('revealedToken').textContent = user.token;
    $('copyStatus').textContent = '';
    $('tokenReveal').hidden = false;
  } catch (err) {
    setFieldError('signupError', err.message);
  }
});

// navigator.clipboard 는 보안 컨텍스트(HTTPS 또는 localhost)에서만 존재한다.
// LAN 의 평범한 HTTP 배포([예: 192.168.x.x:3000])에서는 아예 없다 — 그럴 때는
// 토큰 텍스트를 선택 상태로 만들어 사용자가 바로 ⌘C/Ctrl+C 를 누르게 한다.
// 선택은 어떤 브라우저·컨텍스트에서도 동작하는 유일한 보장이다.
function selectText(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function copyToken(tokenEl, statusEl) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(tokenEl.textContent);
      statusEl.textContent = '복사했습니다';
      return;
    } catch {
      // 클립보드 API 가 있어도 권한 등으로 실패할 수 있다 — 아래 선택 방식으로 넘어간다.
    }
  }
  selectText(tokenEl);
  let copied = false;
  try {
    copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    copied = false;
  }
  statusEl.textContent = copied
    ? '복사했습니다'
    : '토큰을 선택해 두었습니다. ⌘C(또는 Ctrl+C)로 복사하세요.';
}

$('copyTokenBtn').addEventListener('click', () => copyToken($('revealedToken'), $('copyStatus')));

$('continueBtn').addEventListener('click', () => {
  $('tokenReveal').hidden = true;
  $('startAuth').hidden = false;
  showApp();
  start();
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('loginName').value.trim();
  const password = $('loginPassword').value;
  setFieldError('loginError', '');
  if (name === '' || password === '') {
    setFieldError('loginError', '이름과 비밀번호를 입력하세요');
    return;
  }
  try {
    const user = await login(name, password);
    token = user.token;
    localStorage.setItem('token', token);
    showApp();
    start();
  } catch (err) {
    setFieldError('loginError', err.message);
  }
});

$('tokenForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('tokenValue').value.trim();
  setFieldError('tokenError', '');
  if (value === '') {
    setFieldError('tokenError', '토큰을 입력하세요');
    return;
  }
  token = value;
  localStorage.setItem('token', token);
  showApp();
  start();
});

function logout(message) {
  locallyHiddenThreads.clear();
  taskStatesByThread.clear();
  $('sharingPolicies').replaceChildren();
  $('sharingAudience').replaceChildren();
  $('sharingConfirm').checked = false;
  $('resourceRequests').replaceChildren();
  $('resourceRequests').hidden = true;
  if (es) {
    es.close();
    es = null;
  }
  localStorage.removeItem('token');
  token = '';
  threads = [];
  current = null;
  messages = [];
  myName = '';
  agents = [];
  members = [];
  settings = { tool: null, model: null };
  setSettingsNote('');
  setPrivate(false);
  $('tokenValue').value = '';
  $('signupName').value = '';
  $('signupPassword').value = '';
  $('loginName').value = '';
  $('loginPassword').value = '';
  $('sidebarTokenBox').hidden = true;
  $('showTokenBtn').textContent = '데몬 토큰 보기';
  $('sidebarCopyStatus').textContent = '';
  selectTab('signup');
  showStart(message);
}

$('logoutBtn').addEventListener('click', () => logout());

// 가입 때 토큰을 놓쳐도 여기서 다시 볼 수 있다 — 비밀번호로 로그인하면
// 언제든 열 수 있다. 이 화면이 토큰 분실 문제를 없애는 지점이다.
$('showTokenBtn').addEventListener('click', () => {
  const box = $('sidebarTokenBox');
  box.hidden = !box.hidden;
  $('showTokenBtn').textContent = box.hidden ? '데몬 토큰 보기' : '숨기기';
  if (!box.hidden) {
    $('sidebarToken').textContent = token;
    $('sidebarCopyStatus').textContent = '';
  }
});

$('sidebarCopyBtn').addEventListener('click', () => copyToken($('sidebarToken'), $('sidebarCopyStatus')));

/* ------------------------------------------------------------ 시간 표시 */

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
}

function dayOf(iso) {
  return new Date(iso).toLocaleDateString('ko-KR', {
    month: 'long', day: 'numeric', weekday: 'long',
  });
}

/* -------------------------------------------------------------- 스레드 */

// 해결된 스레드는 지우지 않는다 — 흐리게 표시하고 목록 아래로 모은다.
function readKey(id) { return `readReply:${myName}:${id}`; }
function markCurrentRead() {
  if (!current || document.hidden || !document.hasFocus()) return;
  const last = messages.findLast(m => m.authorType === 'agent' && ['text','summary'].includes(m.kind));
  if (last) localStorage.setItem(readKey(current.id), String(last.id));
}
window.addEventListener('focus', () => { markCurrentRead(); renderThreads(); });
document.addEventListener('visibilitychange', () => { markCurrentRead(); renderThreads(); });
window.addEventListener('storage', e => { if (e.key?.startsWith('readReply:')) renderThreads(); });

function renderThreadRow(list, t) {
  const btn = el('button', `thread${t.resolved ? ' resolved' : ''}`);
  btn.type = 'button';
  if (t.id === current?.id) btn.setAttribute('aria-current', 'true');
  btn.appendChild(el('span', 'title', t.title));
  const deciding = t.activity?.decisionCount || 0;
  const tasks = latestThreadTasks(t.id);
  const busy = tasks.some(task => task.state === 'running') || agents.some(a => a.online && a.busyThreadId === t.id && !tasks.some(task => task.owner === a.user));
  const waiting = tasks.some(task => task.state.startsWith('waiting-'));
  const unread = (t.activity?.lastReplyId || 0) > Number(localStorage.getItem(readKey(t.id)) || 0);
  const state = waiting ? ['needs-decision', '에이전트 확인 또는 연결 대기', '!'] : deciding ? ['needs-decision', `내 결정 필요 ${deciding}건`, '!'] :
    busy ? ['working', '에이전트 작업 중', ''] : unread ? ['unread', '새 답변 도착 · 아직 확인하지 않음', '✓'] : null;
  if (state) {
    const icon = el('span', `thread-activity ${state[0]}`, state[2]);
    icon.setAttribute('aria-hidden', 'true');
    btn.title = state[1];
    btn.setAttribute('aria-label', `${t.title} · ${state[1]}${t.resolved ? ' · 해결됨' : ''}`);
    btn.appendChild(icon);
  }
  if (t.resolved && !waiting && !busy) btn.appendChild(el('span', 'flag muted', '해결됨'));
  else if (t.paused) btn.appendChild(el('span', 'flag', '확인 필요'));
  btn.addEventListener('click', () => openThread(t.id));
  list.appendChild(btn);
}

function renderThreads() {
  const list = $('threads');
  list.textContent = '';

  if (threads.length === 0) {
    list.appendChild(el('p', 'list-empty', '아직 대화가 없습니다'));
    return;
  }

  const active = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  for (const t of active) renderThreadRow(list, t);

  if (resolved.length > 0) {
    list.appendChild(el('p', 'thread-group-label', '해결됨'));
    for (const t of resolved) renderThreadRow(list, t);
  }
}

function renderThreadState() {
  const header = $('threadHeader');
  header.hidden = current === null;
  $('composer').hidden = current === null;
  renderMentionTarget();
  if (current === null) {
    $('banner').hidden = true;
    return;
  }

  $('threadTitle').textContent = current.title;
  $('threadTitle').title = current.title;
  $('threadMeta').textContent =
    current.autoTurns > 0 ? `자동 진행 ${current.autoTurns}/20턴` : '';
  $('resolveBtn').textContent = current.resolved ? '다시 열기' : '해결됨';

  $('banner').hidden = !current.paused;
  if (current.paused) {
    $('bannerText').textContent =
      `에이전트가 ${current.autoTurns}턴 동안 사람 확인 없이 주고받았습니다. 계속할까요?`;
  }
}

/* ------------------------------------------------------- 본문 렌더링 */

// ``` 로 감싼 코드 블록.
const FENCE = /```[\w+-]*\n?([\s\S]*?)```/g;

// 인라인: `코드` | 파일 경로(예: src/payment/approve.ts:42, /payments/approve) | @멘션.
// 경로는 앞에 \w / : . - @ 가 오면 잡지 않는다 — URL 안쪽을 잘라 먹지 않기 위해서다.
const INLINE =
  /(`[^`\n]+`)|((?<![\w/:.@-])[\w.~@-]*(?:\/[\w.@-]+)+(?::\d+)?)|((?<![^\s])@[\p{L}\p{N}_-]+)/gu;

function appendInline(parent, text) {
  if (text === '') return;
  INLINE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = INLINE.lastIndex;

    if (m[1]) {
      parent.appendChild(el('code', null, m[0].slice(1, -1)));
      continue;
    }
    if (m[3]) {
      parent.appendChild(el('span', 'mention', m[0]));
      continue;
    }
    // 문장 끝 구두점은 경로에서 떼어 낸다.
    let tok = m[0];
    const trail = tok.match(/[.,;:)\]]+$/);
    if (trail) tok = tok.slice(0, -trail[0].length);
    if (tok.includes('/')) parent.appendChild(el('code', 'path', tok));
    else parent.appendChild(document.createTextNode(tok));
    if (trail) parent.appendChild(document.createTextNode(trail[0]));
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function renderBody(text) {
  const box = el('div', 'body');
  FENCE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = FENCE.exec(text)) !== null) {
    appendInline(box, text.slice(last, m.index).replace(/\n$/, ''));
    const pre = el('pre');
    pre.appendChild(el('code', null, m[1].replace(/\n$/, '')));
    box.appendChild(pre);
    last = FENCE.lastIndex;
  }
  appendInline(box, text.slice(last).replace(/^\n/, ''));
  if (/github/i.test(text) && /연결|로그인/.test(text)) {
    const actions = el('div', 'message-actions github-login-action');
    actions.hidden = githubConnected !== false;
    const connect = el('button', 'btn-quiet', 'GitHub 연결하기');
    connect.type = 'button';
    connect.addEventListener('click', () => { $('accountSettings').open = true; $('githubConnect').click(); });
    actions.appendChild(connect);
    box.appendChild(actions);
  }
  return box;
}

/* --------------------------------------------------------- 결정 요청 */

function renderDecision(m) {
  const box = el('div', 'decision');
  let parsed;
  try {
    parsed = JSON.parse(m.body);
  } catch {
    return renderBody(m.body);
  }

  box.appendChild(el('p', 'question', String(parsed.question ?? '')));
  if (typeof parsed.summary === 'string' && parsed.summary) box.appendChild(el('p', 'decision-summary', parsed.summary));
  if (typeof parsed.recommendation === 'string' && parsed.recommendation) box.appendChild(el('p', 'decision-summary', `추천: ${parsed.recommendation}`));

  // 이 요청 뒤에 이미 답이 있으면 버튼 대신 고른 값을 보여 준다.
  const answer = messages.find((x) => x.kind === 'decision_result' && x.decisionRequestId === m.id);
  if (answer) {
    box.appendChild(el('p', 'chosen', `✓ 결정됨 · ${answer.author}님: ${answer.body.replace(/^@[^\s]+\s*/, '')}`));
    return box;
  }

  if (m.author !== myName) {
    box.appendChild(el('p', 'chosen', `${m.author}님 답변 대기 중`));
    return box;
  }

  if (parsed.fileAccess && /GitHub/.test(parsed.summary || '')) {
    const connect = el('button', 'btn-quiet', 'GitHub 연결 확인하기');
    connect.type = 'button';
    connect.addEventListener('click', () => { $('accountSettings').open = true; $('githubConnect').click(); });
    const connectionActions = el('div', 'decision-connection github-login-action');
    connectionActions.hidden = githubConnected !== false;
    connectionActions.appendChild(connect);
    box.appendChild(connectionActions);
  }

  const options = el('div', 'options');
  for (const opt of Array.isArray(parsed.options) ? parsed.options : []) {
    const btn = el('button', 'btn-quiet', String(opt));
    btn.type = 'button';
    // 요청이 혼잣말이었으면 답도 같은 대상에게만 — 공개로 새면 맥락 없는 답만 보인다.
    btn.addEventListener('click', () => sendMessage(String(opt), 'decision_result', m.privateTo, m.id));
    options.appendChild(btn);
  }
  box.appendChild(options);
  const custom = el('form', 'decision-custom');
  const input = el('input', 'field');
  input.placeholder = '다른 답변을 직접 입력하세요';
  input.setAttribute('aria-label', '결정 요청에 직접 답변');
  input.required = true;
  const submit = el('button', 'btn', '답변 보내기');
  submit.type = 'submit';
  custom.append(input, submit);
  custom.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.trim()) sendMessage(input.value.trim(), 'decision_result', m.privateTo, m.id);
  });
  box.appendChild(custom);
  return box;
}

/* ------------------------------------------------------------ 메시지 */

function nearBottom() {
  const s = $('scroll');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

let unseenMessages = 0;
let summaryScrollTop = 0;
function updateLatestMessage() {
  const bottom = nearBottom();
  if (bottom) unseenMessages = 0;
  $('latestMessage').hidden = !current || bottom || !messages.length;
  $('latestMessage').textContent = unseenMessages ? `새 메시지 ${unseenMessages}개 · 최신 대화로 이동 ↓` : '최신 대화로 이동 ↓';
}
$('summaryToggle').addEventListener('click', () => {
  const expanded = $('summaryToggle').getAttribute('aria-expanded') !== 'true';
  if (expanded) summaryScrollTop = $('scroll').scrollTop;
  $('summaryToggle').setAttribute('aria-expanded', String(expanded));
  $('sharedSummary').hidden = !expanded;
  $('scroll').scrollTop = expanded ? 0 : summaryScrollTop;
  updateLatestMessage();
});
$('scroll').addEventListener('scroll', updateLatestMessage, {passive:true});
$('latestMessage').addEventListener('click', scrollToBottom);
function scrollToBottom() {
  $('scroll').scrollTop = $('scroll').scrollHeight;
  unseenMessages = 0;
  updateLatestMessage();
}

function showEmpty(title, lines, actionLabel, onAction) {
  const box = el('div', 'empty');
  box.appendChild(el('h2', null, title));
  for (const line of lines) {
    const p = el('p');
    appendInline(p, line);
    box.appendChild(p);
  }
  if (actionLabel) {
    const btn = el('button', 'btn', actionLabel);
    btn.type = 'button';
    btn.addEventListener('click', onAction);
    box.appendChild(btn);
  }
  $('messages').appendChild(box);
}

function renderMessages() {
  renderMentionTarget();
  markCurrentRead();
  renderThreads();
  const publicMessages = messages.filter(m => m.privateTo === null);
  const latestSummary = publicMessages.findLast(m => m.kind === 'summary');
  const decisions = publicMessages.filter(m => m.kind === 'decision_result' &&
    publicMessages.some(r => r.id === m.decisionRequestId && r.kind === 'decision_request'));
  const hasSummary = Boolean(latestSummary || decisions.length);
  $('summaryToggle').hidden = !hasSummary;
  $('sharedSummary').hidden = !hasSummary || $('summaryToggle').getAttribute('aria-expanded') !== 'true';
  $('sharedDecisions').replaceChildren();
  for (const answer of decisions) {
    const request = publicMessages.find(r => r.id === answer.decisionRequestId);
    let question = ''; try { question = JSON.parse(request.body).question || ''; } catch {}
    const item = el('div', 'agreed-decision');
    item.append(el('span', 'decision-badge', '✓ 결정됨'), el('p', null, question),
      el('p', 'decision-answer', `${answer.author}님: ${answer.body.replace(/^@[^\s]+\s*/, '')}`));
    $('sharedDecisions').append(item);
  }
  $('sharedSummaryBody').textContent = '';
  $('sharedSummaryTitle').textContent = decisions.length ? `결정된 내용 ${decisions.length}건 · 대화 정리` : '대화 정리';
  if (latestSummary) {
    if (!decisions.length) $('sharedSummaryTitle').textContent = publicMessages.at(-1)?.id === latestSummary.id ? '대화 정리' : '이전 대화 정리 · 이후 대화가 이어졌어요';
    $('sharedSummaryBody').textContent = latestSummary.body;
  }

  const stick = nearBottom();
  const previousTop = $('scroll').scrollTop;
  $('messages').textContent = '';

  if (current === null) {
    showEmpty(
      threads.length === 0 ? '첫 대화를 시작해 보세요' : '대화를 선택해 주세요',
      threads.length === 0
        ? ['궁금한 주제로 새 대화를 시작할 수 있습니다.',
           '질문에 @예제동료 처럼 상대 이름을 붙이면 그 사람의 에이전트가 코드를 읽고 답합니다.']
        : ['대화 목록에서 기존 대화를 선택하거나 새 대화를 시작해 보세요.'],
      '새 대화 시작',
      startNewThread,
    );
    updatePending();
    return;
  }

  if (messages.length === 0) {
    showEmpty('아직 대화가 없습니다', [
      '@예제동료 처럼 상대 이름을 부르며 질문하면 그 사람의 에이전트가 허용된 자료를 읽고 답합니다.',
      '파일 경로와 코드는 그대로 붙여 넣어도 됩니다.',
    ], null, null);
    $('input').focus();
    updatePending();
    return;
  }

  let prev = null;
  for (const m of messages) {
    if (prev === null || dayOf(prev.createdAt) !== dayOf(m.createdAt)) {
      $('messages').appendChild(el('div', 'day', dayOf(m.createdAt)));
      prev = null;
    }

    const grouped =
      prev !== null &&
      prev.author === m.author &&
      prev.authorType === m.authorType &&
      prev.privateTo === m.privateTo &&
      prev.kind === 'text' && m.kind === 'text' &&
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_GAP_MS;

    const art = el('article', `msg ${m.authorType}${m.privateTo ? ' private' : ''}${grouped ? ' cont' : ''}`);
    if (!grouped) {
      const meta = el('div', 'meta');
      const avatar = el('span', 'message-avatar', m.authorType === 'agent' ? 'AI' : [...m.author][0]);
      avatar.setAttribute('aria-hidden', 'true');
      meta.appendChild(avatar);
      meta.appendChild(el('span', 'name', m.author));
      if (m.authorType === 'agent') meta.appendChild(el('span', 'role', '에이전트'));
      if (m.privateTo) meta.appendChild(el('span', 'role lock-badge', '🔒 나만 보임'));
      const t = el('time', 'time', timeOf(m.createdAt));
      t.dateTime = m.createdAt;
      meta.appendChild(t);
      art.appendChild(meta);
    }

    if (m.authorType === 'agent' && m.execution) {
      const info = m.execution;
      const observed = info.observedModels.join(', ');
      const evidence = info.source === 'response' ? `응답에서 확인: ${observed || '미제공'}` :
        info.source === 'session' ? `CLI 실행 기록: ${observed || '미제공'} (서버 응답 모델 정보 없음)` : '실행 결과의 모델 정보 없음';
      const audit = el('p', 'model-evidence', `요청: ${info.requestedModel ?? '미기록'} · ${evidence}`);
      if (observed && !info.observedModels.includes(info.requestedModel)) {
        audit.classList.add('warn');
        audit.appendChild(document.createTextNode(' · 요청 모델과 확인된 모델이 다릅니다'));
      }
      art.appendChild(audit);
    }
    if (m.kind === 'summary') art.appendChild(el('p', 'summary-label', m.privateTo ? '혼잣말 요약 · 나만 볼 수 있어요' : '대화 요약 · 함께 볼 수 있어요'));
    art.appendChild(m.kind === 'decision_request' ? renderDecision(m) : renderBody(m.body));
    $('messages').appendChild(art);
    prev = m;
  }

  updatePending();
  if (stick) scrollToBottom();
  else { $('scroll').scrollTop = previousTop; updateLatestMessage(); }
}

/* --------------------------------------------------- 에이전트 실행 중 */

const MENTION = /(?<![^\s])@([\p{L}\p{N}_-]+)/gu;

function agentOf(name) {
  return agents.find((a) => a.user === name) ?? null;
}

/** 그 사람의 데몬이 지금 돌고 있는가. 보고가 없으면 꺼진 것으로 본다. */
function agentOnline(name) {
  return agentOf(name)?.online === true;
}

function mentionedIn(text) {
  MENTION.lastIndex = 0;
  return [...text.matchAll(MENTION)].map((m) => m[1]);
}

/**
 * 화면 아래 진행 표시에 무엇을 쓸지 정한다.
 *
 * 예전에는 추측이었다 — 마지막 메시지가 사람의 멘션이면 무조건 "답하는 중". 데몬이
 * 꺼져 있어도 똑같이 보여서, 사용자가 "답을 하고 있는 건지 모르겠다" 고 한 상황이
 * 정확히 이것이었다. 이제 데몬이 보고한 사실을 먼저 쓰고, 꺼져 있으면 꺼졌다고 쓴다.
 */
function pendingInfo() {
  if (!current) return null;
  const tasks = typeof taskStatesByThread === 'undefined' ? [] : taskStatesByThread.get(current.id) ?? [];
  const latest = new Map();
  const privateScope = privateOn || messages[messages.length - 1]?.privateTo === myName;
  for (const task of tasks) {
    if (privateScope && task.owner !== myName) continue;
    const message = messages.find(message => message.id === task.messageId);
    if (message?.privateTo && message.privateTo !== myName) continue;
    const previous = latest.get(task.owner);
    if (!previous || task.messageId >= previous.messageId) latest.set(task.owner, task);
  }
  const legacy = legacyPendingInfo();
  if (!latest.size) return legacy;
  const fallback = legacy ? (legacy.items ?? legacy.who.split(', ').map(who => ({...legacy, who}))).filter(item => !latest.has(item.who)) : [];
  const items = [...latest.values()].map(task => ({who:task.owner, state:task.state, reason:task.reason, running:task.state === 'running'}));
  items.push(...fallback);
  return {items, who:items.map(item => item.who).join(', ')};
}

function legacyPendingInfo() {
  if (current === null) return null;

  const last = messages[messages.length - 1];
  const request = messages.findLast(m => m.authorType === 'human' && m.kind === 'text' && !m.direct);
  const outstanding = request && !request.direct && !current.paused && (!privateOn || request.privateTo === myName)
    ? [...new Set(request.privateTo ? [request.privateTo] : mentionedIn(request.body))].filter(name =>
      !messages.some(m => m.id > request.id && m.authorType === 'agent' && m.author === name && m.privateTo === request.privateTo)) : [];
  const offline = outstanding.filter(name => !agentOnline(name));
  const privateScope = privateOn || last?.privateTo === myName;
  // 공개 대화의 작업 상태가 혼잣말 응답인 것처럼 표시되지 않게 한다.
  const busy = agents.filter((a) => a.online && a.busyThreadId === current.id &&
    (!privateScope || a.user === myName));
  if (busy.length > 0) {
    return {
      who: busy.map((a) => a.user).join(', '),
      items: [...busy.map(a=>({who:a.user,since:Date.parse(a.reportedAt),running:true})), ...offline.map(who=>({who,warn:true}))],
      since: Math.min(...busy.map((a) => Date.parse(a.reportedAt))),
      warn: false,
      running: true,
      offline,
    };
  }

  // 2) 아직 아무도 시작하지 않았다 — 누구를 기다리는 중인지는 마지막 메시지가 안다.
  if (current.paused || messages.length === 0) return null;
  if (offline.length) return {who:offline.join(', '), since:null, warn:true};
  // Direct human messages do not cancel an earlier request to an agent.
  if (!request || outstanding.length === 0) return null;
  return { who: outstanding.join(', '), since: Date.parse(request.createdAt), warn: false, running: false };
}

function updatePending() {
  const pending = pendingInfo();
  $('pending').hidden = pending === null;
  if (pending === null) { $('pendingText').replaceChildren(); return; }
  const items = pending.items || pending.who.split(', ').map(who=>({...pending,who}));
  const rows = items.map(p=>{
    const row=el('div','pending-agent'+(p.warn?' warn':''));
    row.appendChild(el('span', p.state && p.state !== 'running' ? 'task-state-dot' : 'pulse'));
    if (p.state) {
      const labels = {running:'작업 중', 'waiting-owner':'소유자 확인 대기', 'waiting-connection':'PC 연결 대기', 'waiting-agent':'다른 에이전트 대기', completed:'작업 완료', failed:'작업 실패', cancelled:'요청 취소됨'};
      row.dataset.taskState = p.state;
      row.appendChild(el('span', '', `${p.who} 에이전트 · ${labels[p.state] || '상태 확인 중'}${p.reason ? ` · ${p.reason}` : ''}`));
      return row;
    }
    const secs=Math.max(0,Math.round((Date.now()-p.since)/1000));
    const text=p.warn ? `${p.who} · 오프라인 — 앱을 켜서 연결해 주세요`
      : p.running ? `${p.who} 에이전트 · ${secs*1000>SLOW_REPLY_MS?'답변이 지연되고 있습니다':'답변 중'} (${secs}초)`
      : `${p.who} 에이전트 · ${secs>=120?'실행 지연 · 연결 상태를 확인해 주세요':'실행 대기 중'} (${secs}초)`;
    row.appendChild(el('span','',text));
    return row;
  });
  $('pendingText').replaceChildren(...rows);
}

setInterval(updatePending, 1000);

/* --------------------------------------------------- 내 에이전트 패널 */

// 어댑터가 있는 도구 전부 — daemon/adapters/index.ts 의 ADAPTERS 와 같아야 한다.
// 설치되지 않은 것도 보여 주되 고를 수 없게 한다. 목록에 아예 없으면 "왜 없지" 가 된다.
const TOOLS = ['claude', 'codex'];

// 도구별 모델 후보. 도구가 알려주는 목록이 없어 여기에 적는다 — 여기 없는 값이
// 이미 설정돼 있으면 그 값도 함께 보여 준다(아래 optionsFor).
// Codex는 이 기기에서 실제 호출한 모델을 후보로 제공한다.
const MODELS = { claude: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], codex: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark'] };
const MODEL_LABELS = {'claude-fable-5-1':'Claude Fable 5.1','claude-opus-5':'Claude Opus 5','claude-sonnet-5':'Claude Sonnet 5','claude-haiku-4-5-20251001':'Claude Haiku 4.5 (2025-10-01)'};

function optionsFor(select, options, value) {
  select.textContent = '';
  const all = options.some((o) => o.value === value)
    ? options
    : [...options, { value, label: `${value} (직접 설정한 값)` }];
  for (const o of all) {
    const node = el('option', null, o.label);
    node.value = o.value;
    if (o.disabled) node.disabled = true;
    select.appendChild(node);
  }
  select.value = value;
}

function renderMembers() {
  renderSharingAudience();
  $('memberCount').textContent = String(members.length);
  $('members').replaceChildren();
  for (const member of [...members].sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
    const row = el('li', 'member-row');
    const state = agentOf(member.name);
    const online = state?.online && state.toolOk;
    const dot = el('span', `dot${online ? ' ok' : ''}`);
    dot.setAttribute('aria-hidden', 'true');
    row.append(dot, el('span', 'member-name', member.name + (member.name === myName ? ' (나)' : '')),
      el('span', 'member-state', online ? 'AI 연결됨' : 'AI 미연결'));
    $('members').appendChild(row);
  }
}

function renderAgentPanel() {
  renderMembers();
  $('accountName').textContent = myName || '내 계정';
  const mine = agentOf(myName);
  const dot = $('daemonDot');
  const text = $('daemonText');
  const help = $('daemonHelp');

  if (mine === null) {
    dot.className = 'dot';
    text.textContent = '데몬이 연결된 적 없음';
    help.textContent = '내 컴퓨터에서 npm run setup 을 마친 뒤 npm run daemon 을 실행하세요.';
    help.className = 'panel-note';
  } else if (!mine.online) {
    dot.className = 'dot err';
    text.textContent = '데몬 꺼짐';
    help.textContent = '터미널에서 npm run daemon 을 다시 실행하세요.';
    help.className = 'panel-note warn';
  } else if (mine.busyThreadId !== null) {
    dot.className = 'dot warn';
    text.textContent = '데몬 실행 중';
    help.textContent = '';
  } else {
    dot.className = 'dot ok';
    text.textContent = '데몬 연결됨';
    help.textContent = '';
  }

  // 고른 도구를 쓸 수 없다는 보고는 반드시 보인다 — 조용히 실패하지 않는다.
  if (mine !== null && mine.toolOk === false && mine.toolError) {
    help.textContent = mine.toolError;
    help.className = 'panel-note warn';
  }

  const available = mine?.availableTools ?? [];
  const configuredTool = mine?.configuredTool ?? mine?.tool;
  const followLabel = configuredTool ? `데몬 설정 따름 (${configuredTool})` : '데몬 설정 따름';
  optionsFor(
    $('toolSelect'),
    [
      { value: '', label: followLabel },
      ...TOOLS.map((t) => ({
        value: t,
        label: available.includes(t) ? t : `${t} (이 컴퓨터에 없음)`,
        disabled: mine !== null && !available.includes(t),
      })),
    ],
    settings.tool ?? '',
  );

  const modelTool = settings.tool ?? configuredTool ?? '';
  const forTool = MODELS[modelTool] ?? [];
  const displayedModel = settings.model ?? (mine?.tool === modelTool ? mine.model : null) ?? '';
  optionsFor(
    $('modelSelect'),
    [{ value: '', label: '모델을 선택하세요', disabled:true }, ...forTool.map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m })), {value:'__custom',label:'직접 입력…'}],
    displayedModel,
  );
  $('modelBrief').textContent = displayedModel || '모델 선택';
  $('modelBrief').title = displayedModel || '사용할 모델을 선택하세요';
  $('modelDetail').textContent = displayedModel ? `다음 요청 모델: ${displayedModel}` : '모델을 선택하면 다음 요청부터 적용됩니다.';

  // 데몬이 보고한 적이 없으면 무엇이 깔려 있는지 알 수 없어 고르게 할 수 없다.
  $('toolSelect').disabled = mine === null;
  $('modelSelect').disabled = mine === null;
  selectMenus.forEach(menu => menu.sync());
}

function setSettingsNote(text, warn) {
  $('settingsStatus').textContent = text;
  $('settingsStatus').className = warn ? 'panel-note warn' : 'panel-note';
}

async function saveSettings(tool, model) {
  try {
    settings = await api('/agent/settings', {
      method: 'POST',
      body: JSON.stringify({ tool, model }),
    });
    renderAgentPanel();
    setSettingsNote('계정에 저장했습니다. 앱을 다시 열어도 유지되며 다음 요청부터 적용됩니다.');
  } catch (err) {
    renderAgentPanel();
    setSettingsNote(`저장하지 못했습니다: ${err.message}`, true);
  }
}

$('toolSelect').addEventListener('change', () => {
  const tool = $('toolSelect').value || null;
  // 도구를 바꾸면 그 도구에 없는 모델은 함께 비운다 — 남겨두면 다음 실행이
  // 모르는 모델 이름으로 실패한다.
  const chosen = $('modelSelect').value;
  saveSettings(tool, (MODELS[tool] ?? []).includes(chosen) ? chosen : null);
});

$('modelSelect').addEventListener('change', () => {
  const custom = $('modelSelect').value === '__custom';
  $('customModelForm').hidden = !custom;
  if (custom) { $('customModel').focus(); return; }
  saveSettings($('toolSelect').value || agentOf(myName)?.configuredTool || agentOf(myName)?.tool || null, $('modelSelect').value || null);
});

$('customModelForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const model = $('customModel').value.trim();
  if (!model || /[\s\\/]/.test(model)) { setSettingsNote('공백 없이 모델 이름을 입력하세요.', true); return; }
  $('customModelForm').hidden = true;
  saveSettings($('toolSelect').value || agentOf(myName)?.configuredTool || agentOf(myName)?.tool || null, model);
});

async function refreshAgents() {
  const data = await api('/agents');
  members = data.members ?? [];
  agents = data.agents;
  renderThreads();
  settings = data.settings;
  renderAgentPanel();
  updatePending();
  renderMentionTarget();
}

/* -------------------------------------------------------------- 멘션 대상 */

function routeKey(){return `message-route-v1:${myName}:${current?.id}`;}
function currentRoute(){
  return routeMessage({text:$('input').value,history:messages,me:myName,members:members.map(m=>m.name),mode:localStorage.getItem(routeKey())||'auto',privateOn});
}
function renderMentionTarget() {
  $('mentionTarget').hidden = !current;
  if(!current)return;
  let saved=localStorage.getItem(routeKey())||'auto';
  const participants=conversationMembers(messages,myName,members.map(m=>m.name));
  let selected=[];
  if(saved.startsWith('targets:')){try{selected=JSON.parse(saved.slice(8));}catch{}}
  if(!Array.isArray(selected))selected=[];
  if(messages.length && selected.some(n=>!participants.includes(n))){selected=selected.filter(n=>participants.includes(n));saved='targets:'+JSON.stringify(selected);localStorage.setItem(routeKey(),saved);}
  const mode=saved.startsWith('targets:')?'agents':saved;
  for(const button of document.querySelectorAll('[data-route-mode]')){
    button.setAttribute('aria-pressed',String(button.dataset.routeMode===mode));button.disabled=privateOn;
  }
  const people=$('routePeople');people.hidden=mode!=='agents'||privateOn;
  const signature=JSON.stringify(participants);
  if(people.dataset.people!==signature){
    people.replaceChildren(...participants.map(name=>{
      const label=el('label','route-person');const input=document.createElement('input');input.type='checkbox';input.value=name;
      input.addEventListener('change',()=>{
        const names=[...people.querySelectorAll('input:checked')].map(i=>i.value);
        localStorage.setItem(routeKey(),'targets:'+JSON.stringify(names));renderMentionTarget();showComposerError('');
      });label.append(input,document.createTextNode(name));return label;
    }));people.dataset.people=signature;
  }
  for(const input of people.querySelectorAll('input'))input.checked=selected.includes(input.value);
  $('mentionTargetText').textContent=privateOn ? '내 에이전트 · 나에게만 보임' : currentRoute().label;
}
for(const button of document.querySelectorAll('[data-route-mode]'))button.addEventListener('click',()=>{
  let mode=button.dataset.routeMode;
  if(mode==='agents'){
    const previous=localStorage.getItem(routeKey());
    mode=previous?.startsWith('targets:')?previous:'targets:'+JSON.stringify(previousTargets(messages,myName,members.map(m=>m.name)));
  }
  localStorage.setItem(routeKey(),mode);renderMentionTarget();showComposerError('');
});
$('input').addEventListener('input',renderMentionTarget);

function firstMention(text) {
  MENTION.lastIndex = 0;
  const m = MENTION.exec(text);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------ 동작들 */

async function openThread(id) {
  $('summaryToggle').setAttribute('aria-expanded', 'false');
  $('sharedSummary').hidden = true;
  workspaceLayout.closeNavigation();
  $('resourceRequests').replaceChildren();
  $('resourceRequests').hidden = true;
  $('sharingConfirm').checked = false;
  unseenMessages = 0;
  $('latestMessage').hidden = true;
  current = threads.find((t) => t.id === id) ?? null;
  if (current) {
    // Keep refresh and notification links aligned with the visible conversation.
    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set('thread', current.id);
    url.hash = hash.toString();
    history.replaceState(history.state, '', url);
  }
  messages = [];
  renderThreads();
  renderThreadState();
  renderMessages();
  try {
    const fetched = await api(`/threads/${id}/messages`);
    if (current?.id !== id) return;
    messages = [...new Map([...fetched, ...messages].map((m) => [m.id, m])).values()].sort((a,b) => a.id-b.id);
  } catch (err) {
    if (current?.id !== id) return;
    messages = [];
    setStatus('err', err.message);
  }
  renderMessages();
  renderMentionTarget();
  scrollToBottom();
  $('input').focus();
  void refreshGithubRequest();
  void refreshResourceRequests();
  void refreshTaskStates();
}

function showComposerError(text) {
  $('composerError').textContent = text;
  $('composerError').hidden = text === '';
}

// 혼잣말 토글. 눌렀는지가 보내기 전에 분명해야 한다 — 버튼 자체와 입력창 전체를
// 함께 물들여, 공개로 쓸 말이 혼잣말로 나가는 것보다 훨씬 나쁜 사고(혼잣말이
// 공개로 새는 것)를 막는다.
function setPrivate(on) {
  privateOn = on;
  renderMentionTarget();
  $('privateToggle').setAttribute('aria-pressed', String(on));
  $('privateToggle').textContent = on ? '🔒 혼잣말 켜짐' : '🔒 혼잣말';
  $('composer').classList.toggle('private', on);
  $('composerHint').classList.toggle('private', on);
  $('publicHint').hidden = on;
  $('privateHint').hidden = !on;
  hideMentions();
  updatePending();
}

$('privateToggle').addEventListener('click', () => setPrivate(!privateOn));

async function sendMessage(body, kind = 'text', privateTo = null, decisionRequestId = undefined, direct = false) {
  if (!current || body.trim() === '') return;
  showComposerError('');
  const threadId=current.id;
  try {
    const sent=await api(`/threads/${threadId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ authorType: 'human', kind, body, privateTo, decisionRequestId, direct, deliveryMode:direct?'direct':'auto' }),
    });
    if (current?.id!==threadId)return sent;
    if(!messages.some(m=>m.id===sent.id))messages.push(sent);
    if (kind === 'text') {
      $('input').value = '';
      resizeInput();
      renderMentionTarget();
    }
    return sent;
  } catch (err) {
    // 보내기 실패 시 입력 내용을 지우지 않는다.
    showComposerError(`보내지 못했습니다: ${err.message}`);
  }
}

// 추천 대상을 기존 클라이언트와 호환되는 명시적 멘션으로 전달한다.
let composerSending = false;
async function sendComposerMessage() {
  if (composerSending) return;
  const raw = $('input').value;
  if (!current || raw.trim() === '') return;

  const route=currentRoute();
  if(route.blocked){showComposerError(route.label);document.querySelector('[data-route-mode=agents]').focus();return;}
  const explicit=routingMentions(raw);
  const body=explicit.length || !route.targets.length ? raw : route.targets.map(n=>'@'+n).join(' ')+' '+raw;
  const key=routeKey();
  const publicMessage=!privateOn;
  composerSending = true;
  $('send').disabled = true;
  try {
    const sent=await sendMessage(body, 'text', privateOn ? myName : null, undefined, !privateOn && localStorage.getItem(routeKey())==='direct');
    if(sent && explicit.length && publicMessage && !route.direct){localStorage.setItem(key,'auto');renderMentionTarget();}
  } finally {
    composerSending = false;
    $('send').disabled = false;
  }

}

let mentionChoices = [];
let mentionIndex = 0;
let mentionRange = null;
function hideMentions() {
  $('mentionMenu').hidden = true;
  $('input').removeAttribute('aria-activedescendant');
  mentionRange = null;
}
function updateMentions() {
  const input = $('input');
  const prefix = input.value.slice(0, input.selectionStart);
  const match = prefix.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
  if (!match || input.selectionStart !== input.selectionEnd) { hideMentions(); return; }
  mentionRange = {start:input.selectionStart-match[1].length-1,end:input.selectionStart};
  mentionChoices = members.filter(m => (!privateOn || m.name === myName) &&
    m.name.toLocaleLowerCase().startsWith(match[1].toLocaleLowerCase()));
  if (!mentionChoices.length) { hideMentions(); return; }
  mentionIndex = 0;
  renderMentionChoices();
}
function renderMentionChoices() {
  const menu = $('mentionMenu');
  menu.replaceChildren();
  mentionChoices.forEach((m,i) => {
    const option = el('button', 'mention-option', `@${m.name}${m.name === myName ? ' (나)' : ''}`);
    option.type = 'button'; option.tabIndex = -1; option.id = `mention-option-${i}`;
    option.setAttribute('role','option'); option.setAttribute('aria-selected',String(i === mentionIndex));
    option.addEventListener('pointerdown',e=>e.preventDefault());
    option.addEventListener('click',()=>chooseMention(i));
    menu.appendChild(option);
  });
  menu.hidden = false;
  $('input').setAttribute('aria-activedescendant',`mention-option-${mentionIndex}`);
  menu.children[mentionIndex]?.scrollIntoView({block:'nearest'});
}
function chooseMention(index) {
  if (!mentionRange) return;
  const input = $('input');
  input.setRangeText(`@${mentionChoices[index].name} `,mentionRange.start,mentionRange.end,'end');
  hideMentions(); resizeInput(); input.focus();
}
$('input').addEventListener('input', e=>{if (!e.isComposing) updateMentions();});
$('input').addEventListener('compositionend',updateMentions);
$('input').addEventListener('click',updateMentions);
$('input').addEventListener('blur',hideMentions);
$('input').addEventListener('keyup',e=>{if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) updateMentions();});

function resizeInput() {
  const box = $('input');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, Math.max(48, Math.min(160, innerHeight * .2)))}px`;
}
window.addEventListener('resize', resizeInput);

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendComposerMessage();
});

$('input').addEventListener('input', resizeInput);
$('input').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (!$('mentionMenu').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); hideMentions(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + mentionChoices.length) % mentionChoices.length;
      renderMentionChoices(); return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chooseMention(mentionIndex); return; }
  }
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return;
  e.preventDefault();
  sendComposerMessage();
});

/* -------------------------------------------------------- 새 스레드 */

function startNewThread() {
  workspaceLayout.openNavigation();
  $('newThreadBtn').hidden = true;
  $('newThreadForm').hidden = false;
  $('newThreadError').hidden = true;
  $('newThreadTitle').focus();
}

function closeNewThread() {
  $('newThreadForm').hidden = true;
  $('newThreadBtn').hidden = false;
  $('newThreadTitle').value = '';
  $('newThreadError').hidden = true;
}

$('newThreadBtn').addEventListener('click', startNewThread);
$('newThreadCancel').addEventListener('click', closeNewThread);
$('newThreadTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNewThread();
});

$('newThreadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('newThreadTitle').value.trim();
  if (title === '') {
    $('newThreadError').textContent = '제목을 입력하세요';
    $('newThreadError').hidden = false;
    return;
  }
  try {
    const t = await api('/threads', { method: 'POST', body: JSON.stringify({ title }) });
    closeNewThread();
    await refreshThreads();
    await openThread(t.id);
  } catch (err) {
    $('newThreadError').textContent = err.message;
    $('newThreadError').hidden = false;
  }
});

$('resumeBtn').addEventListener('click', async () => {
  if (!current) return;
  try {
    await api(`/threads/${current.id}/resume`, { method: 'POST' });
  } catch (err) {
    setStatus('err', err.message);
  }
});

// 서버 응답을 기다리지 않는다 — SSE 로 돌아온 thread 이벤트가 current/threads/렌더를
// 갱신한다(같은 화면 포함). 다른 사람 화면도 그 방송으로 똑같이 갱신된다.
$('deleteThreadBtn').addEventListener('click', async () => {
  if (!current || $('deleteThreadBtn').disabled) return;
  const removed=current;
  if (!confirm(`“${removed.title}” 대화를 내 목록에서 삭제할까요? 내 미처리 결정 요청도 취소됩니다. 다른 참여자의 기록은 유지됩니다.`)) return;
  const button=$('deleteThreadBtn');button.disabled=true;
  locallyHiddenThreads.add(removed.id);
  threads=threads.filter(t=>t.id!==removed.id);
  current=null;messages=[];
  history.replaceState(history.state,'',location.pathname);
  $('githubRequestStatus').hidden=true;
  $('input').value='';
  renderThreads();renderThreadState();renderMessages();updatePending();
  try {
    await api(`/threads/${removed.id}`,{method:'DELETE'});
  } catch (error) {
    locallyHiddenThreads.delete(removed.id);
    if (!threads.some(t=>t.id===removed.id)) threads.unshift(removed);
    renderThreads();
    setStatus('err',`삭제하지 못해 목록에 복구했습니다: ${error.message}`);
  } finally { button.disabled=false; }
});

$('resolveBtn').addEventListener('click', async () => {
  if (!current) return;
  try {
    await api(`/threads/${current.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolved: !current.resolved }),
    });
  } catch (err) {
    setStatus('err', err.message);
  }
});

/* ------------------------------------------------------------- 시작 */

async function refreshThreads() {
  const session = token;
  const fetched = await api('/threads');
  if (session !== token) return;
  threads = fetched.filter(t=>!locallyHiddenThreads.has(t.id));
  if (current && !threads.some(t => t.id === current.id)) {
    current = null;
    messages = [];
    history.replaceState(history.state, '', location.pathname);
    $('githubRequestStatus').hidden = true;
    $('input').value = '';
    renderThreadState();
    renderMessages();
    updatePending();
  }
  renderThreads();
}

let es = null;
async function refreshDecisionCount() {
  if (!token) return;
  const session = token;
  try {
    const pending = await api('/decisions');
    if (session === token) $('decisionCount').textContent = pending.length ? ` (${pending.length})` : '';
  } catch { /* 연결 상태는 기존 연결 표시가 담당한다. */ }
}
setInterval(refreshDecisionCount, 15000);
async function openLinkedThread() {
  const id = new URLSearchParams(location.hash.slice(1)).get('thread');
  if (id && threads.some(t => t.id === id)) await openThread(id);
}
window.addEventListener('hashchange', () => openLinkedThread().catch(err => setStatus('err',err.message)));

async function start() {
  if (es) {
    es.close();
    es = null;
  }

  try {
    await refreshThreads();
    await refreshAgents();
  } catch (err) {
    logout(err.message);
    return;
  }

  await refreshDecisionCount();
  await openLinkedThread();
  setStatus('ok', '연결됨');
  renderThreadState();
  renderMessages();

  // EventSource 는 헤더를 못 붙이므로 토큰을 쿼리로 넘긴다 (사내망 전용).
  es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  const source = es;
  es.onopen = async () => {
    try {
      await refreshAgents();
      await refreshThreads();
      if (source !== es) return;
      const id = current?.id;
      if (id) {
        const fetched = await api(`/threads/${id}/messages`);
        if (source !== es || current?.id !== id) return;
        current = threads.find((t) => t.id === id) ?? current;
        messages = [...new Map([...fetched, ...messages].map((m) => [m.id, m])).values()].sort((a,b) => a.id-b.id);
        renderThreadState();
        renderMessages();
      }
      setStatus('ok', '연결됨');
    } catch (err) { if (source === es) setStatus('err', `동기화 실패 — ${err.message}`); }
  };
  es.onerror = () => setStatus('err', '연결 끊김 — 다시 연결하는 중');
  es.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'message' && ['decision_request','decision_result'].includes(data.message.kind)) refreshDecisionCount();

    if (data.type === 'tasks-changed') { void refreshTaskStates(); return; }
    if (data.type === 'resources-changed') { void refreshResourceRequests(); return; }
    if (data.type === 'threads-changed') { await refreshThreads(); await refreshDecisionCount(); return; }
    if (data.type === 'members') {
      members = data.members;
      renderMembers();
    }

    if (data.type === 'thread') {
      await refreshThreads();
      if (current?.id === data.thread.id) current = data.thread;
      markCurrentRead();
      renderThreads();
      renderThreadState();
      updatePending();
      if (current === null) renderMessages();
    }

    if (data.type === 'message' && data.message.threadId === current?.id) {
      if (!messages.some(m => m.id === data.message.id)) {
        if (!nearBottom()) unseenMessages++;
        messages.push(data.message);
      }
      renderMessages();
      void refreshGithubRequest();
    }

    // 데몬 상태는 전원이 받는다 — 남의 에이전트가 도는지도 이 화면이 보여야 한다.
    if (data.type === 'agent') {
      const i = agents.findIndex((a) => a.user === data.state.user);
      if (i >= 0) agents[i] = data.state;
      else agents.push(data.state);
      renderAgentPanel();
      renderThreads();
      updatePending();
    }

    // 설정은 내 것만 온다 (서버가 onlyFor 로 거른다) — 다른 탭에서 바꿔도 따라온다.
    if (data.type === 'settings') {
      settings = data.settings;
      renderAgentPanel();
    }
  };
}

if (token) {
  showApp();
  start();
} else {
  showStart();
}

let githubCheckTimer;
async function refreshGithubConnection() {
  if (!token) return false;
  try {
    const connection = await api('/github/status');
    const connected = Boolean(connection?.login && connection.expiresAt > Date.now());
    githubConnected = connected;
    document.querySelectorAll('.github-login-action').forEach(action => { action.hidden = connected; });
    $('githubStatusDot').className = connected ? 'dot ok' : 'dot';
    $('githubStatusText').textContent = connected ? 'GitHub 연결됨' : 'GitHub 미연결';
    $('githubStatusButton').title = connected ? `GitHub · ${connection.login} · 설정 열기` : 'GitHub 연결하기';
    $('githubNextStep').hidden = true;
    await refreshGithubRequest();
    $('githubConnect').textContent = connected ? 'GitHub 계정 변경' : 'GitHub 연결하기';
    $('githubConnectionStatus').textContent = connected
      ? `✓ GitHub 로그인 확인 · ${connection.login}\n이슈·변경 요청(PR)·변경 이력 연동에 사용합니다.`
      : 'GitHub 연결이 아직 확인되지 않았습니다. 로그인 후 연결 상태 확인을 눌러 주세요. 일반 대화와 내 PC 자료 공유에는 연결이 필요하지 않습니다.';
    if (connected) clearInterval(githubCheckTimer);
    return connected;
  } catch {
    $('githubStatusDot').className = 'dot';
    $('githubStatusText').textContent = 'GitHub 확인 실패';
    $('githubConnectionStatus').textContent = '연결 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.';
    $('githubNextStep').hidden = true;
    return null;
  }
}
$('githubRefresh').addEventListener('click', () => void checkGithubWithFeedback($('githubRefresh')));
$('accountSettings').addEventListener('toggle', () => { if ($('accountSettings').open) void refreshGithubConnection(); });
$('githubConnect').addEventListener('click', async () => {
  const status = $('githubConnectionStatus');
  if (!window.desktopMessenger?.connectGithub) {
    status.textContent = '앱 트레이에서 GitHub 연결을 선택하거나 터미널에서 gh auth login --hostname github.com --web 을 실행한 뒤, 연결 상태 확인을 눌러 주세요.';
    return;
  }
  try {
    await window.desktopMessenger.connectGithub();
    if (await refreshGithubConnection()) return;
    status.textContent = window.desktopMessenger?.refreshGithub ? '로그인 완료를 기다리고 있습니다. 완료 후 연결 상태 확인을 누르면 즉시 확인합니다.' : '현재 앱은 로그인 결과가 반영되는 데 최대 5분이 걸릴 수 있습니다. 즉시 확인 기능에는 앱 업데이트가 필요합니다.';
    clearInterval(githubCheckTimer);
    const deadline = Date.now() + 5 * 60 * 1000;
    githubCheckTimer = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(githubCheckTimer); return; }
      try { await window.desktopMessenger?.refreshGithub?.(); } catch {}
      void refreshGithubConnection();
    }, 5000);
  } catch { status.textContent = '연결 창을 열지 못했습니다. 앱 트레이의 GitHub 연결 메뉴를 이용해 주세요.'; }
});

async function refreshGithubRequest() {
  // Local files use owner-selected sharing policies, never GitHub readiness.
  $('githubRequestStatus').hidden = true;
}
async function checkGithubWithFeedback(button) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '연결 상태 확인 중…';
  try {
    if (window.desktopMessenger?.refreshGithub) {
      const result = await window.desktopMessenger.refreshGithub();
      if (!result.ok) {
        await refreshGithubConnection();
        button.textContent = '연결 확인 실패 · 다시 시도';
        $('githubConnectionStatus').textContent = 'GitHub 로그인 상태를 확인하지 못했습니다. GitHub 연결하기에서 로그인을 완료한 뒤 다시 확인해 주세요. 앱을 다시 시작할 필요는 없습니다.';
        return;
      }
    }
    const connected = await refreshGithubConnection();
    if (connected === null) { button.textContent = '확인 실패 · 다시 시도'; return; }
    button.textContent = connected ? '✓ 내 GitHub 연결 확인됨' : '아직 미연결 · 다시 확인';
    if (!connected) {
      $('githubConnectionStatus').textContent = '아직 메신저에 연결이 반영되지 않았습니다. 로그인 완료 후 최대 5분이 걸릴 수 있습니다. 이 버튼은 메신저에 반영된 상태를 확인합니다.';
      clearInterval(githubCheckTimer);
      const deadline = Date.now() + 5 * 60 * 1000;
      githubCheckTimer = setInterval(async () => {
        if (Date.now() > deadline) { clearInterval(githubCheckTimer); return; }
        try { await window.desktopMessenger?.refreshGithub?.(); } catch {}
        if (await refreshGithubConnection()) button.textContent = '✓ 내 GitHub 연결 확인됨';
      }, 5000);
    }
  } catch (error) { button.textContent = '확인 실패 · 다시 시도'; $('githubConnectionStatus').textContent = error.message; } finally { button.disabled = false; }
}
$('githubRequestRefresh').addEventListener('click', () => void checkGithubWithFeedback($('githubRequestRefresh')));
$('githubRequestConnect').addEventListener('click', () => {
  $('accountSettings').open = true;
  $('githubConnect').click();
});
setInterval(() => {
  if (!document.hidden && current && !$('githubRequestStatus').hidden) void refreshGithubRequest();
}, 10000);

$('githubStatusButton').addEventListener('click', () => {
  $('accountSettings').open = true;
  if ($('githubStatusText').textContent === 'GitHub 미연결') $('githubConnect').click();
  else void refreshGithubConnection();
});
if (token) void refreshGithubConnection();
setInterval(() => { if (token && !document.hidden) void refreshGithubConnection(); }, 15000);

$('closeSettings').addEventListener('click', () => { $('accountSettings').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('accountSettings').open = false; });

/* --------------------------------------------------------- 소유자 자료 공유 */
let sharingPolicies = [];
let sharingBusy = false;
function renderSharingAudience() {
  const chosen = new Set([...$('sharingAudience').querySelectorAll('input:checked')].map(input => input.value));
  $('sharingAudience').replaceChildren();
  for (const name of [...new Set([myName, ...members.map(member => member.name)])].filter(Boolean)) {
    const label = el('label', 'sharing-check');
    const input = el('input'); input.type = 'checkbox'; input.name = 'audience'; input.value = name; input.checked = chosen.has(name);
    label.append(input, el('span', null, `${name}${name === myName ? ' (나)' : ''}`));
    $('sharingAudience').append(label);
  }
}
function sharingAvailable() { return typeof window.desktopMessenger?.sharingList === 'function'; }
function renderSharingPolicies(result) {
  sharingPolicies = result.policies ?? [];
  $('workFolderAdd').hidden = result.workFolders !== true;
  $('sharingForm').hidden = true;
  $('sharingPolicies').replaceChildren();
  const active = sharingPolicies.filter(policy => !policy.revoked);
  if (!active.length) $('sharingPolicies').append(el('p', 'panel-note', '허용한 파일·폴더가 없습니다.'));
  for (const policy of active) {
    const card = el('article', 'sharing-policy');
    card.append(el('strong', null, `${policy.kind === 'directory' ? '폴더' : '파일'} · ${policy.label}`));
    card.append(el('p', 'panel-note', policy.dependency ? '관련 패키지 · 현재 대화에서 읽기 가능 · 원래 프로젝트의 허용에 연결됨' : policy.workFolder ? '사내 대화에서 읽기 가능 · 추가 승인 없음 · 수정·삭제 불가' : `기존 개별 공유: ${policy.audience.join(', ')} · ${policy.threadId ? (threads.find(thread => thread.id === policy.threadId)?.title || '지정한 대화') : '선택한 사람과의 모든 대화'}`));
    if (policy.kind === 'directory') {
      const details = el('details'); details.append(el('summary', null, `제외 항목 ${policy.excluded?.length ?? 0}개`));
      const form = el('form'); const label = el('label', 'panel-label', '공유 폴더 안의 상대 경로 · 한 줄에 하나');
      const input = el('textarea', 'field'); input.id = `exclude-${policy.id}`; input.name = 'excluded'; label.htmlFor = input.id;
      input.rows = 3; input.value = (policy.excluded ?? []).join('\n');
      const save = el('button', 'btn-quiet', '제외 목록 저장'); save.type = 'submit';
      form.append(label, input, save);
      form.addEventListener('submit', event => {
        event.preventDefault();
        void sharingAction(() => window.desktopMessenger.sharingExclude({id: policy.id, excluded: input.value.split('\n').map(value => value.trim()).filter(Boolean)}), '제외 목록을 저장했습니다.');
      }); details.append(form); card.append(details);
    }
    const revoke = el('button', 'btn-quiet', '공유 철회'); revoke.type = 'button';
    revoke.addEventListener('click', () => void sharingAction(() => window.desktopMessenger.sharingRevoke({id: policy.id}), '공유를 철회했습니다. 이후 읽기는 허용하지 않습니다.'));
    card.append(revoke); $('sharingPolicies').append(card);
  }
}
async function refreshSharing() {
  renderSharingAudience();
  $('sharingForm').hidden = true;
  if (!sharingAvailable()) { $('sharingStatus').textContent = '자료를 소유한 PC의 최신 데스크톱 앱에서 파일·폴더를 선택해 주세요.'; return; }
  try { const snapshot=await window.desktopMessenger.sharingList();renderSharingPolicies(snapshot); $('sharingStatus').textContent = snapshot.workFolders ? '' : '현재 앱은 기존 공유 설정을 사용 중입니다. 업무 폴더 기능은 통합 업데이트에 포함됩니다.'; }
  catch { $('sharingStatus').textContent = '공유 목록을 불러오지 못했습니다. 다시 시도해 주세요.'; }
}
async function sharingAction(action, success) {
  if (sharingBusy) return;
  sharingBusy = true;
  const controls = [...$('sharingSettings').querySelectorAll('button')]; controls.forEach(button => button.disabled = true);
  try { renderSharingPolicies(await action()); $('sharingStatus').textContent = success; }
  catch { $('sharingStatus').textContent = '공유 설정을 변경하지 못했습니다. 대상과 연결 상태를 확인한 뒤 다시 시도해 주세요.'; }
  finally { sharingBusy = false; controls.forEach(button => button.disabled = false); }
}
$('sharingSettings').addEventListener('toggle', () => { if ($('sharingSettings').open) void refreshSharing(); });
$('workFolderAdd').addEventListener('click',()=>void sharingAction(()=>window.desktopMessenger.sharingAdd({workFolder:true,kind:'directory',audience:[],threadId:null}),'업무 폴더 목록을 확인했습니다.'));
$('sharingRefresh').addEventListener('click', () => void refreshSharing());
$('sharingForm').addEventListener('submit', event => {
  event.preventDefault();
  const audience = [...$('sharingAudience').querySelectorAll('input:checked')].map(input => input.value);
  if (!audience.length) { $('sharingStatus').textContent = '읽기를 허용할 사람을 한 명 이상 직접 선택해 주세요.'; return; }
  const threadId = $('sharingScope').value === 'thread' ? current?.id : null;
  if (threadId === undefined) { $('sharingStatus').textContent = '현재 대화를 먼저 선택해 주세요.'; return; }
  if (!$('sharingConfirm').checked || !sharingAvailable()) return;
  const kind = event.submitter?.value;
  if (!['file','directory'].includes(kind)) return;
  void sharingAction(async () => {
    const result = await window.desktopMessenger.sharingAdd({kind, audience, threadId});
    $('sharingConfirm').checked = false;
    return result;
  }, '공유 목록을 확인했습니다. 선택을 취소한 경우에는 바뀌지 않습니다.');
});

/* Structured resource requests are fetched separately; chat prose cannot grant access. */
let resourceRefreshGeneration = 0;
const resourceDisclosureState = new Map();
const terminalResourceStates = new Set(['completed', 'failed', 'denied', 'cancelled']);
const resourceLabels = {'waiting-owner':'소유자 확인 필요','waiting-connection':'소유자 PC 연결 대기',running:'자료 읽는 중',reading:'자료 읽는 중',completed:'자료 읽기 완료',denied:'소유자가 거절함',failed:'자료 읽기 실패',cancelled:'요청 취소됨'};
async function refreshResourceRequests() {
  const id = current?.id, session = token;
  if (!id || !session) { $('resourceRequests').hidden = true; return; }
  const generation = ++resourceRefreshGeneration;
  try {
    const requests = await api(`/threads/${encodeURIComponent(id)}/resources`);
    if (current?.id !== id || token !== session || generation !== resourceRefreshGeneration) return;
    const active = requests.filter(request => !terminalResourceStates.has(request.status));
    const history = requests.filter(request => terminalResourceStates.has(request.status));
    const groups = [];
    for (const [kind, items] of [['active', active], ['history', history]]) {
      if (!items.length) continue;
      const key = `${id}:${kind}`;
      const group = el('details', 'resource-group');
      group.dataset.resourceGroup = kind;
      group.open = resourceDisclosureState.get(key) ?? kind === 'active';
      const summary = el('summary');
      const needsMe = items.filter(request => request.owner === myName && request.status === 'waiting-owner').length;
      summary.textContent = kind === 'active'
        ? `진행 중인 자료 요청 ${items.length}건${needsMe ? ` · 내 확인 필요 ${needsMe}건` : ''}`
        : `지난 자료 요청 ${items.length}건`;
      if (kind === 'history') {
        for (const [status, label] of [['completed','완료'],['failed','실패'],['denied','거절'],['cancelled','취소']]) {
          const count = items.filter(request => request.status === status).length;
          if (count) summary.append(document.createTextNode(' · '), resourceStatusLabel(status, `${label} ${count}건`));
        }
      }
      group.append(summary);
      group.append(...(kind === 'history' ? [...items].reverse() : items).map(renderResourceCard));
      group.addEventListener('toggle', () => {
        if (group.isConnected) resourceDisclosureState.set(key, group.open);
      });
      groups.push(group);
    }
    $('resourceRequests').replaceChildren(...groups);
    $('resourceRequests').hidden = !requests.length;
  } catch { /* Existing connection status reports transport failures. */ }
}
function resourceStatusLabel(status, text) {
  const label = el('span', 'resource-status', text);
  label.dataset.resourceStatus = status;
  return label;
}
function renderResourceCard(request) {
  const card = el('article', 'resource-card'); card.dataset.resourceId = request.id;
  card.dataset.resourceStatus = request.status;
  const heading = el('div', 'resource-card-heading');
  heading.append(el('strong', null, `${request.owner}님의 자료`), resourceStatusLabel(request.status, resourceLabels[request.status] || '상태 확인 중'));
  card.append(heading);
  card.append(el('p', 'panel-note', `${request.action === 'list' ? '폴더 목록' : '파일 읽기'} · ${request.path || '선택한 폴더'}`));
  card.append(el('p', 'panel-note', `요청한 사람: ${request.requester} · 읽을 사람: ${request.audience.join(', ')} · 현재 대화`));
  const note = el('p', 'panel-note'); note.setAttribute('role', 'status'); card.append(note);
  if(request.status==='denied')note.textContent='소유자가 읽기를 거절했습니다. 이 요청은 다시 실행하지 않습니다.';
  else if(request.status==='waiting-connection')note.textContent='읽기는 허용됐습니다. 소유자 앱이 연결되면 원래 요청을 이어갑니다.';
  else if(request.status==='failed')note.textContent='읽기 또는 답변 처리에 실패했습니다. 권한 거절과는 다릅니다. 현재 앱이 상세 원인을 제공하지 않아 경로·연결 중 어느 문제인지는 확정할 수 없습니다.';
  else if(request.status==='waiting-owner')note.textContent='실패가 아니라 소유자의 읽기 허용을 기다리는 중입니다.';
  async function decide(body) {
    await api(`/resources/${encodeURIComponent(request.id)}/decision`, {method:'POST', body:JSON.stringify(body)});
  }
  async function act(action) {
    const controls = [...card.querySelectorAll('button')]; controls.forEach(button => button.disabled = true);
    try { await action(); await refreshResourceRequests(); }
    catch { note.textContent = '처리하지 못했습니다. 요청 상태와 소유자 PC 연결을 확인한 뒤 다시 시도해 주세요.'; }
    finally { controls.forEach(button => button.disabled = false); }
  }
  if (request.owner === myName && request.status === 'waiting-owner') {
    if (request.waitReason === 'sensitive') {
      card.append(el('p', 'panel-note', '민감정보가 감지되어 읽기를 멈췄습니다. 값을 가린 내용만 표시된 사람에게 공유할 수 있습니다.'));
      if (request.preview) card.append(el('pre', 'resource-preview', request.preview));
      const approve = el('button', 'btn-quiet', '민감한 값을 가린 내용만 공유 승인'); approve.type = 'button';
      approve.addEventListener('click', () => void act(() => decide({approved:true, policyId:request.policyId})));
      card.append(approve);
    } else {
    card.append(el('p', 'panel-note', '이 자료를 읽어 현재 대화에 공유해도 될까요? 선택한 파일 또는 요청한 폴더를 이 대화에서 계속 허용합니다. 사내 전체 공유로 바뀌지 않으며 수정·삭제는 실행하지 않습니다.'));
    for (const kind of request.action === 'list' ? ['directory'] : ['file']) {
      const button = el('button', 'btn-quiet', kind === 'file' ? '이 대화에 허용할 파일 선택' : '요청한 폴더 선택 · 이 대화에 허용'); button.type = 'button';
      button.disabled = !sharingAvailable();
      button.addEventListener('click', () => void act(async () => {
        const before = await window.desktopMessenger.sharingList();
        const result = await window.desktopMessenger.sharingAdd({kind, audience: request.audience, threadId: request.threadId});
        const policy = result.policies.find(item => !item.revoked && !before.policies.some(old => old.id === item.id));
        if (!policy) { note.textContent = '선택을 취소했습니다. 읽기를 승인하지 않았습니다.'; return; }
        await decide({approved: true, policyId: policy.id, path: policy.prefix || ''});
        note.textContent = '승인했습니다. 원래 질문을 이어서 처리하며, 같은 대화에서 이 범위는 다시 묻지 않습니다.';
      })); card.append(button);
    }
    if (!sharingAvailable()) card.append(el('p', 'panel-note', '자료를 소유한 PC의 최신 데스크톱 앱에서 선택해 주세요.'));
    }
    const reject = el('button', 'btn-quiet', '거절'); reject.type = 'button';
    reject.addEventListener('click', () => void act(() => decide({approved:false}))); card.append(reject);
  }
  if (request.requester === myName && ['waiting-owner','waiting-connection','running'].includes(request.status)) {
    const cancel = el('button', 'btn-quiet', '요청 취소'); cancel.type = 'button';
    cancel.addEventListener('click', () => void act(() => api(`/resources/${encodeURIComponent(request.id)}/cancel`, {method:'POST'}))); card.append(cancel);
  }
  return card;
}
setInterval(() => { if (!document.hidden) { void refreshResourceRequests(); void refreshTaskStates(); } }, 15000);

function latestThreadTasks(threadId) {
  const latest = new Map();
  for (const task of taskStatesByThread.get(threadId) ?? []) {
    const previous = latest.get(task.owner);
    if (!previous || task.messageId >= previous.messageId) latest.set(task.owner, task);
  }
  return [...latest.values()];
}
let taskRefreshGeneration = 0;
async function refreshTaskStates() {
  const id = current?.id, session = token;
  if (!id || !session) return;
  const generation = ++taskRefreshGeneration;
  try {
    const tasks = await api(`/threads/${encodeURIComponent(id)}/tasks`);
    if (current?.id !== id || token !== session || generation !== taskRefreshGeneration) return;
    taskStatesByThread.set(id, tasks);
    updatePending(); renderThreads();
  } catch { /* Preserve last confirmed state across transient connection failures. */ }
}
