import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Message} from '../shared/types.ts';
export class GithubPending {
 private items=new Map<string,Message>();
 private path:string;
 constructor(path:string){this.path=path;try{for(const m of JSON.parse(readFileSync(path,'utf8')))this.items.set(this.key(m),m);}catch{}}
 private key(m:Message){return JSON.stringify([m.threadId,m.privateTo]);}
 private save(){mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify([...this.items.values()]),{mode:0o600});}
 hold(m:Message){const key=this.key(m);const old=this.items.get(key);if(old && old.id>=m.id)return false;this.items.set(key,m);this.save();return true;}
 forgetThread(threadId:string){for(const [key,m] of this.items)if(m.threadId===threadId)this.items.delete(key);this.save();}
 resume(scheduled:Set<number>,enqueue:(message:Message)=>void){
  for(const message of this.drain()) { scheduled.delete(message.id);enqueue(message); }
 }
 drain(){const items=[...this.items.values()];this.items.clear();this.save();return items;}
}
