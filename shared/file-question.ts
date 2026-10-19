export function isFileQuestion(body:string):boolean {
 return /(?:\b[\w.-]+\.(?:md|json|ts|tsx|js|py|java|sql|yaml|yml)\b|파일|저장소|레포|repository|github|깃|이슈|\bPR\b|풀.?리퀘스트|커밋|commit|브랜치)/iu.test(body) && /읽|확인|요약|조회|수정|삭제|공유|분석|read|review|check/iu.test(body);
}
