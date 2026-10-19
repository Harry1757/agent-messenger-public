export type ResourceSource = 'local' | 'github';
export type ResourceAction = 'list' | 'read' | 'write' | 'delete';
export interface ResourceRequest {
  id: string; owner: string; deviceId: string; requester: string;
  threadId: string; audience: string[]; generation: number;
  source: ResourceSource; rootId: string; relativePath: string; action: ResourceAction;
}
export interface SharePolicy {
  id: string; owner: string; deviceId: string; source: ResourceSource;
  rootId: string; prefix: string; kind: 'file' | 'directory';
  audience: string[]; threadId: string | null; excluded: string[];
  revision: number; revoked: boolean; label?: string; workFolder?: boolean; dependency?: {parentId:string;parentRevision:number;packageName:string};
}
export type AccessDecision =
  | {kind: 'allow'; policyId: string; revision: number}
  | {kind: 'ask-owner'; reason: 'outside-scope' | 'audience-changed' | 'sensitive' | 'mutation'}
  | {kind: 'deny'; reason: string};
export interface ResourceReceipt {
  id: string; requestId: string; owner: string; deviceId: string;
  threadId: string; audience: string[]; generation: number;
  policyId: string; revision: number; contentHash: string; expiresAt: number;
}
export type RequestState = 'running' | 'reading' | 'waiting-owner' |
  'waiting-connection' | 'completed' | 'denied' | 'failed' | 'cancelled';

// Use one portable spelling. Reject ambiguous Windows aliases even on Unix.
export function validRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && (value === '' ||
    (!/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => !!part && part !== '.' && part !== '..' &&
      !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))));
}
export function pathWithin(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(prefix + '/');
}
export function sameAudience(a: string[], b: string[]): boolean {
  return Array.isArray(a) && Array.isArray(b) && a.length > 0 && b.length > 0 &&
    a.every(x => typeof x === 'string' && !!x) && b.every(x => typeof x === 'string' && !!x) &&
    new Set(a).size === new Set(b).size && a.every(x => b.includes(x));
}
export function evaluateAccess(request: ResourceRequest, policies: SharePolicy[]): AccessDecision {
  if (!validRelativePath(request.relativePath) || !request.owner || !request.deviceId || !request.threadId ||
      !request.requester || !Array.isArray(request.audience) || !request.audience.includes(request.requester) ||
      !request.audience.includes(request.owner) || !Number.isSafeInteger(request.generation) || request.generation < 0 ||
      !['local','github'].includes(request.source) || !['read','list','write','delete'].includes(request.action)) {
    return {kind:'deny',reason:'invalid-request'};
  }
  const candidates = policies.filter(p => !p.revoked && p.owner === request.owner && p.deviceId === request.deviceId &&
    p.rootId === request.rootId && p.source === request.source && (p.threadId === null || p.threadId === request.threadId) &&
    validRelativePath(p.prefix) && (p.kind === 'directory' ? pathWithin(request.relativePath,p.prefix) : request.relativePath === p.prefix));
  if (candidates.some(p => !Array.isArray(p.excluded) || p.excluded.some(ex => !validRelativePath(ex) || pathWithin(request.relativePath,ex)))) {
    return {kind:'deny',reason:'excluded'};
  }
  if (request.action === 'write' || request.action === 'delete') return {kind:'deny',reason:'read-only'};
  const match = candidates.find(p => Array.isArray(p.audience) && request.audience.length>0 && (p.workFolder===true || request.audience.every(person=>p.audience.includes(person))) && Number.isSafeInteger(p.revision) && p.revision > 0 &&
    (request.action !== 'list' || p.kind === 'directory'));
  return match ? {kind:'allow',policyId:match.id,revision:match.revision} :
    {kind:'ask-owner',reason:candidates.length ? 'audience-changed' : 'outside-scope'};
}
