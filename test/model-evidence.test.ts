import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getAdapter} from '../daemon/adapters/index.ts';
import {readCodexModel} from '../daemon/model-evidence.ts';

test('Claude 모델은 응답 사용량에서 읽고 요청한 이름으로 대체하지 않는다',()=>{
 const result=getAdapter('claude').parseOutput(JSON.stringify({result:'OK',modelUsage:{'claude-sonnet-5':{inputTokens:10,outputTokens:1}}}));
 assert.deepEqual(result.observedModels,['claude-sonnet-5']);assert.equal(result.modelSource,'response');
 assert.equal(getAdapter('claude').parseOutput('{"result":"OK"}').observedModels,undefined);
});
test('정확한 모델 이름은 신규와 이어가기 모두 CLI 인자에 전달한다',()=>{
 for(const tool of ['claude','codex'])for(const sessionId of [null,'test-session']){
  const model=tool==='claude'?'claude-opus-5':'gpt-5.6-sol';
  const args=getAdapter(tool).buildArgs({prompt:'hi',systemPrompt:'test',threadId:'test',addDirs:[],sessionId,model});
  assert.equal(args[args.indexOf('--model')+1],model);
 }
});
test('GPT는 마지막 턴의 실행 모델을 읽고 로그가 없으면 미확인으로 남긴다',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'model-evidence-'));const id='11111111-1111-4111-a111-111111111111';
 try{
  writeFileSync(join(dir,`rollout-${id}.jsonl`),[JSON.stringify({type:'turn_context',payload:{model:'gpt-6-astra'}}),JSON.stringify({type:'turn_context',payload:{model:'gpt-5.6-sol'}})].join('\n'));
  assert.equal(await readCodexModel(id,dir),'gpt-5.6-sol');
  assert.equal(await readCodexModel('invalid-session',dir),null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import {openDb,upsertUser,createThread,listMessages} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
test('모델 근거는 에이전트 답변에만 저장되고 조회해도 유지된다',async()=>{
 const db=openDb(':memory:');upsertUser(db,'예제사용자','a');const thread=createThread(db,'audit','예제사용자');
 const srv=buildApp(db).listen(0);await new Promise(r=>srv.once('listening',r));
 const execution={tool:'claude',requestedModel:'claude-opus-5',observedModels:['claude-sonnet-5'],source:'response'};
 try{
  for(const authorType of ['human','agent']){
   const res=await fetch(`http://127.0.0.1:${(srv.address() as {port:number}).port}/api/threads/${thread.id}/messages`,{method:'POST',headers:{Authorization:'Bearer a','Content-Type':'application/json'},body:JSON.stringify({authorType,author:'예제사용자',kind:'text',body:'확인',execution})});
   assert.equal(res.status,200);
  }
  const messages=listMessages(db,thread.id,'예제사용자');
  assert.equal(messages[0].execution,undefined);assert.deepEqual(messages[1].execution,execution);
 }finally{srv.close();db.close();}
});
