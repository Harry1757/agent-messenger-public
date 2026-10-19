/**
 * 본문에서 @멘션을 추출한다.
 * 공백이나 줄 시작 바로 뒤에 오는 @만 인정한다 — 그래야 이메일 주소가 걸리지 않는다.
 */
const MENTION = /(?<=^|\s)@([\p{L}\p{N}_-]+)/gu;

export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION)) {
    seen.add(m[1]);
  }
  return [...seen];
}
