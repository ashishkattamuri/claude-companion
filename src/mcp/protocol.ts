import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';

/**
 * Requests from Companion's MCP server (running inside a Claude session) to the Companion app,
 * over a Unix socket in the data folder: one JSON line each way.
 */

export interface NewChatRequest {
  method: 'new_chat';
  params: {
    /** The claude process that called the tool: identifies the chat the request came from. */
    claudePid: number;
    sessionId: string | null;
    prompt: string;
    title: string;
  };
}

/** Sent by the MCP server once Claude Code has connected to it: the session's tools are ready. */
export interface HelloRequest {
  method: 'hello';
  params: { claudePid: number; sessionId: string | null };
}

/** Claude looking up a detail in the conversation its chat was opened from. */
export interface SearchEarlierRequest {
  method: 'search_earlier';
  params: {
    claudePid: number;
    sessionId: string | null;
    query?: string;
    /** A step number from earlier results: read the steps around it in full. */
    around?: number;
    /** `parent` (the chat this one was opened from) or `lineage` (its parents too). */
    scope?: 'parent' | 'lineage';
    /** Which earlier chat `around` reads; defaults to the nearest. */
    chat?: string;
    page?: number;
  };
}

export type SocketRequest = NewChatRequest | HelloRequest | SearchEarlierRequest;
export type SocketResponse = { ok: true; message: string } | { ok: false; error: string };

export const socketPath = (cfg: Config) => process.env.COMPANION_SOCKET ?? join(dirname(cfg.dbPath), 'companion.sock');

export function sendRequest(path: string, req: SocketRequest, timeoutMs = 15_000): Promise<SocketResponse> {
  return new Promise((resolve) => {
    let buf = '';
    const sock = createConnection(path);
    const done = (r: SocketResponse) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'Companion did not answer in time.' }), timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          done(JSON.parse(buf.slice(0, nl)) as SocketResponse);
        } catch {
          done({ ok: false, error: 'Companion sent an unreadable reply.' });
        }
      }
    });
    sock.on('error', () => done({ ok: false, error: 'Companion is not running.' }));
  });
}
