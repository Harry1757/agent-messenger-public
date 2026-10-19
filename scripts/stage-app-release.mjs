import {readFileSync,copyFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const {version}=JSON.parse(readFileSync('package.json','utf8'));
mkdirSync('app-downloads',{recursive:true});
for(const target of ['win-x64.exe','mac-arm64.dmg']){
 const name=`agent-messenger-${version}-${target}`;
 if(!existsSync(`release/${name}`))throw Error(`Missing release/${name}`);
 copyFileSync(`release/${name}`,`app-downloads/${name}`);
 copyFileSync(`release/${name}`,`app-downloads/agent-messenger-${target}`);
}
const yaml=readFileSync('release/latest.yml','utf8');
const filename=`agent-messenger-${version}-win-x64.exe`;
const checksum=createHash('sha512').update(readFileSync(`release/${filename}`)).digest('base64');
if(!yaml.includes(`version: ${version}`)||!yaml.includes(filename)||!yaml.includes(checksum))throw Error('Updater manifest does not match installer');
copyFileSync('release/latest.yml','app-downloads/latest.yml');
copyFileSync(`release/${filename}.blockmap`,`app-downloads/${filename}.blockmap`);
writeFileSync('app-downloads/version.json',JSON.stringify({version}));
console.log(`Release ${version} staged; SHA-512 verified`);
