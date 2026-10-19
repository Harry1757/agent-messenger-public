import fs from 'node:fs';
import path from 'node:path';
import {pathWithin} from '../shared/resource-access.ts';
import {safeReadText,validateRoot} from './safe-local-files.ts';
/** Resolve direct, declared local/installed dependencies only. Never search the PC. */
export function relatedPackage(root:string,requested:string,excluded:string[]=[]):{name:string;root:string}|null {
 try{
  const blocked=(target:string)=>{const relative=path.relative(root,target).split(path.sep).join('/');return !relative.startsWith('../')&&!path.isAbsolute(relative)&&excluded.some(e=>pathWithin(relative,e));};
  if(excluded.some(e=>pathWithin('package.json',e)))return null;
  const manifest=JSON.parse(safeReadText(root,'package.json').text);
  const deps={...manifest.dependencies,...manifest.devDependencies,...manifest.peerDependencies,...manifest.optionalDependencies};
  const names=Object.keys(deps).filter(name=>name===requested||name.split('/').at(-1)===requested);
  if(names.length!==1)return null;
  const name=names[0];if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))return null;
  const spec=deps[name];if(typeof spec!=='string')return null;
  const candidates:string[]=[];
  if(/^(file|link):/.test(spec)){
   const relative=spec.slice(spec.indexOf(':')+1);
   if(!relative||path.isAbsolute(relative)||/[\\:\x00-\x1f]/.test(relative))return null;
   candidates.push(path.resolve(root,relative));
  }else candidates.push(path.join(root,'node_modules',...name.split('/')));
  for(const candidate of candidates){try{
   if(blocked(candidate))continue;
   const target=validateRoot(fs.realpathSync(candidate),'directory');
   if(blocked(target))continue;
   if(target===fs.realpathSync(root))continue;
   const linked=JSON.parse(safeReadText(target,'package.json').text);
   if(linked.name===name)return {name,root:target};
  }catch{}}
 }catch{}
 return null;
}
