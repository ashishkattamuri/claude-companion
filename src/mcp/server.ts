import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { sendRequest, socketPath } from './protocol.js';

/**
 * Companion's MCP server, attached to the Claude sessions Companion starts. It gives Claude a tool
 * to open a new chat, so asking in plain words ("let's discuss this in a separate chat") works
 * from Companion and from any attached terminal alike.
 */
export async function runMcpServer(cfg: Config): Promise<void> {
  await createMcpServer(cfg).connect(new StdioServerTransport());
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
        'hidden background context, and opens with your prompt ready for the user to edit and send. ' +
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
      const r = await sendRequest(socketPath(cfg), {
        method: 'new_chat',
        params: { claudePid, sessionId: sessionIdFor(cfg, claudePid), title, prompt },
      });
      const text = r.ok
        ? r.message
        : `Could not open the new chat: ${r.error} Tell the user, and suggest opening Companion and asking again.`;
      return { content: [{ type: 'text', text }], isError: !r.ok };
    },
  );

  return server;
}

/** The calling session, from Claude Code's registry entry for our parent process. */
function sessionIdFor(cfg: Config, pid: number): string | null {
  try {
    return JSON.parse(readFileSync(join(cfg.claudeDir, 'sessions', `${pid}.json`), 'utf8')).sessionId ?? null;
  } catch {
    return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  }
}
