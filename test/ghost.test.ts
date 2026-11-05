import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../src/analyze/llm.js';
import { loadConfig, type Config } from '../src/config.js';
import type { LiveSession } from '../src/ingest/live.js';
import { CompanionService } from '../src/main/service.js';
import { openDb, type DB } from '../src/store/db.js';

const FIXTURE = new URL('./fixtures/basic.jsonl', import.meta.url);
const GHOST = '99999999-9999-9999-9999-999999999999';
const OTHER = '11111111-1111-1111-1111-111111111111';

let root: string;
let projectDir: string;
let cfg: Config;
let db: DB;
let live: LiveSession[];

const service = (llm: LlmClient = {} as LlmClient) =>
  new CompanionService({ db, cfg, llm, loadLive: () => live, env: () => ({}), analysis: false, notes: true, notesDelayMs: 0 });

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const running = (sessionId: string) => ({ pid: process.pid, sessionId, cwd: '/work/demo-app', status: 'idle', name: 'Ghost chat', version: null, kind: 'bg', jobId: sessionId.slice(0, 8) }) as LiveSession;
/** Marks a chat as a ghost chat, as starting it in ghost mode does; `startedAgo` puts it past the start-up grace. */
const ghost = (id: string, startedAgo = 60_000) =>
  db.prepare(`INSERT INTO ghost_sessions(session_id, started_at, ended_at) VALUES (?, ?, NULL)`).run(id, new Date(Date.now() - startedAgo).toISOString());

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-ghost-'));
  projectDir = join(root, 'claude', 'projects', '-work-demo-app');
  mkdirSync(projectDir, { recursive: true });
  const config = join(root, 'config.toml');
  writeFileSync(config, `[sources]\nclaude_dir = "${join(root, 'claude')}"\n[data]\ndir = "${join(root, 'data')}"\n`);
  cfg = loadConfig(config);
  db = openDb(cfg.dbPath);
  live = [];
  copyFileSync(FIXTURE, join(projectDir, `${GHOST}.jsonl`));
  copyFileSync(FIXTURE, join(projectDir, `${OTHER}.jsonl`));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ghost chats', () => {
  it('run like any chat, but nothing about them is indexed, noted or audited', async () => {
    ghost(GHOST);
    live = [running(GHOST)];
    const svc = service();
    svc.refresh();

    // Listed while it runs, marked as a ghost; never indexed or searchable.
    const row = svc.listSessions({}).find((s) => s.id === GHOST);
    expect(row).toMatchObject({ ghost: true });
    expect(svc.listSessions({}).find((s) => s.id === OTHER)).toMatchObject({ ghost: false });
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`, GHOST)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, GHOST)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM ingest_files WHERE session_id = ?`, GHOST)).toBe(0);
    expect(svc.listSessions({ search: 'webhook' }).some((s) => s.id === GHOST)).toBe(false);

    expect(svc.extras(GHOST).ghost).toBe(true);
    await svc.refreshNotes(GHOST);
    expect(count(`SELECT COUNT(*) AS n FROM session_notes WHERE session_id = ?`, GHOST)).toBe(0);
    expect(svc.auditEstimate(GHOST)).toEqual({ ok: false, error: "Ghost chats aren't audited: nothing about them is kept." });
    expect((await svc.runAudit(GHOST)).ok).toBe(false);
    expect((await svc.restartWithTools(GHOST)).ok).toBe(false);
    // Still a normal chat for everything that isn't stored.
    expect(existsSync(join(projectDir, `${GHOST}.jsonl`))).toBe(true);
  });

  it('keeps review explanations in memory only', async () => {
    ghost(GHOST);
    live = [running(GHOST)];
    // A chat that wrote one file.
    const file = join(root, 'plan.md');
    writeFileSync(file, 'step one\n');
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-11-04T10:00:00Z', message: { role: 'user', content: 'Write a plan' } },
      { type: 'assistant', uuid: 'u2', timestamp: '2026-11-04T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: file } }] } },
      { type: 'user', uuid: 'u3', timestamp: '2026-11-04T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { type: 'create', filePath: file, content: 'step one\n', originalFile: null, structuredPatch: [] } },
    ];
    writeFileSync(join(projectDir, `${GHOST}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const llm: LlmClient = { complete: async (req) => req.schema.parse({ files: [{ path: file, explanation: 'Adds a one-step plan.' }] }) };
    const svc = service(llm);
    svc.review(GHOST, true);
    await vi.waitFor(() => expect(svc.review(GHOST).files[0]?.explanation).toBe('Adds a one-step plan.'));
    expect(count(`SELECT COUNT(*) AS n FROM review_explanations`)).toBe(0);
  });

  it('are deleted when they end, and forgotten once nothing is left', async () => {
    ghost(GHOST);
    live = [running(GHOST)];
    const svc = service();
    svc.refresh();
    mkdirSync(join(projectDir, GHOST, 'subagents'), { recursive: true });
    svc.pinFile(GHOST, join(root, 'notes.md'));
    svc.setHidden([GHOST], true);
    db.prepare(`INSERT INTO session_links(child_id, parent_id, title, kind, created_at) VALUES (?, ?, 'x', 'branch', ?)`).run(OTHER, GHOST, new Date().toISOString());

    // It exits while nobody is watching: the next look deletes it.
    live = [];
    expect(svc.listSessions({}).some((s) => s.id === GHOST)).toBe(false);
    await vi.waitFor(() => expect(existsSync(join(projectDir, `${GHOST}.jsonl`))).toBe(false));
    expect(existsSync(join(projectDir, GHOST))).toBe(false);
    for (const table of ['session_pins', 'hidden_sessions', 'session_notes', 'session_audits'])
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, GHOST)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM session_links WHERE parent_id = ? OR child_id = ?`, GHOST, GHOST)).toBe(0);
    // No "deleted" record either: a ghost chat leaves no trace.
    expect(count(`SELECT COUNT(*) AS n FROM deleted_sessions`)).toBe(0);
    // The chat opened from it stays, and project files are untouched.
    expect(existsSync(join(projectDir, `${OTHER}.jsonl`))).toBe(true);

    // Claude Code writes a last record after stopping: deleted too, never indexed.
    copyFileSync(FIXTURE, join(projectDir, `${GHOST}.jsonl`));
    svc.refresh();
    expect(existsSync(join(projectDir, `${GHOST}.jsonl`))).toBe(false);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, GHOST)).toBe(0);

    // Once that's over, Companion forgets it ever existed.
    db.prepare(`UPDATE ghost_sessions SET ended_at = ?`).run(new Date(Date.now() - 10 * 60_000).toISOString());
    svc.refresh();
    expect(count(`SELECT COUNT(*) AS n FROM ghost_sessions`)).toBe(0);
    expect(readdirSync(projectDir)).toEqual([`${OTHER}.jsonl`]);
  });

  it('ending one from Companion deletes it', async () => {
    ghost(GHOST);
    live = [running(GHOST)];
    const svc = service();
    svc.refresh();
    live = [];
    await svc.stop(GHOST);
    expect(existsSync(join(projectDir, `${GHOST}.jsonl`))).toBe(false);
    expect(svc.listSessions({}).some((s) => s.id === GHOST)).toBe(false);
  });

  it("ended while Companion was closed: deleted when it starts", () => {
    ghost(GHOST);
    service(); // starting Companion
    expect(existsSync(join(projectDir, `${GHOST}.jsonl`))).toBe(false);
  });

  it('just started and not registered yet: left alone', () => {
    ghost(GHOST, 1000);
    const svc = service();
    svc.refresh();
    expect(existsSync(join(projectDir, `${GHOST}.jsonl`))).toBe(true);
  });
});
