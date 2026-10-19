import {test} from 'node:test';import assert from 'node:assert/strict';
import {revealWindow} from '../desktop/notification-window.ts';
test('최소화된 창은 복원한 뒤 표시하고 포커스한다',()=>{
 const calls:string[]=[];revealWindow({isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')});assert.deepEqual(calls,['restore','show','focus']);
});
test('숨겨진 창은 새 창을 만들지 않고 표시한다',()=>{
 const calls:string[]=[];revealWindow({isMinimized:()=>false,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')});assert.deepEqual(calls,['show','focus']);
});
