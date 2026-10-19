import type {Message,AgentState} from '../shared/types.ts';
export const REMINDER_INTERVAL_MS = 2 * 60 * 1000;
type Send = (title:string,body:string,message:Message)=>void;
function decisionPreview(message:Message):string {
  try {
    const data=JSON.parse(message.body);
    return [data.question,data.summary].filter(x=>typeof x==='string' && x.trim()).join('\n').slice(0,180) || '결정 요청함에서 선택하거나 직접 답변해 주세요.';
  } catch { return '결정 요청함에서 선택하거나 직접 답변해 주세요.'; }
}
export class DecisionReminders {
  private hidden = new Set<string>();
  private waiting = new Map<number,{message:Message;next:number}>();
  private me: string;
  private send: Send;
  private open: (message:Message)=>void;
  constructor(me:string,send:Send,open:(message:Message)=>void=()=>{}) {this.me=me;this.send=send;this.open=open;}
  observe(message:Message,now=Date.now(),announce=true):void {
    if(this.hidden.has(message.threadId))return;
    if (message.kind === 'decision_result' && message.decisionRequestId) {
      this.waiting.delete(message.decisionRequestId); return;
    }
    if (message.kind !== 'decision_request' || message.author !== this.me || this.waiting.has(message.id)) return;
    this.waiting.set(message.id,{message,next:now+REMINDER_INTERVAL_MS});
    if (announce) {
      this.send('판단이 필요합니다',decisionPreview(message),message);
      this.open(message);
    }
  }
  forgetThread(threadId:string):void {this.hidden.add(threadId);for(const [id,p] of this.waiting)if(p.message.threadId===threadId)this.waiting.delete(id);}
  reconcile(messages:Message[],now=Date.now()):void {
    const visible=new Set(messages.filter(m=>m.kind==='decision_request').map(m=>m.id));
    for(const id of this.waiting.keys())if(!visible.has(id))this.waiting.delete(id);
    const answered=new Set(messages.filter(m=>m.kind==='decision_result').map(m=>m.decisionRequestId));
    for (const id of this.waiting.keys()) if(answered.has(id))this.waiting.delete(id);
    for (const m of messages) if(!answered.has(m.id))this.observe(m,now,false);
  }
  tick(now=Date.now()):void {
    for(const pending of this.waiting.values()) {
      if(now<pending.next)continue;
      this.send('답변을 기다리고 있어요',decisionPreview(pending.message),pending.message);
      pending.next=now+REMINDER_INTERVAL_MS;
    }
  }
}
export function shouldNotifyCompletion(kind:string,body:string,me:string):boolean {
  return kind==='summary';
}

// Notify as soon as the conversation is idle; no artificial quiet-period delay.
export const COMPLETION_DELAY_MS = 0;
export class CompletionNotifications {
  private pending = new Map<string,{message:Message;due:number}>();
  private seen = new Set<number>();
  private completed = new Set<string>();
  private busy = new Map<string,string>();
  private me:string;
  private send:(message:Message)=>void;
  constructor(me:string,send:(message:Message)=>void){this.me=me;this.send=send;}
  forgetThread(threadId:string):void {this.pending.delete(threadId);this.completed.delete(threadId);}
  observeAgent(state:AgentState):void {
    if(state.online && state.busyThreadId)this.busy.set(state.user,state.busyThreadId);
    else this.busy.delete(state.user);
    this.tick();
  }
  observe(message:Message,now=Date.now()):void {
    if(message.privateTo!==null)return;
    if(this.seen.has(message.id))return;
    this.seen.add(message.id);
    if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!);
    this.pending.delete(message.threadId);
    if(message.authorType==='human'){this.completed.delete(message.threadId);return;}
    if(message.kind!=='summary' || this.completed.has(message.threadId))return;
    this.pending.set(message.threadId,{message,due:now+COMPLETION_DELAY_MS});
    this.tick(now);
  }
  tick(now=Date.now()):void {
    for(const [threadId,item] of this.pending){
      if(now<item.due || [...this.busy.values()].includes(threadId))continue;
      this.pending.delete(threadId);this.completed.add(threadId);this.send(item.message);
    }
  }
}
