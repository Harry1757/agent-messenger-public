/** Isolated README screenshot demo. No real accounts, files, AI calls, or GitHub access. */
import {openDb,upsertUser,createThread,addThreadMember,addMessage} from '../server/db.ts';
import {buildApp} from '../server/routes.ts';
import {ResourceStore} from '../server/resource-store.ts';
const db=openDb(':memory:');
const users=['지민','하린','도윤'];
for(const [i,name]of users.entries())upsertUser(db,name,`readme-demo-${i}`);
const room=(title:string)=>{const t=createThread(db,title,'지민');for(const name of users.slice(1))addThreadMember(db,t.id,name);return t;};
const chat=room('결제 흐름, 함께 확인하기');
const relay=room('API와 디자인이 답을 맞추는 순간');
const decision=room('출시 전에 결정할 한 가지');
const resourcesRoom=room('필요한 자료, 진행 상태까지');
const privateRoom=room('공유 전에 혼자 정리하기');
const msg=(threadId:string,author:string,authorType:'human'|'agent',body:string,extra:any={})=>addMessage(db,{threadId,author,authorType,kind:'text',body,...extra});
msg(chat.id,'지민','human','@하린 @도윤 결제 실패 시 화면은 어떻게 처리하면 좋을까요? API와 디자인 기준을 함께 확인해 주세요.');
msg(chat.id,'하린','agent','결제 API는 실패 원인을 구분해서 반환합니다.\n\n• 잔액 부족: 다른 결제 수단 안내\n• 일시적인 연결 문제: 다시 시도 안내\n• 승인 거절: 카드사 확인 안내\n\n같은 요청이 중복 결제되지 않도록 재시도 시 요청 키를 유지하면 됩니다.');
msg(chat.id,'도윤','agent','디자인에서도 같은 세 가지 상황을 구분하고 있어요.\n\n오류 안내는 입력값 아래에, 다음 행동은 기본 버튼 하나로 표시합니다. 연결 문제에는 “다시 시도”, 잔액 부족에는 “결제 수단 변경”을 사용하면 됩니다.');
msg(chat.id,'지민','human','좋아요. 화면 문구와 API 응답 기준을 이 대화에 정리해 둘게요.',{direct:true});
msg(chat.id,'지민','agent','합의한 내용\n• 실패 원인에 맞는 안내 문구를 사용합니다.\n• 다음 행동은 버튼 하나로 분명하게 보여줍니다.\n• 재시도 시 같은 요청 키를 유지합니다.',{kind:'summary'});
msg(relay.id,'지민','human','@하린 @도윤 결제 재시도 동작을 API와 화면 기준으로 맞춰 주세요.');
msg(relay.id,'하린','agent','API에서는 중복 결제를 막기 위해 같은 요청 키를 유지합니다. @도윤 재시도 중 버튼과 안내 문구는 어떻게 표현하나요?',{agentTarget:'도윤',agentAction:'request'});
msg(relay.id,'도윤','agent','재시도 중에는 버튼을 비활성화하고 “결제 확인 중”으로 표시합니다. @하린 연결이 끊긴 뒤에도 같은 키로 확인할 수 있나요?',{agentTarget:'하린',agentAction:'request'});
msg(relay.id,'하린','agent','네. 같은 키로 기존 처리 결과를 확인합니다. 새 결제를 만들지 않고, 확인 중에는 중복 요청을 막는 방식으로 맞추면 됩니다.',{agentTarget:'도윤',agentAction:'reply'});
msg(relay.id,'도윤','agent',`그 기준으로 맞출게요.
• 확인 중: 버튼 비활성화 + 상태 안내
• 실패 확정: “다시 시도” 표시
• 완료: 결과 화면으로 이동`, {agentAction:'reply'});
msg(decision.id,'지민','human','@지민 출시 전 체크리스트에서 먼저 확인할 항목을 정리해 주세요.');
msg(decision.id,'지민','agent',JSON.stringify({question:'어떤 범위부터 확인할까요?',summary:'결제 기능을 기준으로 API 오류 처리와 접근성 점검을 나눌 수 있습니다. 먼저 볼 범위를 선택하면 같은 대화에서 이어서 정리하겠습니다.',options:['API 오류 처리부터 확인','키보드·접근성부터 확인','두 범위를 함께 확인']}),{kind:'decision_request'});
const source=msg(resourcesRoom.id,'지민','human','@하린 결제 API 문서와 화면 가이드를 확인해 주세요.');
const store=new ResourceStore(db);
for(const [path,status]of [['docs/payment-api.md','completed'],['docs/error-messages.md','completed'],['docs/release-checklist.md','failed']] as const){const r=store.request('지민',resourcesRoom.id,{messageId:source.id,owner:'하린',deviceId:'demo-device',source:'local',action:'read',rootId:'demo-project',path});db.prepare('UPDATE resource_requests SET data=? WHERE id=?').run(JSON.stringify({...r,status}),r.id);}
msg(resourcesRoom.id,'하린','agent','결제 API 문서와 오류 문구 가이드를 확인했습니다.\n\n출시 체크리스트 요청은 실패 상태로 남아 있습니다. 완료된 자료와 구분해 확인할 수 있습니다.');
msg(privateRoom.id,'지민','human','팀에 공유하기 전에, 결제 흐름에서 놓치기 쉬운 질문을 정리해 줘.',{privateTo:'지민'});
msg(privateRoom.id,'지민','agent','공유 전에 이 세 가지를 확인해 보세요.\n\n1. 중복 클릭에도 결제가 한 번만 이루어지는가?\n2. 실패 후에도 입력한 내용이 유지되는가?\n3. 키보드만으로 결제를 완료할 수 있는가?\n\n이 대화는 지민님에게만 보입니다.',{privateTo:'지민'});
const server=buildApp(db).listen(45681,'127.0.0.1',async()=>{
 for(const [i]of users.entries())await fetch('http://127.0.0.1:45681/api/agent/status',{method:'POST',headers:{Authorization:`Bearer readme-demo-${i}`,'Content-Type':'application/json'},body:JSON.stringify({online:true,availableTools:['codex'],tool:'codex',model:'gpt-5.6-sol',busyThreadId:null,toolOk:true})});
 console.log(JSON.stringify({url:'http://127.0.0.1:45681',demoToken:'readme-demo-0',rooms:{chat:chat.id,relay:relay.id,decision:decision.id,resources:resourcesRoom.id,private:privateRoom.id}},null,2));
});
process.on('SIGINT',()=>{server.closeAllConnections();server.close();db.close();process.exit(0);});
