import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expandVars, type ClaudeServer } from './servers.js';

export class ConnectorError extends Error {}

export interface ConnectOptions {
  /** Tools that only read. Anything else needs `approve`. */
  readTools: readonly string[];
  /** Asked before any other tool runs. Without it, other tools are refused. */
  approve?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * A connection to one MCP server from Claude Code's list. Companion calls the server itself rather
 * than through a Claude session: a session would load every server's tools on each run.
 */
export class ConnectorClient {
  private constructor(
    private client: Client,
    private opts: ConnectOptions,
  ) {}

  static async open(server: ClaudeServer, opts: ConnectOptions): Promise<ConnectorClient> {
    const env = opts.env ?? process.env;
    const client = new Client({ name: 'claude-companion', version: '0.0.1' });
    const timeout = opts.timeoutMs ?? 20_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transportFor(server, env)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ConnectorError(`${server.name} didn't answer within ${timeout / 1000}s`)), timeout);
        }),
      ]);
    } catch (err) {
      await client.close().catch(() => {});
      throw err instanceof ConnectorError ? err : new ConnectorError(`Couldn't connect to ${server.name}: ${describe(err)}`);
    } finally {
      clearTimeout(timer);
    }
    return new ConnectorClient(client, opts);
  }

  async tools(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((t) => t.name);
  }

  /** Calls a tool and returns its text output. Tools not on the read list need approval first. */
  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.opts.readTools.includes(tool) && !(await this.opts.approve?.(tool, args))) {
      throw new ConnectorError(`${tool} can change things, and wasn't approved`);
    }
    const r = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.opts.timeoutMs ?? 20_000 });
    const text = (r.content as { type: string; text?: string }[] | undefined)
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n') ?? '';
    if (r.isError) throw new ConnectorError(`${tool}: ${text.slice(0, 300) || 'failed'}`);
    return text;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }
}

function transportFor(server: ClaudeServer, env: Record<string, string | undefined>): Transport {
  const c = server.config;
  const expand = (v: string) => expandVars(v, env);
  if (server.transport === 'stdio') {
    if (!c.command) throw new ConnectorError(`${server.name} has no command`);
    return new StdioClientTransport({
      command: expand(c.command),
      args: (c.args ?? []).map(expand),
      env: {
        ...(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>),
        ...Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, expand(v)])),
      },
      stderr: 'ignore',
    });
  }
  if (!c.url) throw new ConnectorError(`${server.name} has no URL`);
  const headers = Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, expand(v)]));
  const url = new URL(expand(c.url));
  return server.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|unauthori[sz]ed|bad credentials/i.test(msg)) return 'the server refused the credentials (401)';
  return msg.split('\n')[0]!.slice(0, 300);
}
