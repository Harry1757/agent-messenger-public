import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {relatedPackage} from '../daemon/related-packages.ts';
import {ShareRoots} from '../daemon/share-roots.ts';
test('installed direct package resolves by manifest identity; comments and undeclared siblings do not',()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'related-')));try{
 const root=path.join(dir,'app'),kit=path.join(root,'node_modules','design-kit');fs.mkdirSync(kit,{recursive:true});fs.writeFileSync(path.join(kit,'package.json'),JSON.stringify({name:'design-kit'}));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{'design-kit':'1.0.0'},description:'unrelated-kit is related'}));
 assert.equal(relatedPackage(root,'design-kit')?.root,kit);assert.equal(relatedPackage(root,'unrelated-kit'),null);assert.equal(relatedPackage(root,'design-kit',['node_modules']),null);assert.equal(relatedPackage(root,'design-kit',['package.json']),null);
 const roots=new ShareRoots(path.join(dir,'home'),'alice');roots.registerWorkFolder(root);const p=roots.registerRelated('design-kit','thread',['alice','bob'])!;assert(p);roots.revoke(p.id);assert.equal(roots.registerRelated('design-kit','thread',['alice','bob']),undefined);
 fs.writeFileSync(path.join(root,'package.json'),'{}');assert.equal(relatedPackage(root,'design-kit'),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
