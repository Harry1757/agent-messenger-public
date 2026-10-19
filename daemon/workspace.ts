import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

function hasGit(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** 한 작업 폴더 바로 아래에서 저장소 이름을 모은다. 한 단계만 본다 — 재귀하지 않는다. */
function reposUnder(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  if (hasGit(root)) return [basename(root)];

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && hasGit(join(root, entry.name))) names.push(entry.name);
  }
  return names;
}

/**
 * 작업 폴더(들) 아래의 git 저장소 이름을 정렬·중복 제거해 돌려준다.
 * 없거나 읽을 수 없는 경로는 건너뛴다 — 던지지 않는다.
 */
export function findRepos(workspace: string | string[]): string[] {
  const roots = Array.isArray(workspace) ? workspace : [workspace];
  const names = new Set<string>();
  for (const root of roots) {
    for (const name of reposUnder(root)) names.add(name);
  }
  return [...names].sort();
}

/** 문자열이면 [값], 배열이면 그대로. 첫 번째가 작업 디렉터리, 나머지가 addDirs. */
export function workspaceRoots(config: { workspace: string | string[] }): string[] {
  return Array.isArray(config.workspace) ? config.workspace : [config.workspace];
}

/** 시작 시 OS 폴더 접근 응답이 지연되어도 연결·알림은 계속 시작한다. */
export async function findReposForStartup(workspace: string | string[], timeoutMs=3000):Promise<string[]> {
  const fs=await import('node:fs/promises');
  const roots=Array.isArray(workspace)?workspace:[workspace];
  let timer:ReturnType<typeof setTimeout>;
  const scan=Promise.all(roots.map(async root=>{
    try {
      if(await fs.stat(join(root,'.git')).then(()=>true,()=>false))return [basename(root)];
      const entries=await fs.readdir(root,{withFileTypes:true});
      const repos=await Promise.all(entries.filter(e=>e.isDirectory()).map(async e=>await fs.stat(join(root,e.name,'.git')).then(()=>e.name,()=>null)));
      return repos.filter((name):name is string=>name!==null);
    }catch{return [];}
  })).then(groups=>[...new Set(groups.flat())].sort());
  const timeout=new Promise<string[]>(resolve=>{timer=setTimeout(()=>{console.warn('[작업 폴더] 목록 확인 지연 — 메신저 연결을 먼저 시작합니다.');resolve([]);},timeoutMs);});
  try{return await Promise.race([scan,timeout]);}finally{clearTimeout(timer!);}
}
