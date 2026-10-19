import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('async function sendComposerMessage()'),source.indexOf('let mentionChoices'));
function fixture(){
 let calls=0,release:()=>void=()=>{};
 const input={value:'hello'},button={disabled:false};
 const context:any={composerSending:false,$:(id:string)=>id==='input'?input:button,current:{id:'t'},currentRoute:()=>({targets:[]}),routingMentions:()=>[],routeKey:()=>'',privateOn:false,myName:'me',localStorage:{getItem:()=>null},sendMessage:()=>{calls++;return new Promise<void>(r=>{release=r;});}};
 runInNewContext(fn+';this.send=sendComposerMessage',context);
 return {context,button,calls:()=>calls,release:()=>release()};
}
test('repeated submit while request is pending sends only once, then unlocks',async()=>{
 const f=fixture();const first=f.context.send();void f.context.send();void f.context.send();
 assert.equal(f.calls(),1);assert.equal(f.button.disabled,true);
 f.release();await first;assert.equal(f.button.disabled,false);
 const next=f.context.send();assert.equal(f.calls(),2);f.release();await next;
});
test('failed request unlocks the composer for retry',async()=>{
 const f=fixture();f.context.sendMessage=async()=>{throw Error('offline');};
 await assert.rejects(f.context.send(),/offline/);assert.equal(f.button.disabled,false);assert.equal(f.context.composerSending,false);
});
