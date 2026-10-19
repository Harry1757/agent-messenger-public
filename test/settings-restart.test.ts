import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb,upsertUser,getSettings,setSettings} from '../server/db.ts';
import {resolveActive} from '../daemon/state.ts';
test('모델 선택은 DB를 닫고 다시 열어도 남고 새 데몬의 기본값보다 우선한다',()=>{
 const dir=mkdtempSync(join(tmpdir(),'model-persist-'));const file=join(dir,'db');
 try{
  let db=openDb(file);upsertUser(db,'예제사용자','a');
  setSettings(db,'예제사용자',{tool:'codex',model:'gpt-5.6-sol'});db.close();
  db=openDb(file);upsertUser(db,'예제사용자','a');
  const saved=getSettings(db,'예제사용자');assert.deepEqual(saved,{tool:'codex',model:'gpt-5.6-sol'});
  assert.equal(resolveActive({tool:'claude',command:'claude'},saved,['claude','codex']).model,'gpt-5.6-sol');db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
