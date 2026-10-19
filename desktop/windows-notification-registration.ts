import {existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
export const APP_ID='kr.baro.agentmessenger';
// Must remain stable across upgrades: Action Center can retain old notifications.
export const TOAST_ACTIVATOR_ID='{0D73CF05-A6F3-48F7-B411-814DFA2F0CC5}';
type Shortcut={target?:string;appUserModelId?:string;toastActivatorClsid?:string};
type ShortcutShell={readShortcutLink(path:string):Shortcut;writeShortcutLink(path:string,operation:'create'|'update',details:Record<string,string|number>):boolean};
export function ensureNotificationShortcut({directory,executable,shell}:{directory:string;executable:string;shell:ShortcutShell}):'created'|'updated'|'unchanged'{
 const file=join(directory,'Agent Messenger.lnk');
 const exists=existsSync(file);
 if(exists){
  const current=shell.readShortcutLink(file);
  if(current.target?.toLowerCase()===executable.toLowerCase() && current.appUserModelId===APP_ID && current.toastActivatorClsid?.toUpperCase()===TOAST_ACTIVATOR_ID)return 'unchanged';
  copyFileSync(file,`${file}.backup-${Date.now()}`);
 }
 mkdirSync(directory,{recursive:true});
 // update preserves the installer's existing arguments and description.
 const details={target:executable,appUserModelId:APP_ID,toastActivatorClsid:TOAST_ACTIVATOR_ID,...(!exists?{cwd:dirname(executable),description:'팀 에이전트 메신저',icon:executable,iconIndex:0}:{})};
 if(!shell.writeShortcutLink(file,exists?'update':'create',details))throw Error('Windows notification shortcut registration failed');
 return exists?'updated':'created';
}
