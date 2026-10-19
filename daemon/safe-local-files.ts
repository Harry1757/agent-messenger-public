import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { validRelativePath, pathWithin } from '../shared/resource-access.ts';
import { inspectSensitive, isSensitivePath } from './sensitive-content.ts';
import { windowsSafeOperation, windowsSafeMutation } from './windows-safe-files.ts';

function fail(): never { throw new Error('공유 범위 또는 안전한 파일 확인에 실패했습니다'); }
export function validateRoot(selectedPath: string, kind: 'file'|'directory'): string {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath) || /[\x00-\x1f]/.test(selectedPath) ||
      /^\\\\/.test(selectedPath) || selectedPath.split(/[\\/]/).some(p => p === '..') ||
      (process.platform === 'win32' && (!/^[A-Za-z]:\\/.test(selectedPath) || selectedPath.slice(2).includes(':')))) fail();
  const root = path.resolve(selectedPath);
  const comparable=(p:string)=>process.platform==='win32' ? p.toLowerCase() : p;
  if (comparable(root) === comparable(path.parse(root).root) || comparable(root) === comparable(path.resolve(os.homedir()))) fail();
  if (process.platform === 'win32') windowsSafeOperation(root,'',kind === 'file' ? 'validate-file' : 'validate-directory');
  else {
    nativeOperation(root,'',kind === 'file' ? 'validate-file' : 'validate-directory');
  }
  return root;
}
function nativeOperation(root:string,relative:string,operation:string,maxBytes=262144,mutation?:{backupPath:string;input:Buffer}): Buffer {
  const directory=process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
  const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
  const candidates=[path.join(directory,'native','safe-files'),path.join(directory,'..','desktop-dist','native','safe-files'),
    path.join(process.cwd(),'desktop-dist','native','safe-files')];
  if(resources) candidates.unshift(path.join(resources,'app','desktop-dist','native','safe-files'));
  const helper=candidates.find(p=>fs.existsSync(p)); if(!helper) fail();
  const args=[root,relative,operation,String(maxBytes)]; if(mutation) args.push(mutation.backupPath);
  const result=spawnSync(helper,args,{input:mutation?.input,timeout:10000,maxBuffer:1024*1024});
  if(result.error || result.status!==0) fail();
  return result.stdout;
}
function targetPath(root: string, relative: string): string {
  if (!validRelativePath(relative) || !path.isAbsolute(root)) fail();
  const target=path.resolve(root,relative);
  if (target !== root && !target.startsWith(root+path.sep)) fail();
  return target;
}
export interface SafeListOptions { excluded?: string[]; maxEntries?: number; maxDepth?: number; }
export function safeReadText(root: string, relativePath: string, options: {maxBytes?: number} = {}): {text:string;hash:string;sensitive:boolean;redacted:string;digest:string} {
  try {
    targetPath(root,relativePath);
    // Known secret stores are never opened, even when the entire file is selected.
    const scanPath = relativePath || path.basename(root);
    if (isSensitivePath(scanPath)) throw new Error('sensitive-file');
    const maxBytes = Math.max(1,Math.min(262144,options.maxBytes ?? 262144));
    let bytes: Buffer;
    if (process.platform === 'win32') bytes=Buffer.from(windowsSafeOperation(root,relativePath,'read',maxBytes),'base64');
    else bytes=nativeOperation(root,relativePath,'read',maxBytes);
    if (bytes.includes(0)) fail();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const inspected=inspectSensitive(text,scanPath);
    return {...inspected,text:inspected.redacted,hash:inspected.digest};
  } catch { throw new Error('파일을 안전하게 읽을 수 없습니다'); }
}
export function safeList(root: string, relativePath = '', options: SafeListOptions = {}): {paths:string[];truncated:boolean} {
  try {
    const excluded=options.excluded ?? [];
    if(excluded.some(p => !validRelativePath(p))) fail();
    const maxEntries=Math.max(1,Math.min(200,options.maxEntries ?? 200));
    const maxDepth=Math.max(0,Math.min(4,options.maxDepth ?? 4));
    const paths:string[]=[]; let truncated=false;
    const walk=(relative:string,depth:number) => {
      if(excluded.some(p => pathWithin(relative,p)) || isSensitivePath(relative || path.basename(root))) return;
      targetPath(root,relative);
      const directories=new Set<string>();
      const records=process.platform==='win32' ? windowsSafeOperation(root,relative,'list') : nativeOperation(root,relative,'list').toString('utf8');
      const names=records.split('\n').filter(Boolean).map(record=>{
        const name=record.slice(2); if(record.startsWith('d\t')) directories.add(name); return name;
      });
      if(names.length>=201) truncated=true;
      for(const name of names.sort()) {
        const child=relative ? relative+'/'+name : name;
        if(!validRelativePath(child) || excluded.some(p=>pathWithin(child,p)) || isSensitivePath(child)) continue;
        if(paths.length>=maxEntries) { truncated=true; return; }
        const directory=directories.has(name);
        paths.push(child+(directory?'/':''));
        if(directory) { if(depth<maxDepth&&!['.git','node_modules','.next','dist','build','coverage','.cache'].includes(name)) walk(child,depth+1); else truncated=true; }
        if(paths.length>=maxEntries) { truncated=true; return; }
      }
    };
    walk(relativePath,0); return {paths,truncated};
  } catch { throw new Error('파일 목록을 안전하게 확인할 수 없습니다'); }
}

/** Local execution only, after the broker has consumed an exact owner approval. */
export function safeMutateText(root:string,relativePath:string,operation:'write'|'delete',expected:string,content:string,backupPath:string):void {
  try {
    targetPath(root,relativePath);
    if(!path.isAbsolute(backupPath) || isSensitivePath(relativePath || path.basename(root)) ||
      inspectSensitive(expected,relativePath).sensitive || inspectSensitive(content,relativePath).sensitive) fail();
    const before=Buffer.from(expected),after=Buffer.from(content);
    if(before.length>262144 || after.length>262144 || before.includes(0) || after.includes(0)) fail();
    if(process.platform==='win32') windowsSafeMutation(root,relativePath,operation,before.toString('base64'),after.toString('base64'),backupPath);
    else {
      const header=Buffer.alloc(8);header.writeUInt32LE(before.length,0);header.writeUInt32LE(after.length,4);
      nativeOperation(root,relativePath,operation,262144,{backupPath,input:Buffer.concat([header,before,after])});
    }
  }catch {throw new Error('파일 상태가 바뀌었거나 안전한 변경을 수행할 수 없습니다. 다시 확인하고 승인해 주세요');}
}
