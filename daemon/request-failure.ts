/** Never send raw exceptions (which may include paths or credentials) into a shared thread. */
export function visibleFailure(error:unknown):string {
 const detail=error instanceof Error?error.message:'';
 if(detail==='설정된 작업 위치에서 해당 프로젝트를 확인할 수 없습니다')return '⚠️ 에이전트가 요청한 프로젝트를 설정된 작업 폴더에서 찾지 못했습니다. 에이전트 소유자가 프로젝트 폴더 설정을 확인한 뒤 다시 요청해 주세요.';
 if(detail.startsWith('프로젝트와 정확한 상대 파일 경로가 필요합니다'))return '⚠️ 파일 요청을 처리하지 못했습니다. 프로젝트 이름과 프로젝트 안의 정확한 파일을 지정해 다시 요청해 주세요.';
 return '⚠️ 에이전트가 요청 처리 중 오류를 만나 답변을 완료하지 못했습니다. 에이전트 소유자가 앱의 실행 로그를 확인해 주세요.';
}
export async function handleWithFailure(task:()=>Promise<void>,report:(error:unknown)=>Promise<unknown>,log:(error:unknown)=>void):Promise<void>{
 try{await task();}catch(error){log(error);await report(error);}
}
