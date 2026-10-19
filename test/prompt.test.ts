import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, interpret } from '../daemon/prompt.ts';

test('시스템 프롬프트에 이름과 레포가 들어간다', () => {
  const p = buildSystemPrompt('예제동료', ['결제-api', '앱']);
  assert.match(p, /예제동료/);
  assert.match(p, /결제-api/);
  assert.match(p, /앱/);
});

test('시스템 프롬프트가 멘션 규칙을 담는다', () => {
  const p = buildSystemPrompt('예제동료', ['a']);
  assert.match(p, /멘션/);
  assert.match(p, /DECISION/);
});

test('시스템 프롬프트가 코드 수정 금지를 명시한다', () => {
  assert.match(buildSystemPrompt('예제동료', ['a']), /수정할 권한이 없습니다/);
});

test('보통 답은 text 로 해석한다', () => {
  const r = interpret('POST /payments/approve 입니다.');
  assert.equal(r.kind, 'text');
  assert.equal(r.body, 'POST /payments/approve 입니다.');
});

test('DECISION 접두사는 decision_request 로 해석한다', () => {
  const raw = 'DECISION{"question":"nullable 로 볼까요?","options":["예","아니오"]}';
  const r = interpret(raw);
  assert.equal(r.kind, 'decision_request');
  assert.deepEqual(JSON.parse(r.body), { question: 'nullable 로 볼까요?', options: ['예', '아니오'] });
});

test('앞뒤 공백이 있어도 DECISION 을 알아본다', () => {
  const raw = '\n  DECISION{"question":"q","options":["a"]}  \n';
  assert.equal(interpret(raw).kind, 'decision_request');
});

test('DECISION 뒤 JSON 이 깨졌으면 그냥 text 로 둔다', () => {
  const raw = 'DECISION{이건 JSON 이 아님';
  const r = interpret(raw);
  assert.equal(r.kind, 'text');
  assert.equal(r.body, raw);
});

test('question 이나 options 가 없으면 text 로 둔다', () => {
  assert.equal(interpret('DECISION{"question":"q"}').kind, 'text');
  assert.equal(interpret('DECISION{"options":["a"]}').kind, 'text');
});

test('완료 요약은 읽을 수 있는 요약 메시지로 보존한다',()=>{
 const r=interpret('SUMMARY{"conclusion":"검토 완료","findings":["경로 정상"],"nextSteps":["이미지 교체"]}');
 assert.equal(r.kind,'summary');assert.match(r.body,/검토 완료/);assert.match(r.body,/이미지 교체/);
});
test('잘못된 요약 JSON은 완료로 오인하지 않는다',()=>{
 assert.equal(interpret('SUMMARY{"conclusion":"","findings":[]}').kind,'text');
});
