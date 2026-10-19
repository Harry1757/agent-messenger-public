import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectSensitive} from '../daemon/sensitive-content.ts';
test('redacts fake credentials and hashes original content for one-time approval',()=>{
 const secret='ghp_'+'x'.repeat(32); const text='const token="'+secret+'";';
 const got=inspectSensitive(text,'src/config.ts');
 assert.equal(got.sensitive,true); assert.equal(got.redacted.includes(secret),false);
 assert.notEqual(got.digest,inspectSensitive(text+'\n','src/config.ts').digest);
 assert.equal(inspectSensitive('hello','readme.md').sensitive,false);
});
test('secret file names, multiline keys, common assignments and URLs never expose fake values',()=>{
 for(const [text,file,secret] of [
 ['ANYTHING','.env','ANYTHING'], ['secret content','private.pem','secret content'],
 ['password: "fake-password"','config.json','fake-password'],
 ['-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----','file.txt','fake-key'],
 ['https://bob:fake-password@example.com','file.txt','fake-password'],
 ]) {const got=inspectSensitive(text,file);assert.equal(got.sensitive,true);assert.equal(got.redacted.includes(secret),false);}
});
test('normal config identifiers, nonsecret primitives, environment references and empty defaults are unchanged',()=>{
 const text='const config = { tokenBudget: 4096, passwordMinLength: 8, apiKeyRequired: true, token: null, secret: false, password: "", apiKey: process.env.API_KEY, accessToken: import.meta.env.TOKEN };';
 const checked=inspectSensitive(text,'src/config.ts');assert.equal(checked.sensitive,false);assert.equal(checked.redacted,text);
});
test('exact literal credential fields, nested compact JSON, URL query keys and cloud keys still redact',()=>{
 for(const [text,secret] of [
  ['const config={password:"fake-password"};','fake-password'],
  ['const authorization = "FAKE_AUTH_LITERAL_12345";','FAKE_AUTH_LITERAL_12345'],
  ['const url="https://example.test/?api_key=fake-query-value&mode=read";','fake-query-value'],
  ['const AWS_SECRET_ACCESS_KEY="fake-cloud-credential";','fake-cloud-credential'],
  ['const projectKey="github_pat_'+'x'.repeat(32)+'";','github_pat_'+'x'.repeat(32)],
 ]) {const checked=inspectSensitive(text,'src/config.ts');assert.equal(checked.sensitive,true,text);assert(!checked.redacted.includes(secret),text);}
});
