import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { sendRequest, socketPath } from './protocol.js';

/**
 * Companion's MCP server, attached to the Claude sessions Companion starts. It gives Claude a tool
 * to open a new chat, so asking in plain words ("let's discuss this in a separate chat") works
 * from Companion and from any attached terminal alike, and one to look up details in the
 * conversation a chat was opened from.
 */
export async function runMcpServer(cfg: Config): Promise<void> {
  const server = createMcpServer(cfg);
  // Claude Code connects to MCP servers in the background as a session starts; until it has, the
  // session can't see the tool. Tell Companion once it has, so it holds messages until then.
  server.server.oninitialized = () => {
    void sendRequest(socketPath(cfg), { method: 'hello', params: { claudePid: process.ppid, sessionId: sessionIdFor(cfg, process.ppid) } }, 3000);
  };
  const transport = new StdioServerTransport();
  // Debugging aid: COMPANION_MCP_LOG=<file> records when Claude Code talks to this server.
  if (process.env.COMPANION_MCP_LOG) {
    const t0 = Date.now();
    const { appendFileSync } = await import('node:fs');
    const log = (m: string) => appendFileSync(process.env.COMPANION_MCP_LOG!, `${((Date.now() - t0) / 1000).toFixed(1)}s ${m}\n`);
    log('started');
    await server.connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (msg) => {
      log(`<- ${'method' in msg ? msg.method : 'response'}`);
      onmessage?.(msg);
    };
    return;
  }
  await server.connect(transport);
}

export function createMcpServer(cfg: Config, callerPid = process.ppid): McpServer {
  const server = new McpServer({ name: 'companion', version: '0.1.0' });

  server.registerTool(
    'start_new_chat',
    {
      title: 'Open a new chat in Companion',
      description:
        'Open a separate, fresh chat for a topic, when the user asks to discuss, brainstorm or continue something ' +
        'in a different/separate/new chat or session. The new chat starts with this conversation\'s notes as ' +
        'hidden background context, and starts working on your prompt right away. ' +
        'Do not use it unless the user asked for a separate chat.',
      inputSchema: {
        title: z.string().describe('Short title for the new chat, 3-8 words'),
        prompt: z
          .string()
          .describe(
            'The opening message of the new chat, written as the user would send it (first person): the topic and ' +
              'what they want to do with it, in one to three sentences. Do not restate background, facts or decisions ' +
              'from this conversation: the new chat already knows them.',
          ),
      },
    },
    async ({ title, prompt }) => {
      const claudePid = callerPid;
      const req = { method: 'new_chat' as const, params: { claudePid, sessionId: sessionIdFor(cfg, claudePid), title, prompt } };
      let r = await sendRequest(socketPath(cfg), req);
      // Asked from a terminal while Companion is closed: open it, then try again.
      if (!r.ok && r.error === 'Companion is not running.' && launchApp()) {
        for (let i = 0; i < 30 && !r.ok; i++) {
          await new Promise((res) => setTimeout(res, 500));
          r = await sendRequest(socketPath(cfg), req);
        }
      }
      const text = r.ok
        ? r.message
        : `Could not open the new chat: ${r.error} Tell the user, and suggest opening Companion and asking again.`;
      return { content: [{ type: 'text', text }], isError: !r.ok };
    },
  );

  server.registerTool(
    'search_earlier_conversation',
    {
      title: 'Search the conversation this chat was opened from',
      description:
        'Only for a chat that was opened from an earlier Claude Code conversation (a new chat or a hand-off), which ' +
        'you know from notes. When you need a detail the notes leave out (an exact error message, a command that ' +
        'worked, numbers, why an option was ruled out, code that was proposed), look it up here instead of guessing ' +
        'or asking the user. Returns matching messages, tool calls and full tool output, word for word, with step ' +
        'numbers (#n). With no query, returns an outline of the earlier conversation to navigate from.',
      inputSchema: {
        query: z.string().optional().describe('Words or a regular expression to look for (case-insensitive)'),
        around: z.number().int().positive().optional().describe('A step number (#n) from earlier results: read the steps around it in full'),
        scope: z
          .enum(['parent', 'lineage'])
          .optional()
          .describe('parent (default): the chat this one was opened from; lineage: that chat and the chats it was opened from in turn'),
        chat: z.string().optional().describe('With around and lineage results: the chat id shown in results, to read in that chat'),
        page: z.number().int().positive().optional().describe('Page of results, when a result says there are more'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const r = await sendRequest(socketPath(cfg), { method: 'search_earlier', params: { claudePid: callerPid, sessionId: sessionIdFor(cfg, callerPid), ...args } });
      const text = r.ok ? r.message : `Could not search the earlier conversation: ${r.error}`;
      return { content: [{ type: 'text', text }], isError: !r.ok };
    },
  );

  return server;
}

/** Starts the Companion app (this server runs from its CLI on Electron's Node). */
function launchApp(): boolean {
  if (!process.versions.electron || process.env.COMPANION_NO_AUTOLAUNCH) return false;
  const appDir = resolve(dirname(process.argv[1]!), '..');
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  spawn(process.execPath, [appDir], { detached: true, stdio: 'ignore', env }).unref();
  return true;
}

/** The calling session, from Claude Code's registry entry for our parent process. */
function sessionIdFor(cfg: Config, pid: number): string | null {
  try {
    return JSON.parse(readFileSync(join(cfg.claudeDir, 'sessions', `${pid}.json`), 'utf8')).sessionId ?? null;
  } catch {
    return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  }
}
