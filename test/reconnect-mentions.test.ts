import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unansweredMention} from '../daemon/conversation.ts';
import type {Message} from '../shared/types.ts';
const human={id:1,author:'예제사용자',authorType:'human',kind:'text',body:'@서연 @예제동료 확인해주세요',privateTo:null} as Message;
const reply={id:2,author:'서연',authorType:'agent',kind:'summary',body:'확인했습니다',privateTo:null} as Message;
test('다른 멘션 대상이 답해도 오프라인 사용자의 요청을 복원한다',()=>{
 assert.equal(unansweredMention([human,reply],'예제동료'),human);
 assert.equal(unansweredMention([human,reply],'서연'),undefined);
});
test('이미 답했거나 사람이 새 대화를 시작하면 과거 요청을 재실행하지 않는다',()=>{
 assert.equal(unansweredMention([human,reply,{...reply,id:3,author:'예제동료'}],'예제동료'),undefined);
 assert.equal(unansweredMention([human,reply,{...human,id:3,body:'제가 직접 확인할게요'}],'예제동료'),undefined);
});
test('다른 사람의 혼잣말은 복원하지 않는다',()=>{
 assert.equal(unansweredMention([{...human,privateTo:'서연'}],'예제동료'),undefined);
});
