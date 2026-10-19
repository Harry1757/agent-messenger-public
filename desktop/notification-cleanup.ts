type Notice={close:()=>void};
/** Dismiss OS notifications without changing messages, unread state or pending decisions. */
export function dismissNotifications(decisions:Map<number,Notice>,ordinary:Set<Notice>,removeHistory:()=>void){
 const items=new Set([...decisions.values(),...ordinary]);
 decisions.clear();ordinary.clear();
 for(const notice of items)try{notice.close();}catch{/* Already removed by the OS. */}
 removeHistory();
}
