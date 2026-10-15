import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { SocketRequest, SocketResponse } from '../mcp/protocol.js';

/** Listens for requests from Companion's MCP server inside Claude sessions. */
export function listenForSessions(path: string, handle: (req: SocketRequest) => Promise<SocketResponse>): Server {
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let res: SocketResponse;
      try {
        res = await handle(JSON.parse(line) as SocketRequest);
      } catch (err) {
        res = { ok: false, error: (err as Error).message };
      }
      sock.end(`${JSON.stringify(res)}\n`);
    });
    sock.on('error', () => {});
  });
  server.listen(path);
  return server;
}
