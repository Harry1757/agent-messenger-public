import type {Message} from '../shared/types.ts';
/** Reuse an identical outstanding question; file approvals always keep their own nonce. */
export function duplicateDecision(history:Message[],author:string,privateTo:string|null,body:string):Message|undefined {
 let next:any;try{next=JSON.parse(body);}catch{return;}
 if(next.fileAccess||typeof next.question!=='string')return;
 const key=(q:string)=>q.normalize('NFKC').replace(/[\s?!.,。？！]/g,'').toLowerCase();
 const answered=new Set(history.filter(m=>m.kind==='decision_result').map(m=>m.decisionRequestId));
 return history.findLast(m=>{
  if(m.kind!=='decision_request'||m.author!==author||m.privateTo!==privateTo||answered.has(m.id))return false;
  try{const old=JSON.parse(m.body);return !old.fileAccess&&typeof old.question==='string'&&key(old.question)===key(next.question);}catch{return false;}
 });
}
