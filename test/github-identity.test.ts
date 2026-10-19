import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {GithubIdentities} from '../server/github-identity.ts';
import {sealIdentity} from '../shared/github-envelope.ts';
test('identity is verified by GitHub, bound to owner, expires, and cannot replay',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const ids=new GithubIdentities(privateKey,async token=>{assert.equal(token,'test-credential');return {id:42,login:'actual-user'};});
 const c=ids.challenge('owner');
 const blob=sealIdentity(publicKey,{...c,owner:'owner',token:'test-credential'});
 await assert.rejects(ids.connect('other',blob));
 await ids.connect('owner',blob);
 assert.equal(ids.get('owner')?.login,'actual-user');
 assert.equal(ids.get('other'),null);
 await assert.rejects(ids.connect('owner',blob));
 assert.equal(ids.get('owner',Date.now()+16*60*1000),null);
});
test('failed GitHub verification never binds claimed identity',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const ids=new GithubIdentities(privateKey,async()=>{throw Error('credential rejected');});
 const blob=sealIdentity(publicKey,{...ids.challenge('owner'),owner:'owner',token:'bad'});
 await assert.rejects(ids.connect('owner',blob));assert.equal(ids.get('owner'),null);
});
