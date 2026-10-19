import type {Message} from '../shared/types.ts';
import {extractMentions} from '../shared/mentions.ts';
export class LatestRequests {
 private latest=new Map<string,number>();
 private key(m:Message){return JSON.stringify([m.threadId,m.privateTo]);}
 observe(m:Message,me:string){
  if(m.direct || m.authorType!=='human' || !['text','decision_result'].includes(m.kind) || !extractMentions(m.body).includes(me))return;
  const k=this.key(m);this.latest.set(k,Math.max(this.latest.get(k)||0,m.id));
 }
 superseded(m:Message){return (this.latest.get(this.key(m))||0)>m.id;}
}
