import {test} from 'node:test';import assert from 'node:assert/strict';
import {routeMessage,conversationMembers} from '../web/routing.js';
const h=(body:string,author='예제사용자',authorType='human')=>({body,author,authorType,kind:'text',privateTo:null});
const history=[h('@서연 확인해주세요'),h('답입니다','서연','agent'),h('@예제동료 검토해줘'),h('요약합니다','예제사용자','agent')];
const route=(text:string,extra={})=>routeMessage({text,history,me:'예제사용자',members:['예제사용자','서연','예제동료'],...extra});
test('사람의 최근 요청 대상으로 이어가고 에이전트 요약은 대상을 바꾸지 않는다',()=>{assert.deepEqual(route('다시 확인해줘').targets,['예제동료']);});
test('명시적 멘션과 복수 요청을 보존한다',()=>{
 assert.deepEqual(route('@서연 @예제동료 같이 확인해줘').targets,['서연','예제동료']);
 assert.deepEqual(route('다시 확인해줘',{history:[h('@서연 @예제동료 확인')]}).targets,['서연','예제동료']);
});
test('다른 사람의 요청은 내 대상을 변경하지 않는다',()=>assert.deepEqual(route('다시 확인해줘',{history:[...history,h('@예제사용자 확인','예제동료')]}).targets,['예제동료']));
test('직접 답변과 직접 대화 선택은 에이전트를 실행하지 않는다',()=>{
 assert.deepEqual(route('제가 확인할게요').targets,[]);assert.deepEqual(route('확인해주세요',{mode:'direct'}).targets,[]);
});
test('이름으로 부른 요청은 대상을 바꾸고 모르는 대상은 선택을 요구한다',()=>{
 assert.deepEqual(route('서연님 확인해주세요').targets,['서연']);assert.equal(route('확인해주세요',{history:[]}).blocked,true);
 assert.equal(route('@없는사람 확인').blocked,true);
});
test('혼잣말은 이전 대상과 무관하게 나에게만 전달한다',()=>{
 assert.deepEqual(route('확인해줘',{privateOn:true}).targets,['예제사용자']);assert.equal(route('@예제동료 확인',{privateOn:true}).blocked,true);
});

test('보낼 대상은 현재 대화 참여자만 포함하고 초대 전 팀원은 제외한다',()=>{
 assert.deepEqual(conversationMembers([h('@예제동료 확인'),h('답','예제동료','agent')],'예제사용자',['예제사용자','서연','예제동료']),['예제사용자','예제동료']);
 assert.deepEqual(conversationMembers([h('@예제동료 확인'),h('@서연 참고','예제동료','agent')],'예제사용자',['예제사용자','서연','예제동료']),['예제사용자','예제동료']);
 assert.deepEqual(conversationMembers([h('@예제동료 @서연 확인')],'예제사용자',['예제사용자','서연','예제동료']),['예제사용자','서연','예제동료']);
});
