import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { ConnectorClient } from './client.js';
import type { ClaudeServer } from './servers.js';

/** The tools Companion uses. All read-only; any other tool would need approval. */
export const GITHUB_READ_TOOLS = ['get_me', 'search_pull_requests', 'search_issues'] as const;

export function isGitHubServer(s: ClaudeServer): boolean {
  if (s.config.url) return /^https:\/\/api\.githubcopilot\.com\/mcp(\/|$)/.test(s.config.url);
  return [s.config.command, ...(s.config.args ?? [])].some((a) => a?.includes('github-mcp-server'));
}

export const GitHubItem = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string().nullable(),
});
export type GitHubItem = z.infer<typeof GitHubItem>;

export const GitHubActivity = z.object({
  login: z.string(),
  since: z.string(),
  awaitingReview: z.array(GitHubItem),
  failingCi: z.array(GitHubItem),
  merged: z.array(GitHubItem),
  newIssues: z.array(GitHubItem),
});
export type GitHubActivity = z.infer<typeof GitHubActivity>;

/** Who the token belongs to. Doubles as the connection check. */
export async function githubLogin(client: ConnectorClient): Promise<string> {
  const me = JSON.parse(await client.call('get_me', {})) as { login?: string; details?: { login?: string } };
  const login = me.login ?? me.details?.login;
  if (!login) throw new Error('get_me returned no login');
  return login;
}

/**
 * What happened on GitHub since `since` that matters this morning: reviews waiting on you, your
 * PRs with failing checks, what merged, and new issues. `repos` (owner/name) are the repositories
 * you worked in, so merges and issues there count even when they aren't yours.
 */
export async function fetchGitHubActivity(client: ConnectorClient, since: Date, repos: string[]): Promise<GitHubActivity> {
  const login = await githubLogin(client);
  const day = since.toISOString().slice(0, 10);
  const inRepos = repos.length ? repos.slice(0, 10).map((r) => `repo:${r}`).join(' ') : null;
  const search = async (tool: 'search_pull_requests' | 'search_issues', query: string) =>
    parseSearch(await client.call(tool, { query, perPage: 20, sort: 'updated', order: 'desc' }));
  const both = async (tool: 'search_pull_requests' | 'search_issues', mine: string, theirs: string | null) =>
    dedupe([...(await search(tool, mine)), ...(theirs ? await search(tool, theirs) : [])]);

  return {
    login,
    since: since.toISOString(),
    awaitingReview: await search('search_pull_requests', 'is:pr is:open archived:false review-requested:@me'),
    failingCi: await search('search_pull_requests', 'is:pr is:open archived:false author:@me status:failure'),
    merged: await both('search_pull_requests', `is:pr is:merged author:@me merged:>=${day}`, inRepos && `is:pr is:merged merged:>=${day} ${inRepos}`),
    newIssues: await both('search_issues', `is:issue is:open assignee:@me created:>=${day}`, inRepos && `is:issue is:open created:>=${day} ${inRepos}`),
  };
}

const SearchResult = z.object({
  items: z.array(
    z.looseObject({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      repository_url: z.string().optional(),
      updated_at: z.string().nullish(),
    }),
  ),
});

/** The server returns GitHub's search API response as JSON text. */
export function parseSearch(text: string): GitHubItem[] {
  const parsed = SearchResult.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Unexpected search result: ${parsed.error.message.slice(0, 200)}`);
  return parsed.data.items.map((i) => ({
    repo: i.repository_url?.match(/repos\/([^/]+\/[^/]+)$/)?.[1] ?? i.html_url.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? '',
    number: i.number,
    title: i.title.slice(0, 200),
    url: i.html_url,
    updatedAt: i.updated_at ?? null,
  }));
}

const dedupe = (items: GitHubItem[]) => [...new Map(items.map((i) => [i.url, i])).values()];

const repoCache = new Map<string, string | null>();

/** The GitHub repository (owner/name) a folder's `origin` points at, if any. */
export function githubRepo(cwd: string): string | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;
  let repo: string | null = null;
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    repo = url.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {}
  repoCache.set(cwd, repo);
  return repo;
}
