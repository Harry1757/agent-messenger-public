import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {existsSync} from 'node:fs';
/** App-owned, exact-version runtime. Never depends on the user's global Codex version. */
export function codexRuntime():string {
 const arch=process.arch==='arm64'?'aarch64':'x86_64';
 const triple=process.platform==='win32'?`${arch}-pc-windows-msvc`:process.platform==='darwin'?`${arch}-apple-darwin`:`${arch}-unknown-linux-musl`;
 const root=dirname(createRequire(import.meta.url).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
 const binary=join(root,'vendor',triple,'bin',process.platform==='win32'?'codex.exe':'codex');
 if(!existsSync(binary))throw Error('메신저 전용 Codex 실행 파일이 설치되지 않았습니다');
 return binary;
}
