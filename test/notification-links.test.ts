import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {NotificationLinks,toastXml} from '../desktop/notification-links.ts';
test('알림과 대화 연결이 재시작 후에도 유지되고 다른 계정에는 적용되지 않는다',()=>{
 const dir=mkdtempSync(join(tmpdir(),'notification-links-'));try{
 const file=join(dir,'links.json');const store=new NotificationLinks(file);store.save('n1','예제사용자','http://localhost/#thread=abc','http://localhost');
 const restored=new NotificationLinks(file);assert.equal(restored.resolve('type=click&tag=n1','예제사용자','http://localhost'),'http://localhost/#thread=abc');
 assert.equal(restored.resolve('type=click&tag=n1','예제동료','http://localhost'),undefined);
 store.save('external','예제사용자','http://example.com/','http://localhost');assert.equal(store.resolve('tag=external','예제사용자','http://localhost'),undefined);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Windows 알림 본문 클릭과 선택·답변에 식별자를 포함하고 텍스트를 이스케이프한다',()=>{
 const xml=toastXml('n1','A & B','<hello>',['선택 "A"'],true);
 assert.match(xml,/launch="type=click&amp;tag=n1"/);assert.match(xml,/type=reply&amp;tag=n1/);assert.match(xml,/type=action&amp;tag=n1&amp;action=0/);assert.match(xml,/&lt;hello&gt;/);assert.match(xml,/A &amp; B/);
});

test('forgetting a thread removes only that account and conversation notification links',()=>{
 const dir=mkdtempSync(join(tmpdir(),'notification-forget-'));
 try{
  const links=new NotificationLinks(join(dir,'links.json'));const server='http://localhost:3000';
  links.save('old','a',server+'/#thread=deleted',server);links.save('keep','a',server+'/#thread=kept',server);links.save('peer','b',server+'/#thread=deleted',server);
  assert.deepEqual(links.forgetThread('a','deleted'),['old']);
  assert.equal(links.resolve('tag=old','a',server),undefined);assert(links.resolve('tag=keep','a',server));assert(links.resolve('tag=peer','b',server));
  assert.equal(new NotificationLinks(join(dir,'links.json')).resolve('tag=old','a',server),undefined);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
