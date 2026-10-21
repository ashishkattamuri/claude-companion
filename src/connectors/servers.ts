import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/** One entry of `mcpServers` in Claude Code's settings, as `claude mcp add` writes it. */
export const ServerConfig = z.looseObject({
  type: z.enum(['stdio', 'http', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export interface ClaudeServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** The URL, or the command line, for display. */
  target: string;
  config: ServerConfig;
}

/**
 * The MCP servers available to every Claude Code session (user scope). Servers added for one
 * project, and connectors that come with a claude.ai login, aren't in this list.
 */
export function readClaudeServers(claudeJson: string): ClaudeServer[] {
  if (!existsSync(claudeJson)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(claudeJson, 'utf8'));
  } catch {
    return [];
  }
  const servers = (raw as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {};
  return Object.entries(servers).flatMap(([name, value]) => {
    const parsed = ServerConfig.safeParse(value);
    if (!parsed.success) return [];
    const config = parsed.data;
    const transport = config.type ?? (config.url ? 'http' : 'stdio');
    const target = config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
    return [{ name, transport, target, config }];
  });
}

/** Adds a server to Claude Code for every session (`claude mcp add-json --scope user`). */
export function addClaudeServer(claudeBin: string, env: Record<string, string>, name: string, config: ServerConfig): string | null {
  const r = spawnSync(claudeBin, ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(config)], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return r.status === 0 ? null : `claude mcp add-json failed: ${(r.stderr || r.stdout || String(r.error ?? '')).trim().split('\n')[0]}`;
}

export function removeClaudeServer(claudeBin: string, env: Record<string, string>, name: string): string | null {
  const r = spawnSync(claudeBin, ['mcp', 'remove', '--scope', 'user', name], { env, encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? null : `claude mcp remove failed: ${(r.stderr || r.stdout || String(r.error ?? '')).trim().split('\n')[0]}`;
}

/** Claude Code expands `${VAR}` and `${VAR:-default}` in server settings; do the same. */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? '');
}
