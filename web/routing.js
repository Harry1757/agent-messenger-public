// 브라우저에서만 추천한다. 실제 전송 대상은 기존 앱도 읽는 @멘션으로 명시한다.
export function mentions(text) {
  return [...new Set([...text.matchAll(/(?<=^|\s)@([\p{L}\p{N}_-]+)/gu)].map(m=>m[1]))];
}
export function previousTargets(history, me, members) {
  const request=history.findLast(m=>m.authorType==='human' && m.author===me && m.kind==='text' && !m.direct && !m.privateTo && mentions(m.body).length);
  return request ? mentions(request.body).filter(n=>members.includes(n)) : [];
}
export function routeMessage({text,history,me,members,mode='auto',privateOn=false}) {
  const explicit=mentions(text);
  if(privateOn) return explicit.some(n=>n!==me)
    ? {targets:[],blocked:true,label:'혼잣말은 내 에이전트만 요청할 수 있어요'}
    : {targets:[me],label:'내 에이전트 · 나에게만 보임'};
  if(mode==='direct')return explicit.some(n=>!members.includes(n))
    ? {targets:[],blocked:true,label:'가입한 팀원의 이름을 확인해 주세요'}
    : {targets:[],direct:true,label:explicit.length ? explicit.join(', ')+'님에게 직접 대화 · 에이전트 실행 안 함' : '직접 대화 · 에이전트 실행 안 함'};
  if(explicit.length) return explicit.some(n=>!members.includes(n))
    ? {targets:[],blocked:true,label:'가입한 팀원의 이름을 확인해 주세요'}
    : {targets:explicit,label:explicit.join(', ')+' 에이전트에게 요청 · 멘션 지정'};
  if(mode==='direct')return {targets:[],label:'직접 대화 · 에이전트 실행 안 함'};
  if(mode.startsWith('targets:')){
    let targets=[];try{targets=JSON.parse(mode.slice(8));}catch{}
    if(!Array.isArray(targets)||!targets.length||targets.some(n=>!members.includes(n)))return {targets:[],blocked:true,label:'요청 대상을 다시 선택해 주세요'};
    return {targets,label:targets.join(', ')+' 에이전트에게 요청 · 직접 지정'};
  }
  // 명확한 사람의 답변은 이전 요청 대상이 있어도 에이전트를 부르지 않는다.
  const direct=/^(네[.!\s]*|넵[.!\s]*|감사합니다[.!\s]*|고마워요[.!\s]*|알겠습니다[.!\s]*|확인했습니다[.!\s]*)$|^(제가|저는|내가)\s.*(할게요|하겠습니다|했어요|했습니다|먹었어요|먹을게요)[.!\s]*$/u.test(text.trim());
  if(direct)return {targets:[],label:'직접 대화로 추천 · 확인·답변 표현'};
  const request=/(해\s*줘|해주세요|해주|부탁|알려|확인해|골라|판단하지|어떻게|왜|인가요|일까요|\?)/u.test(text);
  const named=members.filter(n=>text.trim().startsWith(n+'님')||text.trim().startsWith(n+' '));
  if(request && named.length===1)return {targets:named,label:named[0]+' 에이전트에게 요청 · 이름을 부른 질문'};
  const targets=previousTargets(history,me,members);
  if(targets.length)return {targets,label:targets.join(', ')+' 에이전트에게 이어서 요청'};
  if(request)return {targets:[],blocked:true,label:'누구에게 요청할지 선택해 주세요'};
  return {targets:[],label:'직접 대화 · 아직 요청 대상 없음'};
}

// 공개 메시지 작성자와 명시적으로 초대된 사람만 대화의 대상 목록에 표시한다.
// 다른 사람의 혼잣말/요약 속 이름을 초대로 해석하지 않는다.
export function conversationMembers(history, me, members) {
  const names=new Set([me]);
  for(const message of history){
    if(message.privateTo)continue;
    names.add(message.author);
    if(message.authorType==='human' && message.kind==='text')for(const name of mentions(message.body))names.add(name);
  }
  return members.filter(name=>names.has(name));
}
