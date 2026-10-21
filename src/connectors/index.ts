import type { Config } from '../config.js';
import type { DB } from '../store/db.js';
import { ConnectorClient } from './client.js';
import { GITHUB_READ_TOOLS, GitHubActivity, fetchGitHubActivity, githubLogin, githubRepo, isGitHubServer } from './github.js';
import { missingVars, readAllServers, type ClaudeServer } from './servers.js';

/**
 * Connectors are what Claude Code already has: its plugins (see plugins.ts) and the MCP servers in
 * its settings or brought by plugins. Companion keeps only which servers it may read from and how
 * the last check went. Features ask this module for data and never talk to a server directly.
 */
export type ConnectorKind = 'github';

export interface ServerView {
  name: string;
  transport: ClaudeServer['transport'];
  target: string;
  /** What Companion can use it for, e.g. GitHub in the morning recap. */
  kind: ConnectorKind | null;
  /** The plugin it comes with; removed by uninstalling that plugin. */
  plugin: string | null;
  /** Variables its settings need that aren't set, e.g. a token. */
  needs: string[];
  /** Companion may read from it. */
  enabled: boolean;
  status: 'connected' | 'error' | null;
  /** Who it's signed in as, or what went wrong. */
  detail: string | null;
  checkedAt: string | null;
}


export function kindOf(s: ClaudeServer): ConnectorKind | null {
  return isGitHubServer(s) ? 'github' : null;
}

interface StateRow {
  name: string;
  enabled: number;
  status: 'connected' | 'error' | null;
  detail: string | null;
  checked_at: string | null;
}

function serverViews(db: DB, cfg: Config): ServerView[] {
  const state = new Map(
    db.prepare<[], StateRow>(`SELECT * FROM connector_servers`).all().map((r) => [r.name, r]),
  );
  return allServers(cfg).map((s) => {
    const r = state.get(s.name);
    return {
      name: s.name,
      transport: s.transport,
      target: redact(s.target),
      kind: kindOf(s),
      plugin: s.plugin ?? null,
      needs: missingVars(s.config, process.env),
      enabled: !!r?.enabled,
      status: r?.status ?? null,
      detail: r?.detail ?? null,
      checkedAt: r?.checked_at ?? null,
    };
  });
}

const allServers = (cfg: Config) => readAllServers(cfg.claudeJson, cfg.claudeDir);

/** Claude Code's MCP servers, from its settings and from enabled plugins. */
export function listServers(db: DB, cfg: Config): ServerView[] {
  return serverViews(db, cfg);
}

/** Turning a server off also forgets what Companion fetched from it. */
export function setServerEnabled(db: DB, cfg: Config, name: string, enabled: boolean): void {
  db.prepare(
    `INSERT INTO connector_servers(name, enabled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
  ).run(name, enabled ? 1 : 0);
  if (!enabled) forgetServer(db, cfg, name, false);
}

/** Drops Companion's record of a server and the data it fetched (after it's removed, or turned off). */
export function forgetServer(db: DB, cfg: Config, name: string, removeRow = true): void {
  const server = allServers(cfg).find((s) => s.name === name);
  const kind = server ? kindOf(server) : null;
  if (removeRow) db.prepare(`DELETE FROM connector_servers WHERE name = ?`).run(name);
  if (kind && !enabledServer(db, cfg, kind)) db.prepare(`DELETE FROM recap_sources WHERE kind = ?`).run(kind);
}

/** Connects to a server and records whether that worked. Only lists tools, except for known kinds. */
export async function checkServer(db: DB, cfg: Config, name: string): Promise<ServerView | null> {
  const server = allServers(cfg).find((s) => s.name === name);
  if (!server) return null;
  let status: 'connected' | 'error' = 'connected';
  let detail: string;
  const kind = kindOf(server);
  try {
    const client = await ConnectorClient.open(server, { readTools: kind === 'github' ? GITHUB_READ_TOOLS : [] });
    try {
      detail = kind === 'github' ? `Signed in as @${await githubLogin(client)}` : `${(await client.tools()).length} tools`;
    } finally {
      await client.close();
    }
  } catch (err) {
    status = 'error';
    detail = (err as Error).message;
  }
  db.prepare(
    `INSERT INTO connector_servers(name, enabled, status, detail, checked_at) VALUES (?, 0, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(name, status, detail, new Date().toISOString());
  return serverViews(db, cfg).find((v) => v.name === name) ?? null;
}

export function enabledServer(db: DB, cfg: Config, kind: ConnectorKind): ClaudeServer | null {
  const enabled = new Set(
    db.prepare<[], { name: string }>(`SELECT name FROM connector_servers WHERE enabled = 1`).all().map((r) => r.name),
  );
  return allServers(cfg).find((s) => enabled.has(s.name) && kindOf(s) === kind) ?? null;
}

export interface RecapSource {
  github: GitHubActivity | null;
  /** Set when GitHub is on but couldn't be read. */
  githubError: string | null;
}

/** GitHub activity for the recap, if a GitHub server is on. Failures are reported, never thrown. */
export async function gatherForRecap(db: DB, cfg: Config, since: Date, cwds: string[]): Promise<RecapSource | null> {
  const server = enabledServer(db, cfg, 'github');
  if (!server) return null;
  const repos = [...new Set(cwds.map(githubRepo).filter((r): r is string => !!r))];
  try {
    const client = await ConnectorClient.open(server, { readTools: GITHUB_READ_TOOLS });
    try {
      return { github: await fetchGitHubActivity(client, since, repos), githubError: null };
    } finally {
      await client.close();
    }
  } catch (err) {
    return { github: null, githubError: `GitHub (${server.name}): ${(err as Error).message}` };
  }
}

export function saveRecapSource(db: DB, day: string, source: RecapSource | null): void {
  db.prepare(`DELETE FROM recap_sources WHERE day = ? AND kind = 'github'`).run(day);
  if (!source) return;
  db.prepare(`INSERT INTO recap_sources(day, kind, data_json, error, fetched_at) VALUES (?, 'github', ?, ?, ?)`).run(
    day,
    source.github ? JSON.stringify(source.github) : null,
    source.githubError,
    new Date().toISOString(),
  );
}

export function getRecapSource(db: DB, day: string): RecapSource | null {
  const row = db
    .prepare<[string], { data_json: string | null; error: string | null }>(`SELECT data_json, error FROM recap_sources WHERE day = ? AND kind = 'github'`)
    .get(day);
  if (!row) return null;
  const github = row.data_json ? GitHubActivity.safeParse(JSON.parse(row.data_json)) : null;
  return { github: github?.success ? github.data : null, githubError: row.error };
}

const OFFER_KEY = 'connector_offer_dismissed:github';

/**
 * Whether Today should offer GitHub: you work in GitHub repositories and Companion doesn't read
 * from GitHub yet. `existing` names a GitHub server you already have in Claude Code; without one,
 * the offer leads to the GitHub plugin.
 */
export function githubOffer(db: DB, cfg: Config, recentCwds: string[]): { existing: string | null } | null {
  if (enabledServer(db, cfg, 'github')) return null;
  if (db.prepare(`SELECT 1 FROM meta WHERE key = ?`).get(OFFER_KEY)) return null;
  if (!recentCwds.some((c) => githubRepo(c))) return null;
  return { existing: allServers(cfg).find(isGitHubServer)?.name ?? null };
}

export function dismissGithubOffer(db: DB): void {
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)`).run(OFFER_KEY, new Date().toISOString());
}

/** Tokens can sit in a stdio server's command line; don't show them. */
function redact(target: string): string {
  return target.replace(/\b(gh[pousr]_[A-Za-z0-9]{8})[A-Za-z0-9_]+/g, '$1…').replace(/(github_pat_[A-Za-z0-9]{6})[A-Za-z0-9_]+/g, '$1…');
}
