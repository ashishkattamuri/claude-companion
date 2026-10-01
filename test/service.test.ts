import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/analyze/llm.js';
import { loadConfig, type Config } from '../src/config.js';
import type { LiveSession } from '../src/ingest/live.js';
import { scan } from '../src/ingest/scanner.js';
import type { SpawnSpec } from '../src/main/pty.js';
import { CompanionService, type Terminals } from '../src/main/service.js';
import type { TermInfo } from '../src/shared/api.js';
import { openDb, type DB } from '../src/store/db.js';

const SESSION = '11111111-1111-1111-1111-111111111111';
const UUID = /^[0-9a-f-]{36}$/;

class FakeTerminals implements Terminals {
  spawned: SpawnSpec[] = [];
  terms: TermInfo[] = [];
  open(spec: SpawnSpec): TermInfo {
    this.spawned.push(spec);
    const t = { id: spec.id, sessionId: spec.sessionId, title: spec.title, cwd: spec.cwd, exited: false, exitCode: null };
    this.terms.push(t);
    return t;
  }
  list() {
    return this.terms;
  }
  findBySession(id: string) {
    return this.terms.find((t) => t.sessionId === id && !t.exited) ?? null;
  }
}

const noLlm: LlmClient = {
  complete: () => Promise.reject(new Error('no model calls in this test')),
};

let root: string;
let db: DB;
let cfg: Config;
let terminals: FakeTerminals;
let live: LiveSession[];
let service: CompanionService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-service-'));
  const projectDir = join(root, 'claude', 'projects', '-work-demo-app');
  mkdirSync(projectDir, { recursive: true });
  copyFileSync(new URL('./fixtures/basic.jsonl', import.meta.url), join(projectDir, `${SESSION}.jsonl`));
  writeFileSync(join(root, 'config.toml'), `[sources]\nclaude_dir = "${join(root, 'claude')}"\n`);
  cfg = loadConfig(join(root, 'config.toml'));
  db = openDb(':memory:');
  scan(db, cfg);
  // The fixture's folder doesn't exist on this machine; point the session at one that does.
  db.prepare(`UPDATE sessions SET cwd = ?`).run(root);
  db.prepare(`UPDATE projects SET cwd = ?`).run(root);
  terminals = new FakeTerminals();
  live = [];
  service = new CompanionService({
    db,
    cfg,
    terminals,
    llm: noLlm,
    loadLive: () => live,
    env: () => ({ PATH: '/usr/bin' }),
    claudeBin: '/bin/claude-test',
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('opening sessions', () => {
  it('resumes a session in its own folder', () => {
    const r = service.open({ kind: 'resume', sessionId: SESSION });
    expect(r.ok).toBe(true);
    expect(terminals.spawned[0]).toMatchObject({
      file: '/bin/claude-test',
      cwd: root,
      args: ['--resume', SESSION],
      sessionId: SESSION,
      title: 'Webhook retry logic',
    });
  });

  it('focuses the existing tab instead of opening the session twice', () => {
    const first = service.open({ kind: 'resume', sessionId: SESSION });
    const second = service.open({ kind: 'resume', sessionId: SESSION });
    expect(terminals.spawned).toHaveLength(1);
    expect(second.ok && first.ok && second.term.id === first.term.id).toBe(true);
  });

  it('refuses sessions running elsewhere, deleted transcripts and missing folders', () => {
    live = [{ pid: 42, sessionId: SESSION, cwd: root, status: 'busy', name: null, version: null }];
    expect(service.open({ kind: 'resume', sessionId: SESSION })).toEqual({
      ok: false,
      error: 'This session is already running in another terminal (pid 42).',
    });
    live = [];
    db.prepare(`UPDATE sessions SET transcript_gone = 1`).run();
    expect(service.open({ kind: 'resume', sessionId: SESSION })).toMatchObject({ ok: false, error: /deleted/ });
    db.prepare(`UPDATE sessions SET transcript_gone = 0, cwd = '/nope'`).run();
    expect(service.open({ kind: 'resume', sessionId: SESSION })).toMatchObject({ ok: false, error: /not found/ });
    expect(terminals.spawned).toHaveLength(0);
  });

  it('starts new sessions with a known session id so the tab maps to its transcript', () => {
    const r = service.open({ kind: 'new', cwd: root, prompt: '  write the changelog\nwith details ' });
    expect(r.ok).toBe(true);
    const spec = terminals.spawned[0]!;
    expect(spec.args[0]).toBe('--session-id');
    expect(spec.args[1]).toMatch(UUID);
    expect(spec.args[1]).toBe(spec.sessionId);
    expect(spec.args[2]).toBe('write the changelog\nwith details');
    expect(spec.title).toBe('write the changelog');
    expect(spec.env).toEqual({ PATH: '/usr/bin' });
  });

  it('runs recap action items fresh in the right folder, or continues their session', () => {
    service.open({ kind: 'action', mode: 'new', sessionId: SESSION, project: 'demo-app', text: 'Fix the flaky test' });
    expect(terminals.spawned[0]).toMatchObject({ cwd: root });
    expect(terminals.spawned[0]!.args.at(-1)).toBe('Fix the flaky test');

    service.open({ kind: 'action', mode: 'continue', sessionId: SESSION, project: 'demo-app', text: 'x' });
    expect(terminals.spawned[1]!.args).toEqual(['--resume', SESSION]);

    // No session id: fall back to the project's folder.
    service.open({ kind: 'action', mode: 'new', sessionId: '', project: 'demo-app', text: 'Write docs' });
    expect(terminals.spawned[2]).toMatchObject({ cwd: root });
    expect(service.open({ kind: 'action', mode: 'new', sessionId: '', project: 'unknown', text: 'x' })).toMatchObject({ ok: false });
  });
});

describe('session list', () => {
  it('marks sessions open in a tab and lists them first', () => {
    const r = service.open({ kind: 'resume', sessionId: SESSION });
    const [first] = service.listSessions({});
    expect(first!.id).toBe(SESSION);
    expect(first!.termId).toBe(r.ok ? r.term.id : null);
  });

  it('includes live sessions that have no transcript yet', () => {
    live = [{ pid: 7, sessionId: 'fresh', cwd: '/work/new', status: 'idle', name: 'fresh-start', version: null }];
    const items = service.listSessions({});
    expect(items.map((s) => s.title)).toContain('fresh-start');
    expect(service.listSessions({ search: 'backoff' }).map((s) => s.id)).toEqual([SESSION]);
  });
});
