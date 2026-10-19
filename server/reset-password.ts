// 비밀번호를 잊었을 때의 유일한 복구 경로. 관리자가 서버 호스트에서 돌린다:
//   sudo docker compose exec server npm run reset-password -- 이름 새비밀번호
import { openDb, setPassword } from './db.ts';

const DB_PATH = process.env.DB_PATH ?? './data/messenger.db';
const [name, password] = process.argv.slice(2);

if (!name || !password) {
  console.error('사용법: npm run reset-password -- 이름 새비밀번호');
  process.exit(1);
}
if (password.length < 8) {
  console.error('비밀번호는 8자 이상이어야 합니다');
  process.exit(1);
}

const db = openDb(DB_PATH);
if (!setPassword(db, name, password)) {
  console.error(`이름을 찾을 수 없습니다: ${name}`);
  process.exit(1);
}
console.log(`${name} 의 비밀번호를 바꿨습니다 (토큰은 그대로입니다)`);
