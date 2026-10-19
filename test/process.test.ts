import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, resolveInvocation } from '../daemon/process.ts';

test('CLI 표준 입력을 닫아 EOF를 기다리는 도구도 완료된다', async () => {
  const result = await runCommand(process.execPath, ['-e', `
    const timer = setTimeout(() => { console.error('stdin left open'); process.exit(1); }, 1000);
    process.stdin.resume();
    process.stdin.on('end', () => { clearTimeout(timer); console.log('EOF received'); });
  `]);
  assert.equal(result.error, null);
  assert.equal(result.stdout.trim(), 'EOF received');
});

test('Windows npm cmd shim은 셸 없이 Node로 실행하고 프롬프트를 그대로 보존한다', () => {
  const dir = mkdtempSync(join(tmpdir(), '메신저 공백 '));
  try {
    mkdirSync(join(dir, 'node_modules', 'test'), {recursive:true});
    const script = join(dir, 'node_modules', 'test', 'cli.js');
    writeFileSync(script, '');
    writeFileSync(join(dir, 'codex.cmd'), '@"%dp0%\\node.exe" "%dp0%\\node_modules\\test\\cli.js" %*');
    const prompt = '한글 "quotes" & echo bad | %PATH% !x!\nsecond line';
    const result = resolveInvocation('codex', [prompt], 'win32', {PATH:dir});
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, [script, prompt]);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('알 수 없는 배치 파일은 셸로 실행하지 않고 명확히 거절한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'messenger-batch-'));
  try {
    const command = join(dir, 'custom.cmd');
    writeFileSync(command, '@echo custom');
    assert.throws(() => resolveInvocation(command, [], 'win32'), /npm|실행 파일/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('Windows Codex npm 래퍼 대신 실제 실행 파일을 실행한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-native-'));
  try {
    const root = join(dir, 'node_modules', '@openai', 'codex');
    mkdirSync(join(root, 'bin'), {recursive:true});
    writeFileSync(join(root, 'package.json'), JSON.stringify({name:'@openai/codex'}));
    writeFileSync(join(root, 'bin', 'codex.js'), '');
    const binary = join(root, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    mkdirSync(join(binary, '..'), {recursive:true}); writeFileSync(binary, '');
    writeFileSync(join(dir, 'codex.cmd'), '@"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
    assert.deepEqual(resolveInvocation('codex', ['한글 & %PATH%'], 'win32', {PATH:dir}, 'x64'), {command:binary,args:['한글 & %PATH%']});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
