import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureNotificationShortcut,APP_ID,TOAST_ACTIVATOR_ID} from '../desktop/windows-notification-registration.ts';
test('NSIS shortcut missing activation id is backed up and repaired without changing args',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shortcut-test-'));const file=join(directory,'Agent Messenger.lnk');writeFileSync(file,'original shortcut');
 let written:any;
 const result=ensureNotificationShortcut({directory,executable:'app.exe',shell:{readShortcutLink:()=>({target:'app.exe',appUserModelId:APP_ID,toastActivatorClsid:'',args:'--saved'}),writeShortcutLink:(path,operation,details)=>{written={path,operation,details};return true}}});
 assert.equal(result,'updated');assert.equal(written.operation,'update');assert.equal(written.details.toastActivatorClsid,TOAST_ACTIVATOR_ID);assert.equal(written.details.args,undefined);
 const backup=readdirSync(directory).find(f=>f.includes('.backup-'));assert.ok(backup);assert.equal(readFileSync(join(directory,backup),'utf8'),'original shortcut');
});
test('correct shortcut survives restart without rewriting',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shortcut-test-'));writeFileSync(join(directory,'Agent Messenger.lnk'),'same');
 assert.equal(ensureNotificationShortcut({directory,executable:'app.exe',shell:{readShortcutLink:()=>({target:'app.exe',appUserModelId:APP_ID,toastActivatorClsid:TOAST_ACTIVATOR_ID}),writeShortcutLink:()=>{throw Error('must not write')}}}),'unchanged');
});
test('missing shortcut is created with target and both Windows ids',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shortcut-test-'));let written:any;
 ensureNotificationShortcut({directory,executable:'app.exe',shell:{readShortcutLink:()=>{throw Error('missing')},writeShortcutLink:(_p,op,details)=>{written={op,details};return true}}});
 assert.equal(written.op,'create');assert.equal(written.details.target,'app.exe');assert.equal(written.details.appUserModelId,APP_ID);assert.equal(written.details.toastActivatorClsid,TOAST_ACTIVATOR_ID);
});
test('failed shortcut registration is reported',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shortcut-test-'));
 assert.throws(()=>ensureNotificationShortcut({directory,executable:'app.exe',shell:{readShortcutLink:()=>({}),writeShortcutLink:()=>false}}),/shortcut/);
});
