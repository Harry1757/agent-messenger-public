import {test} from 'node:test';import assert from 'node:assert/strict';
import {chatClaudeArgs,runAgent} from '../daemon/agent.ts';
test('Claude chat removes tools, customizations and old session/workspace inheritance',()=>{
 const args=chatClaudeArgs({tool:'claude',command:'claude',cwd:'/private',sessionId:'old',threadId:'t',prompt:'p',systemPrompt:'s',addDirs:['/'],model:'sonnet'});
 assert.equal(args[args.indexOf('--tools')+1],'');for(const flag of ['--safe-mode','--restricted','--strict-mcp-config','--no-session-persistence'])assert(args.includes(flag));assert(!args.includes('--resume'));assert(!args.includes('--add-dir'));
});
test('unsupported agent fails closed',async()=>{const r=await runAgent({tool:'other',command:'other',cwd:'/',sessionId:null,threadId:'t',prompt:'p',systemPrompt:'s',addDirs:[]});assert.equal(r.ok,false);assert.equal(r.text,'');});
