import type {Message,ServerEvent} from '../shared/types.ts';
import {extractMentions} from '../shared/mentions.ts';
// Old installed daemons infer agent calls from ASCII @ even during history recovery.
// Preserve the stored message; expose display-only @ in their compatible text view.
export function directForLegacyDaemon(message:Message):Message {
  return message.direct ? {...message,body:message.body.replace(/@/g,'＠')} : message;
}
export function directEvent(event:ServerEvent,user:string):ServerEvent|null {
  if(event.type!=='message'||!event.message.direct)return event;
  const targets=extractMentions(event.message.body);
  if(targets.length && !targets.includes(user))return null;
  return {...event,message:directForLegacyDaemon(event.message)};
}
