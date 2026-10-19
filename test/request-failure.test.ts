import {test} from 'node:test';import assert from 'node:assert/strict';
import {handleWithFailure,visibleFailure} from '../daemon/request-failure.ts';
test('file request validation errors produce a visible failure rather than silent idle',async()=>{
 const out:string[]=[];await handleWithFailure(async()=>{throw Error('설정된 작업 위치에서 해당 프로젝트를 확인할 수 없습니다');},async e=>{out.push(visibleFailure(e));},()=>{});
 assert.equal(out.length,1);assert.match(out[0],/프로젝트/);
});
test('unexpected errors do not reveal local paths or credentials',()=>{
 assert(!visibleFailure(Error('secret at C:\\Users\\Someone\\private.txt')).includes('Someone'));
});
test('failure to publish stays observable and successful requests do not produce an error',async()=>{
 await assert.rejects(handleWithFailure(async()=>{throw Error();},async()=>{throw Error('offline');},()=>{}),/offline/);
 await handleWithFailure(async()=>{},async()=>{assert.fail('unexpected error');},()=>{});
});
