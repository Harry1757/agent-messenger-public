import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {approvedFileResult} from '../server/approved-file-result.ts';
test('approved output can contain project desktop paths; missing consent, expiry and changed content cannot',()=>{
 const content='Documentation: /Users/example/Desktop/project';const body=`소유자가 승인한 파일 내용: README.md\n내용 해시: ${createHash('sha256').update(content).digest('hex')}\n\n${content}`;
 const q:any={id:1,author:'owner',kind:'decision_request',privateTo:'owner',createdAt:new Date().toISOString(),body:JSON.stringify({fileAccess:true,question:'project/README.md — 읽기 및 내용 공유를 승인하시겠어요?'})};
 const a:any={id:2,kind:'decision_result',author:'owner',authorType:'human',privateTo:'owner',decisionRequestId:1,body:'@owner 파일 작업 1회 승인'};
 assert(approvedFileResult(body,[q,a],'owner'));assert(!approvedFileResult(body,[q],'owner'));assert(!approvedFileResult(body+'changed',[q,a],'owner'));assert(!approvedFileResult(body,[q,a],'other'));assert(!approvedFileResult(body,[q,a],'owner',Date.now()+11*60*1000));
});
