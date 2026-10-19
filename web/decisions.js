const $ = id => document.getElementById(id);
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const expectedAccount = new URLSearchParams(location.search).get('account');
let token = localStorage.getItem('token') || '';
let cards = new Map();
let loading = false;
let generation = 0;
function requireLogin(note = '') {
  generation++;
  cards.clear(); $('requests').replaceChildren(); $('empty').hidden = true;
  $('feedback').hidden = true; $('auth').hidden = false;
  $('authNote').textContent = note || '브라우저마다 최초 한 번 로그인이 필요합니다.';
  $('name').value = expectedAccount || '';
  $('connection').textContent = '로그인이 필요해요';
}
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {...options, headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
  if (res.status === 401) { requireLogin(); throw new Error('다시 로그인해 주세요.'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  const me = decodeURIComponent(res.headers.get('X-User') || '');
  if (expectedAccount && me !== expectedAccount) {
    requireLogin(`${expectedAccount}님의 요청입니다. 해당 계정으로 로그인해 주세요.`);
    throw new Error('요청받은 계정으로 로그인해 주세요.');
  }
  return {data,me};
}
function renderCard(item) {
  const {request:r,threadTitle,context} = item;
  let d; try { d = JSON.parse(r.body) || {}; } catch { d = {}; }
  const card = node('article','request-card'); card.dataset.requestId = r.id;
  const question = typeof d.question === 'string' ? d.question : '결정이 필요한 요청';
  card.append(node('span','tag',`${threadTitle}${r.privateTo ? ' · 혼잣말' : ''}`),node('h2',null,question));
  if (typeof d.summary === 'string' && d.summary.trim()) {
    card.append(node('h3',null,'지금까지 정리'),node('p','summary',d.summary));
  } else card.append(node('p','summary','요약이 없는 기존 요청입니다. 아래 최근 대화를 확인해 주세요.'));
  if (typeof d.recommendation === 'string' && d.recommendation.trim()) {
    card.append(node('p','recommendation',`에이전트의 추천\n${d.recommendation}`));
  }
  const details = node('details'); details.open = !d.summary;
  details.append(node('summary',null,'최근 대화 확인'));
  for (const m of context) details.append(node('p','context-message',`${m.author}\n${m.body}`));
  if (!context.length) details.append(node('p',null,'이 요청 이전의 대화가 없습니다.'));
  const link = node('a',null,'이 대화로 돌아가기');link.href = `/#thread=${encodeURIComponent(r.threadId)}`;
  details.append(link);card.append(details);
  const error = node('p','error');error.setAttribute('role','alert');
  async function answer(body) {
    const controls = [...card.querySelectorAll('button,textarea')];
    controls.forEach(x=>x.disabled=true);error.textContent='';
    const epoch = generation;
    try {
      await api(`/threads/${encodeURIComponent(r.threadId)}/messages`,{method:'POST',body:JSON.stringify({authorType:'human',kind:'decision_result',body,decisionRequestId:r.id})});
      if (epoch !== generation) return;
      card.remove();cards.delete(r.id);
      $('feedback').textContent='답변을 전달했어요. 에이전트가 이 답변을 받아 이어서 진행합니다.';
      $('feedback').hidden=false;
      $('feedback').tabIndex=-1; $('feedback').focus();
      await refresh();
    } catch(e) { if (epoch === generation) {error.textContent=e.message;controls.forEach(x=>x.disabled=false);await refresh();} }
  }
  const choices = node('div','choices');
  for (const option of (Array.isArray(d.options)?d.options:[]).filter(x=>typeof x==='string' && x.trim())) {
    const button = node('button','btn-quiet',option);button.type='button';
    button.addEventListener('click',()=>answer(option));choices.append(button);
  }
  const form = node('form');
  const label = node('label',null,'다른 의견이 있으면 직접 답변하세요');label.htmlFor=`answer-${r.id}`;
  const input = node('textarea','field');input.id=label.htmlFor;input.required=true;input.maxLength=8000;input.placeholder='결정이나 추가로 확인할 내용을 적어주세요';
  const submit = node('button','btn','답변 보내기');submit.type='submit';
  form.append(label,input,submit);form.addEventListener('submit',e=>{e.preventDefault();if(input.value.trim())answer(input.value.trim());});
  card.append(choices,form,error);
  return card;
}
function renderResourceCard(request) {
  const card = node('article','request-card'); card.dataset.resourceId = request.id;
  card.append(node('span','tag',request.privateRead ? '내 PC 자료 · 나만 보임' : '내 PC 자료 공유'),node('h2',null,request.waitReason === 'sensitive' ? '민감한 값을 가린 내용 공유 확인' : '자료 읽기 허용 확인'));
  card.append(node('p','summary',`요청한 사람: ${request.requester}\n읽을 사람: ${(request.audience ?? []).join(', ')}`));
  if(request.label || request.path) card.append(node('p',null,`요청 자료: ${request.label || request.path}`));
  card.append(node('p',null,'대화에서 요청 내용과 공유 범위를 확인한 뒤, 자료를 소유한 PC에서 승인하거나 거절해 주세요.'));
  const link=node('a','btn-quiet','대화에서 확인');link.href=`/#thread=${encodeURIComponent(request.threadId)}`;card.append(link);
  return card;
}
async function refresh() {
  if (loading || !token) return;
  loading = true; const epoch = generation;
  try {
    const [{data,me},{data:resources}] = await Promise.all([api('/decisions'),api('/resources')]);
    const ownedResources = resources.filter(request => request.owner === me && request.status === 'waiting-owner');
    if (epoch !== generation) return;
    $('auth').hidden = true;
    const ids = new Set([...data.map(x=>x.request.id),...ownedResources.map(request=>`resource:${request.id}`)]);
    for (const [id,card] of cards) if(!ids.has(id)){card.remove();cards.delete(id);}
    // 기존 카드는 교체하지 않아 직접 입력·커서·스크롤을 유지한다.
    for (const item of data) if(!cards.has(item.request.id)){
      const card=renderCard(item);cards.set(item.request.id,card);$('requests').append(card);
    }
    for(const request of ownedResources){
      const id=`resource:${request.id}`, previous=cards.get(id);
      const card=renderResourceCard(request);
      if(previous)previous.replaceWith(card);else $('requests').append(card);
      cards.set(id,card);
    }
    $('empty').hidden=cards.size!==0;
    $('connection').textContent=`${me}님 · 답변 대기 ${cards.size}건 · 자동으로 확인 중`;
    document.title=cards.size ? `(${cards.size}) 내 결정 요청함` : '내 결정 요청함 · 에이전트 메신저';
  } catch(e) { $('connection').textContent=`${e.message} 연결되면 다시 확인합니다.`; }
  finally { loading=false; }
}
$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();$('loginError').textContent='';
  try {
    const name=$('name').value.trim();
    if(expectedAccount && name!==expectedAccount) throw new Error(`${expectedAccount} 계정으로 로그인해 주세요.`);
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password:$('password').value})});
    const data=await res.json();if(!res.ok)throw new Error(data.error || '로그인하지 못했습니다.');
    token=data.token;localStorage.setItem('token',token);$('password').value='';generation++;await refresh();
  }catch(e){$('loginError').textContent=e.message;}
});
window.addEventListener('storage',e=>{
  if(e.key==='token') {token=e.newValue || '';requireLogin();if(token)refresh();}
});
window.addEventListener('focus',()=>refresh());
setInterval(refresh,5000);
if(token)refresh();else requireLogin();
