import { DatabaseSync } from 'node:sqlite';
import { extractMentions } from '../shared/mentions.ts';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type {
  Thread, Message, NewMessage, AuthorType, MessageKind, AgentSettings,
} from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  name          TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  setting_tool  TEXT,
  setting_model TEXT
);
CREATE TABLE IF NOT EXISTS hidden_threads (thread_id TEXT NOT NULL, user_name TEXT NOT NULL, PRIMARY KEY(thread_id,user_name));
CREATE TABLE IF NOT EXISTS file_shared_threads (thread_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  auto_turns      INTEGER NOT NULL DEFAULT 0,
  auto_started_at TEXT,
  paused          INTEGER NOT NULL DEFAULT 0,
  resolved        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  author      TEXT NOT NULL,
  author_type TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  private_to  TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블에 컬럼을 더하지 않는다.
// 토큰만으로 가입했던 기존 DB 를 위해 없는 컬럼이면 여기서 추가한다.
function migrate(db: DatabaseSync): void {
  const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<Record<string, unknown>>;
  if (!userCols.some((c) => c.name === 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  if (!userCols.some((c) => c.name === 'setting_tool')) {
    db.exec('ALTER TABLE users ADD COLUMN setting_tool TEXT');
  }
  if (!userCols.some((c) => c.name === 'setting_model')) {
    db.exec('ALTER TABLE users ADD COLUMN setting_model TEXT');
  }
  const directCols = db.prepare('PRAGMA table_info(messages)').all();
  if (!directCols.some(c=>c.name==='agent_action')) db.exec('ALTER TABLE messages ADD COLUMN agent_action TEXT');
  if (!directCols.some(c=>c.name==='reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
  if (!directCols.some(c=>c.name==='agent_target')) db.exec('ALTER TABLE messages ADD COLUMN agent_target TEXT');
  if (!directCols.some(c=>c.name==='resource_audience')) db.exec('ALTER TABLE messages ADD COLUMN resource_audience TEXT');
  if (!directCols.some(c=>c.name==='resource_policies')) db.exec('ALTER TABLE messages ADD COLUMN resource_policies TEXT');
  if (!directCols.some(c=>c.name==='direct')) db.exec('ALTER TABLE messages ADD COLUMN direct INTEGER NOT NULL DEFAULT 0');
  const messageCols = db.prepare('PRAGMA table_info(messages)').all() as Array<Record<string, unknown>>;
  if (!messageCols.some((c) => c.name === 'private_to')) {
    db.exec('ALTER TABLE messages ADD COLUMN private_to TEXT');
  }
  if (!messageCols.some((c) => c.name === 'decision_request_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN decision_request_id INTEGER');
  }
  if (!messageCols.some((c) => c.name === 'execution_json')) {
    db.exec('ALTER TABLE messages ADD COLUMN execution_json TEXT');
  }
  const threadCols = db.prepare('PRAGMA table_info(threads)').all() as Array<Record<string, unknown>>;
  if (!threadCols.some((c) => c.name === 'resolved')) {
    db.exec('ALTER TABLE threads ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0');
  }
  const membershipExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_members'").get();
  if (!membershipExists) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE thread_members (
        thread_id TEXT NOT NULL REFERENCES threads(id),
        user_name TEXT NOT NULL,
        PRIMARY KEY(thread_id, user_name)
      )`);
      // Existing messages establish historical authors and explicit public mentions.
      // Empty legacy threads have no known owner, so remain inaccessible.
      for (const row of db.prepare('SELECT * FROM messages ORDER BY id').all()) {
        registerMessageMembers(db, toMessage(row));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

function toThread(r: Record<string, unknown>): Thread {
  return {
    id: r.id as string,
    title: r.title as string,
    createdAt: r.created_at as string,
    autoTurns: Number(r.auto_turns),
    autoStartedAt: (r.auto_started_at as string | null) ?? null,
    paused: Number(r.paused) === 1,
    resolved: Number(r.resolved) === 1,
  };
}

function toMessage(r: Record<string, unknown>): Message {
  return {
    id: Number(r.id),
    threadId: r.thread_id as string,
    author: r.author as string,
    authorType: r.author_type as AuthorType,
    kind: r.kind as MessageKind,
    body: r.body as string,
    ...(r.direct ? {direct:true} : {}),
    ...(typeof r.agent_target==='string'?{agentTarget:r.agent_target}:{}),
    ...(typeof r.agent_action==='string'?{agentAction:r.agent_action as 'request'|'reply'}:{}),
    ...(typeof r.reply_to==='number'?{replyTo:r.reply_to}:{}),
    ...(typeof r.resource_audience==='string'?{resourceAudience:JSON.parse(r.resource_audience)}:{}),
    ...(typeof r.resource_policies==='string'?{resourcePolicyIds:JSON.parse(r.resource_policies)}:{}),
    createdAt: r.created_at as string,
    privateTo: (r.private_to as string | null) ?? null,
    ...(r.decision_request_id == null ? {} : {decisionRequestId: Number(r.decision_request_id)}),
    ...(typeof r.execution_json === 'string' ? {execution:JSON.parse(r.execution_json)} : {}),
  };
}

export function createThread(db: DatabaseSync, title: string, owner?: string): Thread {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO threads (id, title, created_at) VALUES (?, ?, ?)').run(id, title, createdAt);
  if (owner) addThreadMember(db, id, owner);
  return { id, title, createdAt, autoTurns: 0, autoStartedAt: null, paused: false, resolved: false };
}

export function listThreads(db: DatabaseSync, viewer?: string): Thread[] {
  const rows = db.prepare('SELECT * FROM threads ORDER BY rowid DESC').all();
  return rows.filter(r => viewer === undefined || canAccessThread(db, String(r.id), viewer)).map((r) => toThread(r as Record<string, unknown>));
}

export function getThread(db: DatabaseSync, id: string): Thread | null {
  const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  return r ? toThread(r as Record<string, unknown>) : null;
}

/** 해결 상태를 바꾼다. 없는 스레드면 null. */
export function setResolved(db: DatabaseSync, id: string, resolved: boolean): Thread | null {
  const info = db.prepare('UPDATE threads SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
  if (Number(info.changes) === 0) return null;
  return getThread(db, id);
}

export function addThreadMember(db: DatabaseSync, threadId: string, user: string): void {
  db.prepare('INSERT OR IGNORE INTO thread_members (thread_id, user_name) VALUES (?, ?)').run(threadId, user);
}

export function canAccessThread(db: DatabaseSync, threadId: string, user: string): boolean {
  return !!db.prepare('SELECT 1 FROM thread_members WHERE thread_id = ? AND user_name = ?').get(threadId, user);
}

function registerMessageMembers(db: DatabaseSync, m: NewMessage): void {
  addThreadMember(db, m.threadId, m.author);
  if (m.privateTo != null || m.kind !== 'text' || m.authorType !== 'human') return;
  for (const name of extractMentions(m.body)) {
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) addThreadMember(db, m.threadId, name);
  }
}

export function addMessage(db: DatabaseSync, m: NewMessage): Message {
  const createdAt = new Date().toISOString();
  const privateTo = m.privateTo ?? null;
  const info = db
    .prepare(
      `INSERT INTO messages (thread_id, author, author_type, kind, body, created_at, private_to, decision_request_id, execution_json, direct, resource_audience, resource_policies, agent_target, agent_action, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.threadId, m.author, m.authorType, m.kind, m.body, createdAt, privateTo, m.decisionRequestId ?? null, m.execution ? JSON.stringify(m.execution) : null, m.direct ? 1 : 0,m.resourceAudience?JSON.stringify(m.resourceAudience):null,m.resourcePolicyIds?JSON.stringify(m.resourcePolicyIds):null,m.agentTarget??null,m.agentAction??null,m.replyTo??null);
  registerMessageMembers(db, m);
  return { id: Number(info.lastInsertRowid), ...m, privateTo, createdAt };
}

/** viewer 에게 보이는 메시지만 돌려준다 — 참여 중인 대화의 공개 메시지 + 자신에게 온 혼잣말. */
export function listMessages(db: DatabaseSync, threadId: string, viewer: string): Message[] {
  if (!canAccessThread(db, threadId, viewer)) return [];
  const rows = db
    .prepare('SELECT * FROM messages WHERE thread_id = ? AND (private_to IS NULL OR private_to = ?) ORDER BY id ASC')
    .all(threadId, viewer);
  return rows.map((r) => toMessage(r as Record<string, unknown>)).filter(m=>!m.resourceAudience || m.resourceAudience.includes(viewer));
}

export function upsertUser(db: DatabaseSync, name: string, token: string): void {
  db.prepare(
    `INSERT INTO users (name, token) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET token = excluded.token`,
  ).run(name, token);
}

export function findUserByToken(db: DatabaseSync, token: string): string | null {
  const r = db.prepare('SELECT name FROM users WHERE token = ?').get(token);
  return r ? ((r as Record<string, unknown>).name as string) : null;
}

const SCRYPT_KEYLEN = 64;

// 솔트와 해시를 한 문자열에 담아 저장한다: "<솔트 hex>:<해시 hex>".
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  // ponytail: scryptSync 는 이벤트 루프를 막는다. 로그인이 잦아지면 비동기 scrypt 로 교체
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  // ponytail: scryptSync 는 이벤트 루프를 막는다. 로그인이 잦아지면 비동기 scrypt 로 교체
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected); // === 비교는 타이밍으로 정보를 흘린다
}

// 이름이 없거나 비밀번호가 없는 사용자를 verifyLogin 에서 짧게 끊으면, 그 경로가
// 해싱을 건너뛰어 응답이 더 빨리 돌아온다 — 이름 존재 여부가 타이밍으로 샌다.
// 두 경로의 비용을 맞추기 위해 미스 케이스에서 버려질 이 해시를 상대로 검증을 돌린다.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

/**
 * 새 사용자를 만들고 무작위 토큰을 돌려준다. 이름이 이미 있으면 null.
 * 토큰은 서버가 만든다 — 사람이 고르면 짧거나 뻔한 값이 되고, 이 시스템에서
 * 토큰은 곧 신원이므로(메시지 작성자를 토큰이 결정) 그대로 사칭 경로가 된다.
 * 비밀번호는 토큰을 잃어버렸을 때 되찾는 유일한 길이라 반드시 같이 받는다.
 */
export function createUser(
  db: DatabaseSync,
  name: string,
  password: string,
): { name: string; token: string } | null {
  const token = randomBytes(24).toString('base64url');
  const passwordHash = hashPassword(password);
  try {
    db.prepare('INSERT INTO users (name, token, password_hash) VALUES (?, ?, ?)').run(
      name,
      token,
      passwordHash,
    );
  } catch {
    return null; // UNIQUE 제약 위반 = 이미 있는 이름
  }
  return { name, token };
}

/**
 * 이름·비밀번호가 맞으면 가입 때와 같은 토큰을 돌려준다 — 비밀번호가 토큰의
 * 복구 수단이다. 이름이 없거나, 비밀번호가 없는(토큰 전용) 사용자이거나,
 * 비밀번호가 틀리면 모두 null — 호출부가 이 셋을 구분하지 못하게 한다.
 */
export function verifyLogin(
  db: DatabaseSync,
  name: string,
  password: string,
): { name: string; token: string } | null {
  const row = db.prepare('SELECT token, password_hash FROM users WHERE name = ?').get(name) as
    | Record<string, unknown>
    | undefined;
  if (!row || row.password_hash == null) {
    verifyPassword(password, DUMMY_HASH); // 결과는 버린다 — 이 경로도 해싱 비용을 치르게 한다
    return null;
  }
  if (!verifyPassword(password, String(row.password_hash))) return null;
  return { name, token: String(row.token) };
}

/** 비밀번호만 바꾸고 토큰은 그대로 둔다. 없는 이름이면 false. */
export function setPassword(db: DatabaseSync, name: string, password: string): boolean {
  const info = db
    .prepare('UPDATE users SET password_hash = ? WHERE name = ?')
    .run(hashPassword(password), name);
  return Number(info.changes) > 0;
}

/**
 * 사용자가 웹에서 고른 도구·모델. 데몬 상태와 달리 사람의 선택이므로 서버가
 * 계속 기억한다 — 서버가 다시 떠도 고른 값이 그대로여야 한다.
 * 없는 사용자거나 아직 고른 적이 없으면 둘 다 null("정하지 않음").
 */
export function getSettings(db: DatabaseSync, name: string): AgentSettings {
  const r = db.prepare('SELECT setting_tool, setting_model FROM users WHERE name = ?').get(name) as
    | Record<string, unknown>
    | undefined;
  if (!r) return { tool: null, model: null };
  return {
    tool: (r.setting_tool as string | null) ?? null,
    model: (r.setting_model as string | null) ?? null,
  };
}

/** 저장하고 저장된 값을 그대로 돌려준다. 없는 사용자면 아무것도 바뀌지 않는다. */
export function setSettings(db: DatabaseSync, name: string, s: AgentSettings): AgentSettings {
  db.prepare('UPDATE users SET setting_tool = ?, setting_model = ? WHERE name = ?')
    .run(s.tool, s.model, name);
  return getSettings(db, name);
}

/** 팀원 목록에는 이름만 포함한다. 인증 정보와 개인 설정은 내보내지 않는다. */
export function listMembers(db: DatabaseSync): {name:string}[] {
  return db.prepare('SELECT name FROM users ORDER BY name').all() as {name:string}[];
}

export function hideThread(db:DatabaseSync,threadId:string,user:string):Message[] {
  if (!canAccessThread(db,threadId,user)) throw Error('대화 접근 권한이 없습니다');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO hidden_threads(thread_id,user_name) VALUES (?,?)').run(threadId,user);
    const history=listMessages(db,threadId,user);
    const answered=new Set(history.filter(m=>m.kind==='decision_result').map(m=>m.decisionRequestId));
    const cancelled=history.filter(m=>m.kind==='decision_request'&&m.author===user&&!answered.has(m.id)).map(m=>addMessage(db,{
      threadId,author:user,authorType:'human',kind:'decision_result',body:'대화 삭제로 요청을 취소했습니다.',privateTo:user,decisionRequestId:m.id,
    }));
    db.exec('COMMIT');return cancelled;
  } catch(error) { db.exec('ROLLBACK');throw error; }
}
export function listVisibleThreads(db:DatabaseSync,user:string):Thread[] {
  const hidden=new Set(db.prepare('SELECT thread_id FROM hidden_threads WHERE user_name=?').all(user).map(r=>r.thread_id));
  return listThreads(db,user).filter(t=>!hidden.has(t.id));
}
