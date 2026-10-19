import {build} from 'esbuild';
import {cpSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
mkdirSync('desktop-dist',{recursive:true});
if(process.platform==='darwin' || process.platform==='linux') {
  mkdirSync('desktop-dist/native',{recursive:true});
  execFileSync('clang',['-std=c11','-O2','-Wall','-Wextra','daemon/native/safe-files.c','-o','desktop-dist/native/safe-files'],{stdio:'inherit'});
}
await build({entryPoints:['desktop/main.ts'],outfile:'desktop-dist/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','node-notifier','electron-updater']});
await build({entryPoints:['daemon/main.ts'],outfile:'desktop-dist/daemon.mjs',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
for(const name of ['preload.cjs','messenger-preload.cjs','setup.html','setup.js'])cpSync(`desktop/${name}`,`desktop-dist/${name}`);
cpSync('build/icon.png','desktop-dist/icon.png');
