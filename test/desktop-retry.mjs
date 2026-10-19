import {_electron as electron} from 'playwright';
import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
const dir=mkdtempSync(join(tmpdir(),'desktop-retry-'));writeFileSync(join(dir,'config.json'),JSON.stringify({serverUrl:'http://127.0.0.1:43133',token:'test',agentName:'test',tool:'codex',command:'codex',workspace:dir}));
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>자동 재연결 성공</h1>');});let app;
try{
 app=await electron.launch({executablePath:join(process.cwd(),'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[process.cwd(),'--user-data-dir='+join(dir,'profile')],env:{...process.env,AGENT_MESSENGER_HOME:dir,MESSENGER_DESKTOP_TEST:'1'}});
 const page=await app.firstWindow();await new Promise(r=>setTimeout(r,4200));server.listen(43133,'127.0.0.1');
 await page.getByText('자동 재연결 성공').waitFor({timeout:15000});console.log('서버가 늦게 시작해도 화면 자동 복구 PASS');
}finally{if(app)await app.close();server.close();}
