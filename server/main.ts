import { openDb, upsertUser } from './db.ts';
import { buildApp } from './routes.ts';
import {GithubIdentities} from './github-identity.ts';
import {readFileSync, existsSync} from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/messenger.db';
const PORT = Number(process.env.PORT ?? 3000);

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), {recursive:true});
const db = openDb(DB_PATH);

// 사용자 등록: USERS="예제사용자:tok-a,예제동료:tok-b"
const users = process.env.USERS ?? '';
for (const entry of users.split(',').filter((s) => s.trim() !== '')) {
  const [name, token] = entry.split(':');
  if (name && token) upsertUser(db, name.trim(), token.trim());
}

const githubKey=process.env.GITHUB_IDENTITY_KEY ?? `${dirname(DB_PATH)}/github-identity.pem`;
const github=existsSync(githubKey)?new GithubIdentities(readFileSync(githubKey)):undefined;
buildApp(db, {securityLock:true,github}).listen(PORT, () => {
  console.log(`서버 시작: http://0.0.0.0:${PORT}  (DB: ${DB_PATH})`);
});
