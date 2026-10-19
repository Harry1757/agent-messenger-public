import {randomUUID,createHash} from 'node:crypto';
type Scope={owner:string;thread:string;repo:string;path:string;audience:string[];binding:string};
export class FileReadGrants {
 private grants=new Map<string,Scope & {expiresAt:number}>();
 issue(scope:Scope){for(const [id,g] of this.grants)if(g.expiresAt<=Date.now())this.grants.delete(id);const id=randomUUID();this.grants.set(id,{...scope,expiresAt:Date.now()+60000});return id;}
 consume(id:string,owner:string,thread:string,audience:string[],binding:string,body:string){
  const g=this.grants.get(id);this.grants.delete(id);
  if(!g||g.expiresAt<=Date.now()||g.owner!==owner||g.thread!==thread||g.binding!==binding||JSON.stringify(g.audience)!==JSON.stringify(audience))return false;
  const m=body.match(/^공통 저장소에서 확인한 파일 내용: ([^\n]+)\n내용 해시: ([a-f0-9]{64})\n\n([\s\S]*)$/);
  return !!m&&m[1]===g.path&&createHash('sha256').update(m[3]).digest('hex')===m[2];
 }
}
