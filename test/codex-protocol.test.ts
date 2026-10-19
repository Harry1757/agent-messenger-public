import {test} from 'node:test';import assert from 'node:assert/strict';
import {supportedChatProtocol} from '../daemon/chat-codex.ts';
test('only verified environment-free protocol versions are accepted',()=>{
 for(const v of ['0.153.4','0.154.0-alpha.6.2'])assert(supportedChatProtocol(`codex/${v} platform`));
 for(const v of ['0.153.40','0.154.0','0.154.0-alpha.6.3','0.1.0'])assert(!supportedChatProtocol(`codex/${v} platform`));
});
