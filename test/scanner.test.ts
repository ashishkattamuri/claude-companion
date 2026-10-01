import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { scan } from '../src/ingest/scanner.js';
import { openDb, type DB } from '../src/store/db.js';

const FIXTURE = new URL('./fixtures/basic.jsonl', import.meta.url);
const SESSION = '11111111-1111-1111-1111-111111111111';

let root: string;
let db: DB;
let transcript: string;

function config(optOut: string[] = []): Config {
  const path = join(root, 'config.toml');
  writeFileSync(
    path,
    `[sources]\nclaude_dir = "${join(root, 'claude')}"\nopt_out = ${JSON.stringify(optOut)}\n`,
  );
  return loadConfig(path);
}

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-test-'));
  const projectDir = join(root, 'claude', 'projects', '-work-demo-app');
  mkdirSync(join(projectDir, SESSION, 'subagents'), { recursive: true });
  transcript = join(projectDir, `${SESSION}.jsonl`);
  copyFileSync(FIXTURE, transcript);
  writeFileSync(join(projectDir, SESSION, 'subagents', 'agent-1.jsonl'), '');
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('scan', () => {
  it('ingests a transcript into sessions, projects and messages', () => {
    const r = scan(db, config());
    expect(r).toMatchObject({ filesSeen: 1, filesChanged: 1, subagentFiles: 1, invalidLines: 1 });
    expect(r.unknownTypes).toEqual({ 'brand-new-record-type': 1 });

    const s = db.prepare(`SELECT * FROM sessions`).get() as Record<string, unknown>;
    expect(s).toMatchObject({
      id: SESSION,
      cwd: '/work/demo-app',
      git_branch: 'feat/retry',
      name: 'demo-retry',
      title: 'Webhook retry logic',
      last_prompt: 'Also add a test for exponential backoff',
      first_ts: '2026-09-30T09:00:00.000Z',
      last_ts: '2026-09-30T09:05:00.000Z',
      msg_count: 8,
      user_prompt_count: 2,
      cc_version: '2.1.286',
      cost_usd: 0.42,
    });
    expect(count(`SELECT COUNT(*) n FROM projects WHERE name = 'demo-app'`)).toBe(1);
  });

  it('is idempotent: a second scan adds nothing', () => {
    scan(db, config());
    const before = count(`SELECT COUNT(*) n FROM messages`);
    const r = scan(db, config());
    expect(r.filesChanged).toBe(0);
    expect(r.messagesAdded).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM messages`)).toBe(before);
  });

  it('reads only appended lines and waits for a partial line to complete', () => {
    scan(db, config());
    const prompt = (uuid: string) =>
      JSON.stringify({
        type: 'user', uuid, sessionId: SESSION, timestamp: '2026-09-30T10:00:00.000Z',
        cwd: '/work/demo-app', message: { role: 'user', content: `prompt ${uuid}` },
      });
    const line = prompt('u6');
    appendFileSync(transcript, line.slice(0, 20));
    expect(scan(db, config()).messagesAdded).toBe(0);
    appendFileSync(transcript, `${line.slice(20)}\n`);
    expect(scan(db, config()).messagesAdded).toBe(1);
    expect(count(`SELECT user_prompt_count n FROM sessions`)).toBe(3);
  });

  it('keeps history after Claude Code deletes the transcript', () => {
    scan(db, config());
    rmSync(transcript);
    expect(scan(db, config()).sessionsGone).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM sessions WHERE transcript_gone = 1`)).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM messages`)).toBe(8);
  });

  it('never stores opted-out projects, and purges them when the list changes', () => {
    expect(scan(db, config(['/work/demo-*'])).filesOptedOut).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM sessions`)).toBe(0);

    const db2 = openDb(':memory:');
    try {
      scan(db2, config());
      expect((db2.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number }).n).toBe(1);
      appendFileSync(transcript, '\n'); // touch so the file counts as changed
      scan(db2, config(['/work/demo-app']));
      expect((db2.prepare(`SELECT COUNT(*) n FROM messages`).get() as { n: number }).n).toBe(0);
    } finally {
      db2.close();
    }
  });

  it('indexes prompts and assistant text for full-text search', () => {
    scan(db, config());
    const hits = db
      .prepare(`SELECT m.kind FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH 'backoff'`)
      .all();
    expect(hits).toEqual([{ kind: 'prompt' }]);
  });

  it('re-reads a file that was rewritten shorter', () => {
    scan(db, config());
    const { size } = statSync(transcript);
    writeFileSync(transcript, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Rewritten', sessionId: SESSION })}\n`);
    expect(statSync(transcript).size).toBeLessThan(size);
    scan(db, config());
    expect((db.prepare(`SELECT title FROM sessions`).get() as { title: string }).title).toBe('Rewritten');
  });
});
