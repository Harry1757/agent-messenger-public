import type { ServerEvent } from '../shared/types.ts';

export interface SseSink {
  write(chunk: string): void;
  on(event: 'close', fn: () => void): void;
}

interface Client {
  sink: SseSink;
  user: string;
  transform?: (event: ServerEvent) => ServerEvent | null;
}

const clients = new Set<Client>();

export function addClient(sink: SseSink, user: string, transform?: Client['transform']): void {
  const client: Client = { sink, user, transform };
  clients.add(client);
  sink.on('close', () => { clients.delete(client); });
}

export function clientCount(): number {
  return clients.size;
}

/** onlyFor 가 있으면 그 사용자로 붙은 클라이언트에만 쓴다. 없으면 모두에게. */
export function broadcast(event: ServerEvent, onlyFor?: string): void {
  const chunk = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of [...clients]) {
    if (onlyFor !== undefined && client.user !== onlyFor) continue;
    try {
      const filtered = client.transform ? client.transform(event) : event;
      if (filtered === null) continue;
      client.sink.write(filtered === event ? chunk : `data: ${JSON.stringify(filtered)}\n\n`);
    } catch {
      // 끊긴 연결에 쓰면 예외가 난다. 조용히 걷어낸다.
      clients.delete(client);
    }
  }
}
