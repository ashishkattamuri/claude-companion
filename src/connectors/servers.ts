import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  /** The plugin that brings it, for servers that come with one (named plugin:<plugin>:<server>). */
  plugin?: string;
}

/** Every server a Claude Code session gets: from its settings, and from enabled plugins. */
export function readAllServers(claudeJson: string, claudeDir: string): ClaudeServer[] {
  return [...readClaudeServers(claudeJson), ...readPluginServers(claudeDir)];
}

/**
 * MCP servers that come with enabled plugins (user scope): the plugin's `.mcp.json`, or
 * `mcpServers` in its manifest. `${CLAUDE_PLUGIN_ROOT}` is the plugin's folder.
 */
export function readPluginServers(claudeDir: string): ClaudeServer[] {
  const read = (p: string): unknown => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  const installed = (read(join(claudeDir, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, { scope?: string; installPath?: string }[]> } | null)?.plugins ?? {};
  const enabled = (read(join(claudeDir, 'settings.json')) as { enabledPlugins?: Record<string, boolean> } | null)?.enabledPlugins ?? {};
  const out: ClaudeServer[] = [];
  for (const [id, installs] of Object.entries(installed)) {
    const root = installs.find((i) => i.scope === 'user')?.installPath;
    if (!root || enabled[id] !== true) continue;
    const manifest = read(join(root, '.claude-plugin', 'plugin.json')) as { mcpServers?: unknown } | null;
    let servers: unknown = read(join(root, '.mcp.json'));
    if (typeof manifest?.mcpServers === 'string') servers = read(join(root, manifest.mcpServers));
    else if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') servers = manifest.mcpServers;
    const map = ((servers as { mcpServers?: unknown } | null)?.mcpServers ?? servers ?? {}) as Record<string, unknown>;
    const name = id.split('@')[0];
    for (const [server, value] of Object.entries(map)) {
      const parsed = ServerConfig.safeParse(JSON.parse(JSON.stringify(value ?? null).replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replaceAll('\\', '\\\\'))));
      if (!parsed.success) continue;
      out.push(toServer(`plugin:${name}:${server}`, parsed.data, id));
    }
  }
  return out;
}

function toServer(name: string, config: ServerConfig, plugin?: string): ClaudeServer {
  const transport = config.type ?? (config.url ? 'http' : 'stdio');
  const target = config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
  return { name, transport, target, config, ...(plugin ? { plugin } : {}) };
}

/** Variables a server's settings use that aren't set (and have no default), e.g. a token. */
export function missingVars(config: ServerConfig, env: Record<string, string | undefined>): string[] {
  const names = [...JSON.stringify(config).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
  return [...new Set(names)].filter((n) => !env[n]);
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
    return parsed.success ? [toServer(name, parsed.data)] : [];
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
