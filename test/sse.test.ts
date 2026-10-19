import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addClient, broadcast, clientCount, type SseSink } from '../server/sse.ts';
import type { Message } from '../shared/types.ts';

function fakeSink() {
  const chunks: string[] = [];
  let onClose = () => {};
  const sink: SseSink = {
    write: (c) => { chunks.push(c); },
    on: (_e, fn) => { onClose = fn; },
  };
  return { sink, chunks, close: () => onClose() };
}

const msg: Message = {
  id: 1, threadId: 't1', author: '예제동료', authorType: 'agent',
  kind: 'text', body: '답변입니다', createdAt: '2026-09-10T00:00:00.000Z', privateTo: null,
};

test('붙은 클라이언트에 이벤트가 전달된다', () => {
  const a = fakeSink();
  addClient(a.sink, '예제사용자');
  broadcast({ type: 'message', message: msg });

  assert.equal(a.chunks.length, 1);
  assert.match(a.chunks[0], /^data: /);
  assert.match(a.chunks[0], /\n\n$/);
  const payload = JSON.parse(a.chunks[0].slice('data: '.length));
  assert.equal(payload.type, 'message');
  assert.equal(payload.message.body, '답변입니다');
  a.close();
});

test('여러 클라이언트 모두에게 전달된다', () => {
  const a = fakeSink();
  const b = fakeSink();
  addClient(a.sink, '예제사용자');
  addClient(b.sink, '예제동료');
  broadcast({ type: 'message', message: msg });
  assert.equal(a.chunks.length, 1);
  assert.equal(b.chunks.length, 1);
  a.close();
  b.close();
});

test('연결이 끊기면 목록에서 빠진다', () => {
  const a = fakeSink();
  addClient(a.sink, '예제사용자');
  assert.equal(clientCount(), 1);
  a.close();
  assert.equal(clientCount(), 0);
  broadcast({ type: 'message', message: msg });
  assert.equal(a.chunks.length, 0, '끊긴 클라이언트에는 쓰지 않는다');
});

test('쓰기가 실패하는 클라이언트는 제거된다', () => {
  const bad: SseSink = {
    write: () => { throw new Error('EPIPE'); },
    on: () => {},
  };
  addClient(bad, '예제사용자');
  broadcast({ type: 'message', message: msg });
  assert.equal(clientCount(), 0);
});

test('onlyFor 를 주면 그 사용자로 붙은 클라이언트에만 전달된다', () => {
  const a = fakeSink();
  const b = fakeSink();
  addClient(a.sink, '예제사용자');
  addClient(b.sink, '예제동료');

  const privateMsg: Message = { ...msg, privateTo: '예제사용자' };
  broadcast({ type: 'message', message: privateMsg }, '예제사용자');

  assert.equal(a.chunks.length, 1, '대상 사용자에게는 전달된다');
  assert.equal(b.chunks.length, 0, '다른 사용자에게는 전달되지 않는다');
  a.close();
  b.close();
});
