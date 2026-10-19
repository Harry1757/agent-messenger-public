import {test} from 'node:test';import assert from 'node:assert/strict';
import {DaemonConnections} from '../server/daemon-connections.ts';
test('mixed current and legacy daemons remain distinguishable after disconnect',()=>{
 const c=new DaemonConnections();const old=c.add('one','');const fresh=c.add('one','conversation-only-v1');
 assert.deepEqual(c.status('one'),{connected:2,compatible:1,legacy:1,resourceAccess:false});old();old();
 assert.deepEqual(c.status('one'),{connected:1,compatible:1,legacy:0,resourceAccess:false});fresh();assert.equal(c.status('one').connected,0);
});

test('v1 retains general chat while v2 exposes resource and explicit delegation capability',()=>{
 const c=new DaemonConnections();const v1=c.add('one','conversation-only-v1');
 assert.deepEqual(c.status('one'),{connected:1,compatible:1,legacy:0,resourceAccess:false});
 const v2=c.add('one','resource-access-v2');assert.deepEqual(c.status('one'),{connected:2,compatible:2,legacy:0,resourceAccess:true});
 c.add('another','resource-access-v2');v2();assert.equal(c.status('one').resourceAccess,false);assert.equal(c.status('another').resourceAccess,true);
 v1();assert.deepEqual(c.status('one'),{connected:0,compatible:0,legacy:0,resourceAccess:false});
});
