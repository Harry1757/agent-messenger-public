import {randomBytes,publicEncrypt,createCipheriv, type KeyLike} from 'node:crypto';
/** Only the deployment's pinned public key may be used; never a key returned over HTTP. */
export function sealIdentity(publicKey:KeyLike,value:{owner:string;nonce:string;token:string;purpose?:'common-read'|'github-read'|'github-resolve';project?:string;repo?:string;query?:unknown;thread?:string;privateRead?:boolean}):string{
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return JSON.stringify({key:publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
}
