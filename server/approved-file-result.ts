import {createHash} from 'node:crypto';
import type {Message} from '../shared/types.ts';
/** Only a recent, explicitly approved read result may bypass request-word filtering. */
export function approvedFileResult(body:string,history:Message[],owner:string,now=Date.now()):boolean {
 const match=body.match(/^소유자가 승인한 파일 내용: ([^\n]+)\n내용 해시: ([a-f0-9]{64})\n\n([\s\S]*)$/);
 if(!match||createHash('sha256').update(match[3]).digest('hex')!==match[2])return false;
 return history.some(request=>{
  const age=now-Date.parse(request.createdAt);
  if(!Number.isFinite(age)||age<0||request.author!==owner||request.kind!=='decision_request'||request.privateTo!==owner||age>10*60*1000)return false;
  try {
   const data=JSON.parse(request.body);
   if(data.fileAccess!==true||typeof data.question!=='string'||!data.question.endsWith(`/${match[1]} — 읽기 및 내용 공유를 승인하시겠어요?`))return false;
   return history.some(answer=>answer.kind==='decision_result'&&answer.decisionRequestId===request.id&&answer.authorType==='human'&&answer.author===owner&&answer.privateTo===owner&&answer.body===`@${owner} 파일 작업 1회 승인`);
  } catch {return false;}
 });
}
