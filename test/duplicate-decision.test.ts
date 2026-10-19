import {test} from 'node:test';import assert from 'node:assert/strict';import {duplicateDecision} from '../server/duplicate-decision.ts';
test('same outstanding decision is reused but answered, other owner and file approvals are separate',()=>{
 const body=JSON.stringify({question:'이슈 내용을 공유해 주세요?',options:['공유','취소']});const m:any={id:1,kind:'decision_request',author:'a',privateTo:null,body};
 assert.equal(duplicateDecision([m],'a',null,body)?.id,1);
 assert.equal(duplicateDecision([m],'b',null,body),undefined);
 assert.equal(duplicateDecision([m,{kind:'decision_result',decisionRequestId:1} as any],'a',null,body),undefined);
 assert.equal(duplicateDecision([m],'a',null,JSON.stringify({fileAccess:true,question:'이슈 내용을 공유해 주세요?'})),undefined);
});
