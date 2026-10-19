import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMentions } from '../shared/mentions.ts';

test('멘션 하나를 뽑는다', () => {
  assert.deepEqual(extractMentions('@예제동료 이거 API 뭐예요?'), ['예제동료']);
});

test('멘션 여러 개를 순서대로 뽑는다', () => {
  assert.deepEqual(extractMentions('@예제동료 @지호 봐주세요'), ['예제동료', '지호']);
});

test('같은 멘션이 반복되면 한 번만 나온다', () => {
  assert.deepEqual(extractMentions('@예제동료 그리고 @예제동료'), ['예제동료']);
});

test('이메일 주소는 멘션이 아니다', () => {
  assert.deepEqual(extractMentions('메일은 reader@example.com 입니다'), []);
});

test('멘션이 없으면 빈 배열', () => {
  assert.deepEqual(extractMentions('그냥 질문입니다'), []);
});

test('줄 맨 앞의 멘션도 잡는다', () => {
  assert.deepEqual(extractMentions('안녕하세요\n@지호 확인 부탁'), ['지호']);
});

test('영문 이름과 밑줄·하이픈을 허용한다', () => {
  assert.deepEqual(extractMentions('@sung-beom @ji_ho'), ['sung-beom', 'ji_ho']);
});
