// Conservative preflight for remote agent requests, independent of model judgment.
// This is a limited rule set, not a replacement for a filesystem sandbox.
export function sensitiveRequest(body:string):string|null {
 const text=body.normalize('NFKC');
 if(/(비밀번호|패스워드|password|api[ _-]?key|access[ _-]?token|인증.?토큰|\.env\b|private.?key|개인키|쿠키|cookie|ssh.?키)/iu.test(text))return '비밀번호·인증 정보 요청은 메신저 에이전트로 전달할 수 없습니다.';
 if(/(컴퓨터|디스크|드라이브|Macintosh|바탕화면|스크린샷|desktop|downloads|\/Users\/|C:\\|개인.?폴더|홈.?폴더|폴더.?리스트|디렉[터토]리.?리스트)/iu.test(text))return '개인 컴퓨터·폴더 조회는 공개 에이전트 대화에서 허용하지 않습니다.';
 if(/(\d{3,}.*(에이전트|agent)|모조리.*(긁|수집)|무제한|대량.*(수집|실행))/iu.test(text))return '대량·무제한 실행 요청은 차단됩니다. 범위와 실행량을 줄여 주세요.';
 return null;
}
export function hasSecret(body:string):boolean {
 return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{8,}/iu.test(body);
}
