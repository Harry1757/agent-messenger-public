import {test} from 'node:test';
import assert from 'node:assert/strict';
import {githubRepo, checkCommonAccess, githubLogin} from '../daemon/github-access.ts';
test('only exact GitHub origins are accepted',()=>{
 assert.equal(githubRepo('git@github.com:team/repo.git'),'team/repo');
 assert.equal(githubRepo('https://github.com/team/repo.git'),'team/repo');
 for(const s of ['https://github.com.evil/team/repo','https://token@github.com/team/repo','/home/repo','git@github.com:../repo'])assert.equal(githubRepo(s),null);
});
test('missing gh/login gives actionable status without raw errors',async()=>{
 assert.equal((await githubLogin(async()=>({error:Error('secret'),stdout:'',stderr:'secret'}))).ok,false);
});
test('every participant must have verified identity and explicit repo permission',async()=>{
 const run=async (_:string,args:string[])=>({error:null,stdout:JSON.stringify({permission:args.join('').includes('bob')?'none':'read'}),stderr:''});
 assert.equal((await checkCommonAccess('team/repo',[{login:'alice'},{login:'bob'}],run)).common,false);
 assert.equal((await checkCommonAccess('team/repo',[{login:'alice'},null],run)).common,false);
 assert.equal((await checkCommonAccess('team/repo',[{login:'alice'}],run)).common,true);
 assert.equal((await checkCommonAccess('team/repo',[],run)).common,false);
});
