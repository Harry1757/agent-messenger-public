import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contextFor,shouldReviewReply,conversationPrompt,conversationSessionKey} from '../daemon/conversation.ts';
import type {Message} from '../shared/types.ts';
const m=(id:number,author:string,authorType:'human'|'agent',body:string,privateTo:string|null=null):Message=>({id,threadId:'t',author,authorType,body,privateTo,kind:'text',createdAt:'2026-09-11T00:00:00Z'});
const q=m(1,'예제사용자','agent','@예제동료 확인해주세요');const reply=m(2,'예제동료','agent','확인했습니다');
test('에이전트가 요청한 동료의 첫 답변만 자동 검토한다',()=>{
 assert.equal(shouldReviewReply(reply,[q,reply],'예제사용자'),true);
 assert.equal(shouldReviewReply(reply,[q,reply],'제삼자'),false);
 assert.equal(shouldReviewReply(reply,[q,reply],'예제동료'),false);
});
test('이미 검토했으면 늦게 처리된 답변도 반복하지 않는다',()=>{
 assert.equal(shouldReviewReply(reply,[q,reply,m(3,'예제사용자','agent','검토 완료')],'예제사용자'),false);
});
test('혼잣말이나 결정 요청은 자동 공개 검토하지 않는다',()=>{
 assert.equal(shouldReviewReply({...reply,privateTo:'예제사용자'},[q,reply],'예제사용자'),false);
 assert.equal(shouldReviewReply({...reply,kind:'decision_request'},[q,reply],'예제사용자'),false);
});
test('공개 맥락에 혼잣말이 섞이지 않고 비공개는 앞선 공개 대화를 포함한다',()=>{
 const secret=m(3,'예제사용자','human','비공개 내용','예제사용자');const next=m(4,'예제동료','agent','공개 답변');
 assert.deepEqual(contextFor(next,[q,reply,secret,next]).map(x=>x.id),[1,2,4]);
 assert.deepEqual(contextFor(secret,[q,reply,secret,next]).map(x=>x.id),[1,2,3]);
 assert.doesNotMatch(conversationPrompt(next,[q,reply,secret,next],true),/비공개 내용/);
 assert.match(conversationPrompt(reply,[q,reply],true),/@예제동료 확인해주세요/);
});
test('공개와 비공개 CLI 세션 기억을 분리한다',()=>{
 assert.notEqual(conversationSessionKey('t',null),conversationSessionKey('t','예제사용자'));
 assert.equal(conversationSessionKey('t',null),conversationSessionKey('t',null));
});
test('완료 요약은 다른 에이전트를 다시 실행하지 않는다',()=>{
 const summary={...reply,kind:'summary' as const};
 assert.equal(shouldReviewReply(summary,[q,summary],'예제사용자'),false);
 assert.equal(shouldReviewReply(summary,[q,summary,m(3,'예제사용자','agent','최종 요약')],'예제사용자'),false);
});

test('execution errors and GitHub waiting notices never trigger peer review',()=>{
 const q=m(91,'예제사용자','human','@예제동료 파일 확인 부탁드립니다');
 for(const body of ['⚠️ 에이전트 실행 실패: 로그인 오류','⏸️ GitHub 연결 대기: 로그인해 주세요']){
  const reply=m(92,'예제동료','agent',body);
  assert.equal(shouldReviewReply(reply,[q,reply],'예제사용자'),false);
 }
});

test('human questions do not implicitly invoke their own agent after a colleague answers',()=>{
 const human={...q,authorType:'human' as const};
 assert.equal(shouldReviewReply(reply,[human,reply],'예제사용자'),false);
 const newer=m(3,'예제사용자','human','@예제동료 추가 질문입니다');const next={...reply,id:4};
 assert.equal(shouldReviewReply(next,[q,reply,newer,next],'예제사용자'),false);
});
