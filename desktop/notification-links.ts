import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function toastXml(id:string,title:string,body:string,choices:string[]=[],reply=false){
  const args=(type:string)=>escape(`type=${type}&tag=${encodeURIComponent(id)}`);
  return `<toast launch="${args('click')}"${reply?' scenario="reminder"':''}><visual><binding template="ToastGeneric"><text>${escape(title)}</text><text>${escape(body)}</text></binding></visual>${reply?`<actions><input id="reply" type="text" placeHolderContent="직접 답변을 입력하세요"/>${choices.map((choice,i)=>`<action activationType="foreground" arguments="${args('action')}&amp;action=${i}" content="${escape(choice)}"/>`).join('')}<action activationType="foreground" arguments="${args('reply')}" content="답변 보내기" hint-inputId="reply"/><action activationType="system" arguments="dismiss" content="닫기"/></actions>`:''}</toast>`;
}
export class NotificationLinks {
  private entries:Record<string,{account:string;path:string}>={};
  private file:string;
  constructor(file:string){this.file=file;try{this.entries=JSON.parse(readFileSync(file,'utf8'));}catch{}}
  save(id:string,account:string,url:string,server:string){
    const target=new URL(url),base=new URL(server);
    if(target.origin!==base.origin || !['/','/decisions.html'].includes(target.pathname))return;
    this.entries[id]={account,path:target.pathname+target.search+target.hash};
    const keys=Object.keys(this.entries);for(const key of keys.slice(0,Math.max(0,keys.length-500)))delete this.entries[key];
    mkdirSync(dirname(this.file),{recursive:true});writeFileSync(this.file+'.tmp',JSON.stringify(this.entries),{mode:0o600});renameSync(this.file+'.tmp',this.file);
  }
  forgetThread(account:string,threadId:string):string[]{
    const ids=Object.keys(this.entries).filter(id=>{const e=this.entries[id];return e.account===account&&new URLSearchParams(new URL(e.path,'http://local').hash.slice(1)).get('thread')===threadId;});
    if(!ids.length)return [];
    for(const id of ids)delete this.entries[id];
    mkdirSync(dirname(this.file),{recursive:true});writeFileSync(this.file+'.tmp',JSON.stringify(this.entries),{mode:0o600});renameSync(this.file+'.tmp',this.file);
    return ids;
  }
  resolve(args:string,account:string,server:string){
    const id=new URLSearchParams(args).get('tag');const entry=id?this.entries[id]:undefined;
    if(!entry || entry.account!==account)return undefined;
    const url=new URL(entry.path,server);return url.origin===new URL(server).origin?url.href:undefined;
  }
}
