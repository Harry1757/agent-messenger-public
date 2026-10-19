/** Connection metadata only; never retain URLs, bearer tokens or message contents. */
export interface DaemonConnectionStatus {
 connected:number;
 compatible:number;
 legacy:number;
 /** At least one connected daemon understands resource and explicit delegation messages. */
 resourceAccess:boolean;
}
export class DaemonConnections {
 private links=new Map<symbol,{user:string;protocol:string}>();
 add(user:string,protocol:string){const id=Symbol();this.links.set(id,{user,protocol});return ()=>{this.links.delete(id);};}
 status(user:string):DaemonConnectionStatus{
  const links=[...this.links.values()].filter(x=>x.user===user);
  const compatible=links.filter(x=>['conversation-only-v1','resource-access-v2'].includes(x.protocol)).length;
  return {connected:links.length,compatible,legacy:links.length-compatible,resourceAccess:links.some(x=>x.protocol==='resource-access-v2')};
 }
}
