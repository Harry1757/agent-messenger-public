import type {Message} from '../shared/types.ts';
import {extractMentions} from '../shared/mentions.ts';

/** 접근 권한·참여자 필터를 통과해 내 SSE로 전달된 공개 직접 대화만 알린다. */
export class DirectNotifications {
  private seen=new Set<number>();
  private me:string;
  private deliver:(message:Message)=>void;
  constructor(me:string,deliver:(message:Message)=>void){this.me=me;this.deliver=deliver;}
  observe(message:Message){
    if(message.authorType!=='human'||message.kind!=='text'||message.privateTo!==null||message.author===this.me||extractMentions(message.body).length)return;
    if(this.seen.has(message.id))return;
    this.seen.add(message.id);
    if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!);
    this.deliver(message);
  }
}
