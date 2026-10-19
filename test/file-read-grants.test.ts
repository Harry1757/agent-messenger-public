import {test} from 'node:test';import assert from 'node:assert/strict';import {FileReadGrants} from '../server/file-read-grants.ts';import {createHash} from 'node:crypto';
test('read grants bind owner, thread, file, audience and identity, and are consumed once',()=>{
 const g=new FileReadGrants(),s={owner:'a',thread:'t',repo:'team/project',path:'README.md',audience:['a','b'],binding:'[1,2]'};const content='/Users/example/Desktop/project\n';const body=`공통 저장소에서 확인한 파일 내용: README.md\n내용 해시: ${createHash('sha256').update(content).digest('hex')}\n\n${content}`;
 const id=g.issue(s);assert(g.consume(id,'a','t',['a','b'],'[1,2]',body));assert(!g.consume(id,'a','t',['a','b'],'[1,2]',body));
 assert(!g.consume(g.issue(s),'b','t',['a','b'],'[1,2]',body));assert(!g.consume(g.issue(s),'a','t',['a','b','c'],'[1,2]',body));assert(!g.consume(g.issue(s),'a','t',['a','b'],'[1,3]',body));assert(!g.consume(g.issue(s),'a','t',['a','b'],'[1,2]',body+'tamper'));
});
