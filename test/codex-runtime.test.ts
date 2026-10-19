import {test} from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {codexRuntime} from '../daemon/codex-runtime.ts';
test('app-owned runtime exists and is the verified version, independent of global CLI',()=>{assert.match(execFileSync(codexRuntime(),['--version'],{encoding:'utf8'}),/0\.153\.4/);});
