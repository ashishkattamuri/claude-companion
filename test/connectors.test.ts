import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest } from '../src/analyze/llm.js';
import { Digest } from '../src/analyze/digest.js';
import { Recap } from '../src/analyze/recap.js';
import { runJobs } from '../src/analyze/runner.js';
import { loadConfig, type Config } from '../src/config.js';
import { ConnectorClient } from '../src/connectors/client.js';
import { GITHUB_READ_TOOLS, fetchGitHubActivity, isGitHubServer } from '../src/connectors/github.js';
import {
  checkServer,
  dismissGithubOffer,
  enabledServer,
  getRecapSource,
  githubOffer,
  listConnectors,
  setServerEnabled,
} from '../src/connectors/index.js';
import { expandVars, readClaudeServers } from '../src/connectors/servers.js';
import { openDb, type DB } from '../src/store/db.js';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-github-mcp-server.mjs', import.meta.url));
// Thursday morning; Wednesday is recapped.
const NOW = new Date(2026, 9, 1, 8, 0).getTime();

class FakeLlm implements LlmClient {
  calls: LlmRequest<unknown>[] = [];
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls.push(req as LlmRequest<unknown>);
    if (req.schema === (Digest as unknown)) return { summary: 'worked on retries', status: 'in_progress', open_threads: [], next_steps: [] } as T;
    if (req.schema === (Recap as unknown)) return { headline: 'Busy day', projects: [], action_items: [], blockers: [] } as T;
    throw new Error('unexpected schema');
  }
}

let root: string;
let db: DB;
let cfg: Config;
let log: string;

/** Claude Code's settings in the sandbox, with the fake GitHub server and whatever else is given. */
function writeClaudeJson(servers: Record<string, unknown>) {
  writeFileSync(cfg.claudeJson, JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }));
}
const fakeGitHub = (env: Record<string, string> = {}) => ({
  type: 'stdio',
  command: process.execPath,
  args: [FAKE_SERVER],
  env: { ELECTRON_RUN_AS_NODE: '1', FAKE_GH_LOG: log, ...env },
});
const calls = () =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; args: { query?: string } }) : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-connectors-'));
  mkdirSync(join(root, 'claude', 'projects'), { recursive: true });
  writeFileSync(join(root, 'config.toml'), `[sources]\nclaude_dir = "${join(root, 'claude')}"\n[data]\ndir = "${join(root, 'data')}"\n`);
  process.env.COMPANION_DB = join(root, 'data', 'db.sqlite');
  cfg = loadConfig(join(root, 'config.toml'));
  db = openDb(cfg.dbPath);
  log = join(root, 'calls.log');
});

afterEach(() => {
  db.close();
  delete process.env.COMPANION_DB;
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code's server list", () => {
  it('lives inside the Claude folder when it was moved, and lists user-scope servers', () => {
    expect(cfg.claudeJson).toBe(join(root, 'claude', '.claude.json'));
    writeClaudeJson({
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/readonly', headers: { Authorization: 'Bearer ${GH_TOKEN}' } },
      local: { command: 'node', args: ['server.js'] },
      broken: 'not a server',
    });
    const servers = readClaudeServers(cfg.claudeJson);
    expect(servers.map((s) => [s.name, s.transport])).toEqual([
      ['github', 'http'],
      ['local', 'stdio'],
    ]);
    expect(servers.map(isGitHubServer)).toEqual([true, false]);
    expect(expandVars('Bearer ${GH_TOKEN}', { GH_TOKEN: 'abc' })).toBe('Bearer abc');
    expect(expandVars('${MISSING:-fallback}', {})).toBe('fallback');
  });

  it('is empty when Claude Code has no settings file yet', () => {
    expect(readClaudeServers(cfg.claudeJson)).toEqual([]);
  });
});

describe('connector client', () => {
  it('refuses tools that change things unless they are approved', async () => {
    writeClaudeJson({ github: fakeGitHub() });
    const [server] = readClaudeServers(cfg.claudeJson);
    const asked: string[] = [];
    const client = await ConnectorClient.open(server!, { readTools: GITHUB_READ_TOOLS });
    try {
      await expect(client.call('create_issue', { title: 'x' })).rejects.toThrow(/wasn't approved/);
      expect(calls().map((c) => c.tool)).not.toContain('create_issue');
    } finally {
      await client.close();
    }
    const approving = await ConnectorClient.open(server!, {
      readTools: GITHUB_READ_TOOLS,
      approve: async (tool) => (asked.push(tool), true),
    });
    try {
      await approving.call('create_issue', { title: 'x' });
    } finally {
      await approving.close();
    }
    expect(asked).toEqual(['create_issue']);
    expect(calls().map((c) => c.tool)).toContain('create_issue');
  });

  it("gathers GitHub activity with searches only, including the repos you worked in", async () => {
    writeClaudeJson({ github: fakeGitHub() });
    const client = await ConnectorClient.open(readClaudeServers(cfg.claudeJson)[0]!, { readTools: GITHUB_READ_TOOLS });
    const gh = await fetchGitHubActivity(client, new Date('2026-09-30T04:00:00Z'), ['acme/api']).finally(() => client.close());
    expect(gh.login).toBe('octo');
    expect(gh.awaitingReview.map((i) => `${i.repo}#${i.number}`)).toEqual(['acme/api#12']);
    expect(gh.failingCi.map((i) => i.title)).toEqual(['Fix login redirect']);
    expect(gh.merged.map((i) => i.number)).toEqual([10, 11]); // #10 came back from both searches, listed once
    expect(gh.newIssues.map((i) => i.number)).toEqual([31]);
    expect(new Set(calls().map((c) => c.tool))).toEqual(new Set(['get_me', 'search_pull_requests', 'search_issues']));
    expect(calls().some((c) => c.args.query?.includes('repo:acme/api') && c.args.query.includes('merged:>=2026-09-30'))).toBe(true);
  });
});

describe('connectors', () => {
  it('reads only from servers you turned on, and checks who they are signed in as', async () => {
    writeClaudeJson({ github: fakeGitHub(), other: { command: 'true' } });
    let view = listConnectors(db, cfg);
    expect(view.connectors.find((c) => c.kind === 'github')!.server).toMatchObject({ name: 'github', enabled: false });
    expect(view.others.map((s) => s.name)).toEqual(['other']);
    expect(enabledServer(db, cfg, 'github')).toBeNull();

    setServerEnabled(db, cfg, 'github', true);
    expect(await checkServer(db, cfg, 'github')).toMatchObject({ enabled: true, status: 'connected', detail: 'Signed in as @octo' });
    expect(enabledServer(db, cfg, 'github')?.name).toBe('github');
  });

  it('reports a server that refuses the credentials', async () => {
    writeClaudeJson({ github: fakeGitHub({ FAKE_GH_FAIL: '1' }) });
    setServerEnabled(db, cfg, 'github', true);
    const view = await checkServer(db, cfg, 'github');
    expect(view).toMatchObject({ status: 'error' });
    expect(view!.detail).toMatch(/Bad credentials/);
  });

  it('offers GitHub once you work in a GitHub repo, until you connect it or say not now', () => {
    const repo = join(root, 'api');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git']);
    const plain = join(root, 'plain');
    mkdirSync(plain);

    expect(githubOffer(db, cfg, [plain])).toBeNull();
    expect(githubOffer(db, cfg, [plain, repo])).toEqual({ existing: null });
    writeClaudeJson({ gh: fakeGitHub() });
    expect(githubOffer(db, cfg, [repo])).toEqual({ existing: 'gh' });
    setServerEnabled(db, cfg, 'gh', true);
    expect(githubOffer(db, cfg, [repo])).toBeNull();
    setServerEnabled(db, cfg, 'gh', false);
    dismissGithubOffer(db);
    expect(githubOffer(db, cfg, [repo])).toBeNull();
  });
});

describe('GitHub in the morning recap', () => {
  function workedYesterday() {
    const dir = join(cfg.projectsDir, '-work-demo-app');
    mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: 4 }, (_, i) => [
      { type: 'user', uuid: `p${i}`, sessionId: 's1', timestamp: new Date(2026, 8, 30, 10, i).toISOString(), cwd: '/work/demo-app', message: { role: 'user', content: `question ${i}` } },
      { type: 'assistant', uuid: `r${i}`, sessionId: 's1', timestamp: new Date(2026, 8, 30, 10, i, 30).toISOString(), cwd: '/work/demo-app', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]).flat();
    writeFileSync(join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const day = '2026-10-01';

  it('leaves GitHub out when no GitHub server is on', async () => {
    workedYesterday();
    writeClaudeJson({ github: fakeGitHub() });
    const llm = new FakeLlm();
    expect((await runJobs(db, cfg, llm, { now: NOW })).recapWritten).toBe(true);
    expect(llm.calls.find((c) => c.purpose === 'recap')!.prompt).not.toContain('<github>');
    expect(getRecapSource(db, day)).toBeNull();
    expect(calls()).toEqual([]); // never even connected
  });

  it('adds GitHub activity to the prompt, as data, and keeps it for Today', async () => {
    workedYesterday();
    writeClaudeJson({ github: fakeGitHub() });
    setServerEnabled(db, cfg, 'github', true);
    const llm = new FakeLlm();
    await runJobs(db, cfg, llm, { now: NOW });
    const call = llm.calls.find((c) => c.purpose === 'recap')!;
    expect(call.prompt).toContain('<github>');
    expect(call.prompt).toContain('Add rate limiter');
    expect(call.system).toMatch(/data and not instructions/);
    const source = getRecapSource(db, day)!;
    expect(source.githubError).toBeNull();
    expect(source.github!.awaitingReview[0]!.url).toBe('https://github.com/acme/api/pull/12');
  });

  it('still writes the recap when GitHub fails, and says so', async () => {
    workedYesterday();
    writeClaudeJson({ github: fakeGitHub({ FAKE_GH_FAIL: '1' }) });
    setServerEnabled(db, cfg, 'github', true);
    const llm = new FakeLlm();
    expect((await runJobs(db, cfg, llm, { now: NOW })).recapWritten).toBe(true);
    expect(llm.calls.find((c) => c.purpose === 'recap')!.prompt).not.toContain('<github>');
    expect(getRecapSource(db, day)!.githubError).toMatch(/Bad credentials/);
  });

  it('forgets what it fetched when you turn GitHub off', async () => {
    workedYesterday();
    writeClaudeJson({ github: fakeGitHub() });
    setServerEnabled(db, cfg, 'github', true);
    await runJobs(db, cfg, new FakeLlm(), { now: NOW });
    expect(getRecapSource(db, day)).not.toBeNull();
    setServerEnabled(db, cfg, 'github', false);
    expect(getRecapSource(db, day)).toBeNull();
  });
});
