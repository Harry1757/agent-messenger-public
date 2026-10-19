import type {Express,Request,Response} from 'express';
import type {DatabaseSync} from 'node:sqlite';
import {ResourceError,ResourceStore} from './resource-store.ts';

/** Mount after the application's authentication middleware. No filesystem paths enter these APIs. */
export function mountResourceRoutes(app:Express,db:DatabaseSync,options:{broadcast?:(event:any)=>void}={}){
 const store=new ResourceStore(db);
 const route=(fn:(req:Request,user:string)=>unknown,changed=false)=>(req:Request,res:Response)=>{
  if(typeof res.locals.user!=='string'||!res.locals.user){res.status(401).json({error:'로그인이 필요합니다'});return;}
  try{const result=fn(req,res.locals.user);res.json(result);if(changed)options.broadcast?.({type:'resources-changed',owner:res.locals.user});}
  catch(error){if(error instanceof ResourceError)res.status(error.status).json({error:error.message});else res.status(500).json({error:'자료 요청 처리에 실패했습니다'});}
 };
 app.get('/api/resources',route((_req,user)=>store.listOwned(user)));
 app.get('/api/sharing/policies',route((_req,user)=>store.policies(user)));
 app.put('/api/sharing/policies/:id',route((req,user)=>store.putPolicy(user,String(req.params.id),req.body),true));
 app.delete('/api/sharing/policies/:id',route((req,user)=>store.revokePolicy(user,String(req.params.id)),true));
 app.get('/api/threads/:id/resources',route((req,user)=>store.list(user,String(req.params.id))));
 app.post('/api/threads/:id/resources',route((req,user)=>store.request(user,String(req.params.id),req.body),true));
 app.post('/api/resources/:id/decision',route((req,user)=>store.decide(user,String(req.params.id),req.body),true));
 app.post('/api/resources/:id/claim',route((req,user)=>store.claim(user,String(req.params.id),req.body)));
 app.post('/api/resources/:id/complete',route((req,user)=>store.complete(user,String(req.params.id),req.body),true));
 app.post('/api/resources/:id/cancel',route((req,user)=>store.cancel(user,String(req.params.id)),true));
 app.post('/api/resources/:id/wait-approval',route((req,user)=>store.waitApproval(user,String(req.params.id),req.body),true));
 app.post('/api/resources/:id/receipt',route((req,user)=>store.issueReceipt(user,{...req.body,requestId:String(req.params.id)})));
 return store;
}
