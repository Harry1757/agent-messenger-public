import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {openDb,upsertUser,createThread,addThreadMember,addMessage} from '../server/db.ts';
import {mountResourceRoutes} from '../server/resource-routes.ts';
test('resource HTTP endpoints enforce authentication, ownership, room access and hide claim secrets',async()=>{
 const db=openDb(':memory:');for(const user of ['alice','bob','eve'])upsertUser(db,user,user);const thread=createThread(db,'test','alice');addThreadMember(db,thread.id,'bob');const message=addMessage(db,{threadId:thread.id,author:'bob',authorType:'human',kind:'text',body:'read'});
 const app=express();app.use(express.json());app.use((req,res,next)=>{const token=req.headers.authorization?.replace('Bearer ','');if(token&&['alice','bob','eve'].includes(token))res.locals.user=token;next();});mountResourceRoutes(app,db);const srv=app.listen(0);await new Promise(r=>srv.once('listening',r));const base=`http://127.0.0.1:${(srv.address() as any).port}/api`;
 const api=(url:string,user='',method='GET',body?:unknown)=>fetch(base+url,{method,headers:{Authorization:'Bearer '+user,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{
 assert.equal((await api('/sharing/policies')).status,401);
 const policy={deviceId:'mac',source:'local',rootId:'project',prefix:'',kind:'directory',audience:['bob'],threadId:null,excluded:[]};
 assert.equal((await api('/sharing/policies/p','alice','PUT',policy)).status,200);assert.equal((await api('/sharing/policies/p','bob','PUT',policy)).status,403);assert.deepEqual(await(await api('/sharing/policies','bob')).json(),[]);
 const input={messageId:message.id,owner:'alice',deviceId:'mac',source:'local',rootId:'project',path:'file',policyId:'p'};
 assert.equal((await api(`/threads/${thread.id}/resources`,'eve','POST',input)).status,404);
 const r=await(await api(`/threads/${thread.id}/resources`,'bob','POST',input)).json();assert.equal((await api(`/resources/${r.id}/claim`,'bob','POST',{generation:1,deviceId:'mac'})).status,403);
 const c=await(await api(`/resources/${r.id}/claim`,'alice','POST',{generation:1,deviceId:'mac'})).json();assert(c.claimToken);assert.equal((await api(`/resources/${r.id}/claim`,'alice','POST',{generation:1,deviceId:'mac'})).status,409);
 const list=await(await api(`/threads/${thread.id}/resources`,'bob')).json();assert.equal(list[0].claimToken,null);
 assert.equal((await api('/sharing/policies/p','bob','DELETE')).status,403);assert.equal((await api('/sharing/policies/p','alice','DELETE')).status,200);
 }finally{srv.closeAllConnections();await new Promise<void>(r=>srv.close(()=>r()));db.close();}
});
