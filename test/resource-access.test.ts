import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAccess, validRelativePath} from '../shared/resource-access.ts';
import type {SharePolicy,ResourceRequest} from '../shared/resource-access.ts';
const p:SharePolicy={id:'p',owner:'a',deviceId:'d',source:'local',rootId:'r',prefix:'src',kind:'directory',audience:['a','b'],threadId:'t',excluded:['src/private'],revision:1,revoked:false};
const q:ResourceRequest={id:'q',owner:'a',deviceId:'d',requester:'b',threadId:'t',audience:['a','b'],generation:1,source:'local',rootId:'r',relativePath:'src/app.ts',action:'read'};
test('folder inheritance, exclusions, exact files and mutation separation',()=>{
 assert.equal(evaluateAccess(q,[p]).kind,'allow');
 for(const relativePath of ['src-other/a','src/private/key','../src/app.ts','/src/app.ts','src\\app.ts']) assert.notEqual(evaluateAccess({...q,relativePath},[p]).kind,'allow');
 assert.equal(evaluateAccess({...q,action:'delete'},[p]).kind,'deny');
 assert.equal(evaluateAccess({...q,relativePath:'src'},[{...p,kind:'file'}]).kind,'allow');
 assert.notEqual(evaluateAccess(q,[{...p,kind:'file'}]).kind,'allow');
});
test('scope cannot cross people, threads, devices or revoked policies',()=>{
 for(const patch of [{threadId:'other'},{audience:['a','b','c']},{deviceId:'x'},{owner:'x'},{requester:'c'}]) assert.notEqual(evaluateAccess({...q,...patch},[p]).kind,'allow');
 assert.notEqual(evaluateAccess(q,[{...p,revoked:true}]).kind,'allow');
 assert.equal(evaluateAccess({...q,threadId:'other'},[{...p,threadId:null}]).kind,'allow');
 assert.equal(evaluateAccess(q,[{...p,audience:['a','b','c']}]).kind,'allow');
 assert.notEqual(evaluateAccess({...q,audience:['a','b','new']},[{...p,audience:['a','b','c']}]).kind,'allow');
 assert.notEqual(evaluateAccess(q,[{...p,audience:[]}]).kind,'allow');
});
test('portable path grammar rejects aliases and traversal',()=>{
 for(const p of ['a/../b','C:/a','a:stream','//server/a','a//b','a/./b','a.','a ','NUL','aux.txt','a\u0000b']) assert.equal(validRelativePath(p),false,p);
 assert.equal(validRelativePath('한글/hello.txt'),true);
});
test('explicit work folder permits new coworkers across rooms but excludes private paths',()=>{
 const work={...p,workFolder:true,threadId:null};const other={...q,threadId:'new',requester:'c',audience:['a','c']};
 assert.equal(evaluateAccess(other,[work]).kind,'allow');
 assert.equal(evaluateAccess({...other,relativePath:'src/private/key'},[work]).kind,'deny');
 assert.equal(evaluateAccess({...other,action:'write'},[work]).kind,'deny');
 assert.equal(evaluateAccess({...other,action:'delete'},[work]).kind,'deny');
 assert.notEqual(evaluateAccess(other,[p]).kind,'allow');
});
