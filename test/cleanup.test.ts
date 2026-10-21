import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/analyze/llm.js';
import { getRecap } from '../src/analyze/recap.js';
import { loadConfig, type Config } from '../src/config.js';
import type { LiveSession } from '../src/ingest/live.js';
import { CompanionService } from '../src/main/service.js';
import { openDb, type DB } from '../src/store/db.js';

const FIXTURE = new URL('./fixtures/basic.jsonl', import.meta.url);
const PARENT = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';

let root: string;
let projectDir: string;
let cfg: Config;
let db: DB;
let live: LiveSession[];

function service(): CompanionService {
  return new CompanionService({
    db,
    cfg,
    llm: {} as LlmClient,
    loadLive: () => live,
    env: () => ({}),
    analysis: false,
    notes: false,
  });
}

/** A copy of the fixture under another session id. */
function transcript(id: string): string {
  const path = join(projectDir, `${id}.jsonl`);
  copyFileSync(FIXTURE, path);
  return path;
}

const ids = (svc: CompanionService) => svc.listSessions({}).map((s) => s.id).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-cleanup-'));
  projectDir = join(root, 'claude', 'projects', '-work-demo-app');
  mkdirSync(projectDir, { recursive: true });
  const config = join(root, 'config.toml');
  writeFileSync(config, `[sources]\nclaude_dir = "${join(root, 'claude')}"\n[data]\ndir = "${join(root, 'data')}"\n`);
  cfg = loadConfig(config);
  db = openDb(cfg.dbPath);
  live = [];
  transcript(PARENT);
  transcript(CHILD);
  db.prepare(`INSERT INTO session_links(child_id, parent_id, title, kind, created_at) VALUES (?, ?, 'side chat', 'branch', ?)`).run(
    CHILD,
    PARENT,
    new Date().toISOString(),
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('hiding chats', () => {
  it('hides a chat and the chats opened from it, across restarts', () => {
    const svc = service();
    svc.refresh();
    svc.setHidden([PARENT], true);
    expect(svc.listSessions({}).filter((s) => s.hidden).map((s) => s.id).sort()).toEqual([PARENT, CHILD]);

    db.close();
    db = openDb(cfg.dbPath);
    const again = service();
    again.refresh();
    expect(again.listSessions({}).every((s) => s.hidden)).toBe(true);

    again.setHidden([PARENT], false);
    expect(again.listSessions({}).some((s) => s.hidden)).toBe(false);
    expect(existsSync(join(projectDir, `${PARENT}.jsonl`))).toBe(true);
  });
});

describe('deleting chats', () => {
  it('deletes several at once', async () => {
    const other = '33333333-3333-3333-3333-333333333333';
    transcript(other);
    const svc = service();
    svc.refresh();
    expect((await svc.deleteSessions([PARENT, other])).ok).toBe(true);
    svc.refresh();
    expect(ids(svc)).toEqual([CHILD]);
  });

  it("takes a deleted chat's action items out of the recaps, keeping the rest", async () => {
    const item = (text: string, session_id: string) => ({ text, why: 'w', priority: 'high', project: 'demo-app', session_id });
    const recap = (day: string, sessionIds: string[], body: object) =>
      db
        .prepare(
          `INSERT INTO recaps(day, window_start, window_end, session_ids, model, prompt_version, recap_json, created_at) VALUES (?, ?, ?, ?, 'sonnet', 1, ?, ?)`,
        )
        .run(day, `${day}T04:00:00Z`, `${day}T04:00:00Z`, JSON.stringify(sessionIds), JSON.stringify({ headline: 'h', blockers: [], ...body }), `${day}T08:00:00Z`);
    recap('2026-10-20', [PARENT, CHILD], {
      projects: [
        { project: 'demo-app', summary: 's', session_ids: [PARENT, CHILD] },
        { project: 'side-project', summary: 's', session_ids: [PARENT] },
        { project: 'acme/api', summary: 'GitHub only', session_ids: [] },
      ],
      action_items: [item('from the parent', PARENT), item('from the child', CHILD), item('review #12', '')],
    });
    recap('2026-10-21', [CHILD], { projects: [{ project: 'demo-app', summary: 's', session_ids: [CHILD] }], action_items: [item('child only', CHILD)] });
    const svc = service();
    svc.refresh();

    expect((await svc.deleteSessions([PARENT])).ok).toBe(true);
    svc.refresh();
    const day1 = getRecap(db, '2026-10-20')!;
    expect(day1.recap.action_items.map((a) => a.text)).toEqual(['from the child', 'review #12']);
    expect(day1.recap.projects.map((p) => [p.project, p.session_ids])).toEqual([
      ['demo-app', [CHILD]],
      ['acme/api', []],
    ]);
    expect(day1.sessionIds).toEqual([CHILD]);
    expect(day1.prunedAt).not.toBeNull();
    // A recap that never mentioned the chat is left as it was.
    expect(getRecap(db, '2026-10-21')!.prunedAt).toBeNull();
  });

  it('deletes the transcript and keeps it gone on the next scan; children move to the top level', async () => {
    const svc = service();
    svc.refresh();
    const path = join(projectDir, `${PARENT}.jsonl`);
    mkdirSync(join(projectDir, PARENT, 'subagents'), { recursive: true });

    expect(await svc.deleteSession(PARENT)).toEqual({ ok: true, value: undefined });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(projectDir, PARENT))).toBe(false);

    // A copy left behind somewhere (e.g. restored from a backup) is not picked up again.
    transcript(PARENT);
    svc.refresh();
    expect(ids(svc)).toEqual([CHILD]);
    expect(svc.listSessions({})[0]!.parentId).toBeNull();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`).get(PARENT) as { n: number }).n).toBe(0);
  });

  it('refuses while the chat runs in a plain terminal', async () => {
    const svc = service();
    svc.refresh();
    live = [{ sessionId: PARENT, kind: 'interactive', jobId: null } as unknown as LiveSession];
    const r = await svc.deleteSession(PARENT);
    expect(r.ok).toBe(false);
    expect(existsSync(join(projectDir, `${PARENT}.jsonl`))).toBe(true);
  });
});
