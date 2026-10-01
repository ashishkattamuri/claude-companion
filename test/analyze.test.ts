import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Digest, chunkLines, digestCandidates } from '../src/analyze/digest.js';
import type { LlmClient, LlmRequest } from '../src/analyze/llm.js';
import { LlmError } from '../src/analyze/llm.js';
import { Recap, getRecap, recapDay, recapWindow } from '../src/analyze/recap.js';
import { readStatus, runJobs } from '../src/analyze/runner.js';
import { loadConfig, type Config } from '../src/config.js';
import { hookStatus, installHook, uninstallHook } from '../src/hooks/install.js';
import { scan } from '../src/ingest/scanner.js';
import { openDb, type DB } from '../src/store/db.js';

// "Now" is Thursday morning; Wednesday is the day being recapped.
const NOW = new Date(2026, 9, 1, 8, 0).getTime();
const at = (day: number, hour: number, min = 0) => new Date(2026, 8, day, hour, min).toISOString();

class FakeLlm implements LlmClient {
  calls: LlmRequest<unknown>[] = [];
  fail: Error | null = null;
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls.push(req as LlmRequest<unknown>);
    if (this.fail) throw this.fail;
    if (req.schema === (Digest as unknown)) {
      return { summary: `digest #${this.calls.length}`, status: 'in_progress', open_threads: ['flaky test'], next_steps: ['fix it'] } as T;
    }
    if (req.schema === (Recap as unknown)) {
      return {
        headline: 'Busy day',
        projects: [{ project: 'demo-app', summary: 'Worked on retries.', session_ids: ['s1'] }],
        action_items: [{ text: 'Fix the flaky test', why: 'left mid-flight', priority: 'high', project: 'demo-app', session_id: 's1' }],
        blockers: [],
      } as T;
    }
    throw new Error('unexpected schema');
  }
}

let root: string;
let projectDir: string;
let db: DB;
let cfg: Config;
let llm: FakeLlm;

type Line = Record<string, unknown>;
const prompt = (session: string, uuid: string, ts: string, text: string): Line => ({
  type: 'user', uuid, sessionId: session, timestamp: ts, cwd: '/work/demo-app', message: { role: 'user', content: text },
});
const reply = (session: string, uuid: string, ts: string, text: string): Line => ({
  type: 'assistant', uuid, sessionId: session, timestamp: ts, cwd: '/work/demo-app',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const away = (session: string, uuid: string, ts: string, text: string): Line => ({
  type: 'system', subtype: 'away_summary', uuid, sessionId: session, timestamp: ts, cwd: '/work/demo-app', isMeta: false,
  content: `${text} (disable recaps in /config)`,
});

function writeSession(id: string, lines: Line[]) {
  writeFileSync(join(projectDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** A session with `n` prompt/reply pairs starting at the given time. */
function conversation(id: string, start: string, n: number): Line[] {
  const t0 = Date.parse(start);
  return Array.from({ length: n }, (_, i) => [
    prompt(id, `${id}-p${i}`, new Date(t0 + i * 60_000).toISOString(), `question ${i}`),
    reply(id, `${id}-r${i}`, new Date(t0 + i * 60_000 + 30_000).toISOString(), `answer ${i}`),
  ]).flat();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-analyze-'));
  projectDir = join(root, 'claude', 'projects', '-work-demo-app');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(root, 'config.toml'),
    `[sources]\nclaude_dir = "${join(root, 'claude')}"\n[data]\ndir = "${join(root, 'data')}"\n`,
  );
  process.env.COMPANION_DB = join(root, 'data', 'db.sqlite');
  cfg = loadConfig(join(root, 'config.toml'));
  db = openDb(cfg.dbPath);
  llm = new FakeLlm();
});

afterEach(() => {
  db.close();
  delete process.env.COMPANION_DB;
  rmSync(root, { recursive: true, force: true });
});

const digestOf = (id: string) =>
  db.prepare(`SELECT source, covers_until, digest_json FROM session_digests WHERE session_id = ?`).get(id) as
    | { source: string; covers_until: string; digest_json: string }
    | undefined;

describe('session digests', () => {
  it('uses Claude Code\'s away summary when nothing happened after it, without a model call', async () => {
    writeSession('s1', [...conversation('s1', at(30, 10), 3), away('s1', 's1-away', at(30, 11), 'Goal: retries. Next: fix the flaky test.')]);
    await runJobs(db, cfg, llm, { now: NOW });
    const d = digestOf('s1')!;
    expect(d.source).toBe('away_summary');
    expect(JSON.parse(d.digest_json).summary).toBe('Goal: retries. Next: fix the flaky test.');
    expect(llm.calls.filter((c) => c.purpose === 'digest')).toHaveLength(0);
  });

  it('summarises only what happened after the away summary, using it as the starting point', async () => {
    writeSession('s1', [
      ...conversation('s1', at(30, 9), 3),
      away('s1', 's1-away', at(30, 10), 'Goal: retries.'),
      ...conversation('s1', at(30, 11), 2).map((l) => ({ ...l, uuid: `late-${l.uuid}` })),
    ]);
    await runJobs(db, cfg, llm, { now: NOW });
    const call = llm.calls.find((c) => c.purpose === 'digest')!;
    expect(call.prompt).toContain('Goal: retries.');
    expect(call.prompt).toContain('[USER] question 0');
    expect(call.prompt.match(/\[USER\]/g)).toHaveLength(2); // only the two prompts after the away summary
    expect(digestOf('s1')!.source).toBe('llm');
  });

  it('skips short sessions and makes no calls on a second run', async () => {
    writeSession('s1', conversation('s1', at(30, 10), 3));
    writeSession('tiny', conversation('tiny', at(30, 12), 1));
    const first = await runJobs(db, cfg, llm, { now: NOW });
    expect(first.digested).toBe(1);
    expect(digestOf('tiny')).toBeUndefined();

    const before = llm.calls.length;
    const second = await runJobs(db, cfg, llm, { now: NOW });
    expect(second.llmCalls).toBe(0);
    expect(llm.calls.length).toBe(before);
  });

  it('extends the previous summary when a session continues', async () => {
    writeSession('s1', conversation('s1', at(30, 10), 3));
    await runJobs(db, cfg, llm, { now: NOW });
    writeSession('s1', [...conversation('s1', at(30, 10), 3), ...conversation('s1', at(30, 15), 4).map((l) => ({ ...l, uuid: `more-${l.uuid}` }))]);
    await runJobs(db, cfg, llm, { now: NOW });
    const last = llm.calls.filter((c) => c.purpose === 'digest').at(-1)!;
    expect(last.prompt).toContain('<summary_so_far>');
    expect(last.prompt.match(/\[USER\]/g)).toHaveLength(4);
  });

  it('splits long stretches into chunks and rolls the summary forward', async () => {
    writeSession('s1', conversation('s1', at(30, 10), 6));
    await runJobs(db, cfg, llm, { now: NOW, chunkChars: 60 });
    const digests = llm.calls.filter((c) => c.purpose === 'digest');
    expect(digests.length).toBeGreaterThan(1);
    expect(digests[1]!.prompt).toContain('digest #1');
  });

  it('waits for live sessions to go quiet, unless the session has ended', () => {
    scan(db, cfg);
    writeSession('s1', conversation('s1', new Date(NOW - 2 * 60_000).toISOString(), 3));
    scan(db, cfg);
    const live = new Set(['s1']);
    expect(digestCandidates(db, cfg, { now: NOW, liveSessionIds: live })).toHaveLength(0);
    expect(digestCandidates(db, cfg, { now: NOW, liveSessionIds: live, endedSessionIds: new Set(['s1']) })).toHaveLength(1);
  });

  it('chunks lines without splitting them', () => {
    expect(chunkLines(['aaaa', 'bbbb', 'cc'], 9)).toEqual(['aaaa\nbbbb', 'cc']);
  });
});

describe('recap', () => {
  it('covers yesterday, starting the day at 04:00', () => {
    expect(recapDay(cfg, NOW).day).toBe('2026-10-01');
    expect(recapDay(cfg, new Date(2026, 9, 1, 3, 0).getTime()).day).toBe('2026-09-30');
    writeSession('s1', conversation('s1', at(30, 23, 30), 3)); // late Wednesday night
    scan(db, cfg);
    const w = recapWindow(db, cfg, NOW)!;
    expect(w.start).toEqual(new Date(2026, 8, 30, 4, 0));
    expect(w.end).toEqual(new Date(2026, 9, 1, 4, 0));
  });

  it('falls back to the last active day when yesterday was empty', () => {
    writeSession('s1', conversation('s1', at(27, 14), 3)); // Sunday
    scan(db, cfg);
    expect(recapWindow(db, cfg, NOW)!.start).toEqual(new Date(2026, 8, 27, 4, 0));
  });

  it('writes the recap from session summaries, once per day', async () => {
    writeSession('s1', conversation('s1', at(30, 10), 3));
    writeSession('old', conversation('old', at(20, 10), 3));
    const r = await runJobs(db, cfg, llm, { now: NOW });
    expect(r.recapWritten).toBe(true);

    const recapCall = llm.calls.find((c) => c.purpose === 'recap')!;
    expect(recapCall.prompt).toContain('"session_id": "s1"');
    expect(recapCall.prompt).toContain('digest #');
    expect(recapCall.prompt).not.toContain('"old"');
    expect(getRecap(db, '2026-10-01')!.recap.action_items[0]!.text).toBe('Fix the flaky test');

    expect((await runJobs(db, cfg, llm, { now: NOW })).recapWritten).toBe(false);
    expect((await runJobs(db, cfg, llm, { now: NOW, forceRecap: true })).recapWritten).toBe(true);
  });

  it('still recaps sessions whose transcript Claude Code has deleted', async () => {
    writeSession('s1', conversation('s1', at(30, 10), 3));
    await runJobs(db, cfg, llm, { now: NOW });
    rmSync(join(projectDir, 's1.jsonl'));
    await runJobs(db, cfg, llm, { now: NOW, forceRecap: true });
    expect(llm.calls.filter((c) => c.purpose === 'recap').at(-1)!.prompt).toContain('"session_id": "s1"');
  });

  it('pauses instead of failing loudly when Claude usage limits are hit', async () => {
    writeSession('s1', conversation('s1', at(30, 10), 3));
    llm.fail = new LlmError('Claude usage limit reached', true);
    await expect(runJobs(db, cfg, llm, { now: NOW })).rejects.toThrow();
    expect(readStatus(db)?.state).toBe('paused');
  });

  it('respects the per-run call budget', async () => {
    for (const id of ['a', 'b', 'c']) writeSession(id, conversation(id, at(30, 10), 3));
    cfg.limits.max_llm_calls_per_run = 2;
    const r = await runJobs(db, cfg, llm, { now: NOW });
    expect(r.llmCalls).toBe(2);
    expect(r.recapWritten).toBe(false);
  });
});

describe('SessionEnd hook install', () => {
  it('adds our hook next to existing ones, idempotently, and removes only ours', () => {
    const claudeDir = join(root, 'claude');
    const settings = join(claudeDir, 'settings.json');
    const theirs = { hooks: [{ type: 'command', command: 'echo bye' }] };
    writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { SessionEnd: [theirs], Stop: [theirs] } }));

    const { backup } = installHook(claudeDir, 'node cli.js hook session-end # claude-companion');
    installHook(claudeDir, 'node cli.js hook session-end # claude-companion');
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    expect(after.model).toBe('opus');
    expect(after.hooks.SessionEnd).toHaveLength(2);
    expect(hookStatus(claudeDir).installed).toBe(true);
    expect(JSON.parse(readFileSync(backup!, 'utf8')).hooks.SessionEnd).toHaveLength(1);

    expect(uninstallHook(claudeDir)).toBe(true);
    const removed = JSON.parse(readFileSync(settings, 'utf8'));
    expect(removed.hooks.SessionEnd).toEqual([theirs]);
    expect(removed.hooks.Stop).toEqual([theirs]);
    expect(uninstallHook(claudeDir)).toBe(false);
  });

  it('refuses to edit a settings file it cannot parse', () => {
    const claudeDir = join(root, 'claude');
    writeFileSync(join(claudeDir, 'settings.json'), '{ broken');
    expect(() => installHook(claudeDir, 'x # claude-companion')).toThrow(/not valid JSON/);
  });
});

describe('ClaudeCliClient', () => {
  it('calls claude in isolation, sends the prompt on stdin and validates the result', async () => {
    const { ClaudeCliClient } = await import('../src/analyze/llm.js');
    const argsFile = join(root, 'args.txt');
    const stdinFile = join(root, 'stdin.txt');
    const fake = join(root, 'fake-claude.sh');
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat > "${stdinFile}"\necho "$COMPANION_INTERNAL" >> "${argsFile}"\n` +
        `echo '{"type":"result","is_error":false,"total_cost_usd":0.01,"structured_output":{"summary":"ok","status":"done","open_threads":[],"next_steps":[]}}'\n`,
      { mode: 0o755 },
    );
    process.env.COMPANION_CLAUDE_BIN = fake;
    try {
      const client = new ClaudeCliClient(db, join(root, 'run'));
      const out = await client.complete({ purpose: 'digest', model: 'haiku', system: 'sys', prompt: 'the transcript', schema: Digest });
      expect(out.summary).toBe('ok');

      const args = readFileSync(argsFile, 'utf8').split('\n');
      expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '--tools']));
      const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!);
      expect(schema.$schema).toBeUndefined();
      expect(schema.required).toContain('summary');
      expect(args).toContain('1'); // COMPANION_INTERNAL
      expect(readFileSync(stdinFile, 'utf8')).toBe('the transcript');
      expect(db.prepare(`SELECT ok, cost_usd FROM llm_calls`).get()).toEqual({ ok: 1, cost_usd: 0.01 });
    } finally {
      delete process.env.COMPANION_CLAUDE_BIN;
    }
  });
});
