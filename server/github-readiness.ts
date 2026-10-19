import type {Message} from '../shared/types.ts';
/** UX hint only. File access is still enforced by the owner-side broker. */
import {isFileQuestion} from '../shared/file-question.ts';
export {isFileQuestion};
export function connectionReadiness(members:string[],identity:(name:string)=>unknown){
 return members.map(name=>({name,connected:Boolean(identity(name))}));
}
export function pendingFileQuestion(messages:Message[]):Message|undefined {
 const request=messages.findLast(m=>m.authorType==='human'&&m.kind==='text'&&!m.direct&&isFileQuestion(m.body));
 if(!request)return;
 if(messages.some(m=>m.id>request.id && m.kind==='summary' && m.privateTo===request.privateTo))return;
 return request;
}
