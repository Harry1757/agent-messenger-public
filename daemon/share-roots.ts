import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateAccess, validRelativePath } from '../shared/resource-access.ts';
import type { SharePolicy, ResourceRequest, AccessDecision } from '../shared/resource-access.ts';
import {relatedPackage} from './related-packages.ts';
import { validateRoot } from './safe-local-files.ts';

interface LocalRoot { policy: SharePolicy; localPath: string; }
interface StoredRoots { version: 1; owner: string; deviceId: string; roots: LocalRoot[]; }
export class ShareRoots {
  readonly deviceId: string;
  private owner: string;
  private file: string;
  private roots: LocalRoot[];
  constructor(home: string, owner: string) {
    if(!owner || typeof owner !== 'string') throw new Error('공유 소유자가 필요합니다');
    this.owner=owner; this.file=path.join(home,'share-roots.json'); this.roots=[];
    if(fs.existsSync(this.file)) {
      try {
        if(fs.lstatSync(this.file).isSymbolicLink()) throw new Error();
        const saved=JSON.parse(fs.readFileSync(this.file,'utf8')) as StoredRoots;
        if(saved.version!==1 || saved.owner!==owner || typeof saved.deviceId!=='string' || !saved.deviceId || !Array.isArray(saved.roots)) throw new Error();
        for(const entry of saved.roots) {
          const p=entry.policy;
          if(!p || p.owner!==owner || p.deviceId!==saved.deviceId || p.source!=='local' || typeof p.id!=='string' || !p.id ||
            typeof p.rootId!=='string' || !p.rootId || !['file','directory'].includes(p.kind) || !validRelativePath(p.prefix) ||
            !Array.isArray(p.audience) || !p.audience.every(x=>typeof x==='string' && !!x) ||
            !(p.threadId===null || typeof p.threadId==='string' && !!p.threadId) || typeof p.revoked!=='boolean' ||
            !Number.isSafeInteger(p.revision) || p.revision<1 || !Array.isArray(p.excluded) || !p.excluded.every(validRelativePath) ||
            typeof entry.localPath!=='string' || !path.isAbsolute(entry.localPath)) throw new Error();
        }
        this.deviceId=saved.deviceId; this.roots=saved.roots;
      } catch { throw new Error('공유 설정이 손상되어 자료 접근을 중지했습니다'); }
    } else { this.deviceId=randomUUID(); this.persist(); }
  }
  private persist() {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const temporary=this.file+'.'+randomUUID()+'.tmp';
    try {
      fs.writeFileSync(temporary,JSON.stringify({version:1,owner:this.owner,deviceId:this.deviceId,roots:this.roots}),{mode:0o600,flag:'wx'});
      fs.renameSync(temporary,this.file);
    } catch { try {fs.unlinkSync(temporary);} catch {} throw new Error('공유 설정을 저장하지 못했습니다'); }
  }
  register(selectedPath: string, kind: 'file'|'directory', audience: string[], threadId: string|null = null): SharePolicy {
    if(!['file','directory'].includes(kind) || !Array.isArray(audience) || !audience.every(x=>typeof x==='string' && !!x) ||
      !(threadId===null || typeof threadId==='string' && !!threadId)) throw new Error('공유 설정이 올바르지 않습니다');
    let localPath:string;
    try {localPath=validateRoot(selectedPath,kind);} catch {throw new Error('선택한 자료를 공유할 수 없습니다');}
    const policy:SharePolicy={id:randomUUID(),rootId:randomUUID(),owner:this.owner,deviceId:this.deviceId,source:'local',
      prefix:'',kind,audience:[...new Set(audience)],threadId,excluded:[],revision:1,revoked:false,label:path.basename(localPath)};
    this.roots.push({policy,localPath});
    try {this.persist();} catch(e) {this.roots.pop();throw e;}
    return structuredClone(policy);
  }
  registerWorkFolder(selectedPath:string):SharePolicy {
    const p=this.register(selectedPath,'directory',[this.owner],null);
    const entry=this.roots.find(r=>r.policy.id===p.id)!;entry.policy.workFolder=true;
    try{this.persist();}catch(error){this.revoke(p.id);throw error;}return structuredClone(entry.policy);
  }
  listPolicies(threadId?: string): SharePolicy[] {
    return this.roots.filter(r=>threadId===undefined || r.policy.threadId===null || r.policy.threadId===threadId).map(r=>structuredClone(r.policy));
  }
  revoke(id: string): void {
    const root=this.roots.find(r=>r.policy.id===id); if(!root) throw new Error('공유 허용을 찾을 수 없습니다');
    if(root.policy.revoked) return;
    const before=structuredClone(root.policy); root.policy.revoked=true; root.policy.revision++;
    try {this.persist();} catch(e) {root.policy=before;throw e;}
  }
  revokeThread(threadId: string): void {
    for(const p of this.listPolicies().filter(p=>p.threadId===threadId)) this.revoke(p.id);
  }
  setExcluded(id: string, excluded: string[]): SharePolicy {
    const root=this.roots.find(r=>r.policy.id===id && !r.policy.revoked);
    if(!root || !Array.isArray(excluded) || !excluded.every(validRelativePath)) throw new Error('제외 경로가 올바르지 않습니다');
    const before=structuredClone(root.policy); root.policy.excluded=[...new Set(excluded)]; root.policy.revision++;
    try {this.persist();} catch(e) {root.policy=before;throw e;}
    return structuredClone(root.policy);
  }
  resolve(request: ResourceRequest): {decision:AccessDecision;policy?:SharePolicy} {
    const policies=this.listPolicies().filter(p=>{
      if(!p.dependency)return true;
      const parent=this.roots.find(r=>r.policy.id===p.dependency!.parentId&&!r.policy.revoked&&r.policy.revision===p.dependency!.parentRevision&&!r.policy.dependency);
      if(!parent||parent.policy.excluded.some(e=>e===''||e==='package.json'))return false;
      const related=relatedPackage(parent.localPath,p.dependency.packageName,parent.policy.excluded);
      return related?.root===this.getRootPath(p.rootId);
    }); const decision=evaluateAccess(request,policies);
    return decision.kind==='allow' ? {decision,policy:policies.find(p=>p.id===decision.policyId)} : {decision};
  }
  registerRelated(requested:string,threadId:string,audience:string[]):SharePolicy|undefined {
    const matches=this.listPolicies(threadId).filter(p=>!p.revoked&&!p.dependency&&p.kind==='directory'&&p.prefix===''&&!p.excluded.some(e=>e===''||e==='package.json')&&(p.workFolder||audience.every(u=>p.audience.includes(u)))).flatMap(parent=>{const found=relatedPackage(this.getRootPath(parent.rootId),requested,parent.excluded);return found?[{parent,found}]:[];});
    if(!matches.length||new Set(matches.map(x=>x.found.root)).size!==1)return;
    const {parent,found}=matches[0];
    if(this.listPolicies(threadId).some(p=>p.revoked&&p.dependency?.parentId===parent.id&&p.dependency?.parentRevision===parent.revision&&p.dependency?.packageName===found.name&&p.threadId===threadId))return;
    const existing=this.listPolicies(threadId).find(p=>!p.revoked&&p.dependency?.parentId===parent.id&&p.dependency?.parentRevision===parent.revision&&p.dependency?.packageName===found.name&&p.threadId===threadId&&audience.every(u=>p.audience.includes(u)));
    if(existing)return existing;
    const p=this.register(found.root,'directory',audience,threadId);const entry=this.roots.find(r=>r.policy.id===p.id)!;
    entry.policy.label=found.name.split('/').at(-1);entry.policy.dependency={parentId:parent.id,parentRevision:parent.revision,packageName:found.name};
    try{this.persist();}catch(error){this.revoke(p.id);throw error;}return structuredClone(entry.policy);
  }
  // Owner-device execution only. Never include this value in transport payloads.
  getRootPath(rootId: string): string {
    const entry=this.roots.find(r=>r.policy.rootId===rootId && !r.policy.revoked);
    if(!entry) throw new Error('공유 자료를 찾을 수 없습니다'); return entry.localPath;
  }
}
