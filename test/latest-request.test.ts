import {test} from 'node:test';import assert from 'node:assert/strict';
import {LatestRequests} from '../daemon/latest-request.ts';
import {conversationPrompt} from '../daemon/conversation.ts';
const m={id:1,threadId:'a',privateTo:null,author:'동료',authorType:'human' as const,kind:'text' as const,body:'@예제사용자 기존 요청',createdAt:''};
test('new request replaces stale answer while combining context',()=>{const q=new LatestRequests();q.observe(m,'예제사용자');const next={...m,id:2,body:'@예제사용자 추가 조건도 반영해 주세요'};q.observe(next,'예제사용자');assert(q.superseded(m));assert(!q.superseded(next));const p=conversationPrompt(next,[m,next],false);assert(p.includes('기존 요청'));assert(p.includes('추가 조건'));});
test('direct chat, other recipients, rooms and private scopes do not replace active request',()=>{for(const next of [{...m,id:2,direct:true},{...m,id:2,body:'@예제동료 다른 요청'},{...m,id:2,threadId:'b'},{...m,id:2,privateTo:'예제사용자'}]){const q=new LatestRequests();q.observe(m,'예제사용자');q.observe(next,'예제사용자');assert(!q.superseded(m));}});
