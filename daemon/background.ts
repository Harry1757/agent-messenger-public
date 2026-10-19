import {spawn} from 'node:child_process';
import {mkdirSync, openSync, closeSync, statSync, renameSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DATA_DIR} from './config.ts';

mkdirSync(DATA_DIR, {recursive:true});
const log = join(DATA_DIR, 'daemon.log');
if (existsSync(log) && statSync(log).size > 10 * 1024 * 1024) renameSync(log, log+'.previous');
const fd = openSync(log, 'a');
const child = spawn(process.execPath, ['--experimental-strip-types','--disable-warning=ExperimentalWarning',join(dirname(fileURLToPath(import.meta.url)),'main.ts')], {
  stdio:['ignore',fd,fd], windowsHide:true,
});
closeSync(fd);
child.on('error', (error) => { console.error(error.message); process.exitCode=1; });
child.on('exit', (code) => { process.exitCode=code ?? 1; });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => child.kill(signal));
