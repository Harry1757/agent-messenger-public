import {createReadStream,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline';
const paths = new Map<string,string>();
/** Codex JSON output has no response model; report only the recorded CLI turn model. */
export async function readCodexModel(sessionId:string,root=join(process.env.CODEX_HOME ?? join(homedir(),'.codex'),'sessions')):Promise<string|null> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return null;
  try {
    const key=root+':'+sessionId;
    let file=paths.get(key);
    if (!file) {
      const name=readdirSync(root,{recursive:true}).find(p=>typeof p==='string' && p.endsWith(sessionId+'.jsonl'));
      if(typeof name!=='string')return null;
      file=join(root,name);paths.set(key,file);
    }
    let model:string|null=null;
    const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});
    for await (const line of lines) {
      try { const e=JSON.parse(line);if(e.type==='turn_context' && typeof e.payload?.model==='string')model=e.payload.model; } catch {}
    }
    return model;
  } catch {return null;}
}
