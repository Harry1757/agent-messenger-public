import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { findRepos, findReposForStartup } from '../daemon/workspace.ts';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'am-workspace-'));
}

test('작업 폴더 아래 .git 을 가진 디렉터리들을 이름으로, 정렬해 돌려준다', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, 'b-repo', '.git'), { recursive: true });
    mkdirSync(join(ws, 'a-repo', '.git'), { recursive: true });
    assert.deepEqual(findRepos(ws), ['a-repo', 'b-repo']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('.git 이 없는 디렉터리와 일반 파일은 무시한다', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, 'repo', '.git'), { recursive: true });
    mkdirSync(join(ws, 'not-a-repo'));
    writeFileSync(join(ws, 'readme.txt'), 'hi');
    assert.deepEqual(findRepos(ws), ['repo']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('작업 폴더 자체가 저장소면 그 폴더 이름 하나를 돌려준다', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, '.git'));
    mkdirSync(join(ws, 'other-repo', '.git'), { recursive: true });
    assert.deepEqual(findRepos(ws), [basename(ws)]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('없는 경로를 주면 빈 배열을 돌려주고 던지지 않는다', () => {
  assert.doesNotThrow(() => findRepos('/no/such/path/agent-messenger-xyz'));
  assert.deepEqual(findRepos('/no/such/path/agent-messenger-xyz'), []);
});

test('한 단계만 본다 — 재귀하지 않는다', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, 'a', 'nested-repo', '.git'), { recursive: true });
    assert.deepEqual(findRepos(ws), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('배열을 주면 모든 경로의 결과를 합치고, 이름이 겹치면 한 번만 넣는다', () => {
  const ws1 = makeWorkspace();
  const ws2 = makeWorkspace();
  try {
    mkdirSync(join(ws1, 'shared', '.git'), { recursive: true });
    mkdirSync(join(ws2, 'shared', '.git'), { recursive: true });
    mkdirSync(join(ws2, 'only-in-two', '.git'), { recursive: true });
    assert.deepEqual(findRepos([ws1, ws2]), ['only-in-two', 'shared']);
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
  }
});

test('배열 중 없는 경로가 섞여 있어도 나머지는 정상 처리한다', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, 'repo', '.git'), { recursive: true });
    assert.deepEqual(findRepos(['/no/such/path/agent-messenger-xyz', ws]), ['repo']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('시작용 비동기 탐색도 여러 작업 폴더의 저장소를 정확히 찾는다',async()=>{
 const ws=makeWorkspace();try{
 mkdirSync(join(ws,'repo','.git'),{recursive:true});
 assert.deepEqual(await findReposForStartup([ws,join(ws,'missing')]),['repo']);
 assert.deepEqual(await findReposForStartup(join(ws,'repo')),['repo']);
 }finally{rmSync(ws,{recursive:true,force:true});}
});
