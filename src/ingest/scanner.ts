import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeLine, type MessageEvent } from '../adapter/normalize.js';
import type { Config } from '../config.js';
import type { DB } from '../store/db.js';

export interface ScanResult {
  filesSeen: number;
  filesChanged: number;
  filesOptedOut: number;
  subagentFiles: number;
  messagesAdded: number;
  sessionsGone: number;
  invalidLines: number;
  unknownTypes: Record<string, number>;
}

interface FileRow {
  size: number;
  mtime_ms: number;
  offset: number;
  opted_out: number;
}

/** Main session transcripts: `<projectsDir>/<encoded-cwd>/<sessionId>.jsonl`. */
export function listTranscripts(projectsDir: string): { main: string[]; subagentCount: number } {
  const main: string[] = [];
  let subagentCount = 0;
  if (!existsSync(projectsDir)) return { main, subagentCount };
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(projectsDir, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) main.push(join(dir, entry.name));
      else if (entry.isDirectory()) {
        // Subagent transcripts live in `<sessionId>/subagents/`; not ingested yet, only counted.
        const sub = join(dir, entry.name, 'subagents');
        if (existsSync(sub)) subagentCount += readdirSync(sub).filter((f) => f.endsWith('.jsonl')).length;
      }
    }
  }
  return { main, subagentCount };
}

export function scan(db: DB, cfg: Config): ScanResult {
  const result: ScanResult = {
    filesSeen: 0,
    filesChanged: 0,
    filesOptedOut: 0,
    subagentFiles: 0,
    messagesAdded: 0,
    sessionsGone: 0,
    invalidLines: 0,
    unknownTypes: {},
  };
  purgeOptedOut(db, cfg);

  const { main, subagentCount } = listTranscripts(cfg.projectsDir);
  result.subagentFiles = subagentCount;
  const ingester = new FileIngester(db, cfg, result);
  for (const path of main) {
    result.filesSeen++;
    ingester.ingest(path);
  }

  result.sessionsGone = markGoneTranscripts(db);
  recordUnknownTypes(db, result.unknownTypes);
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('last_scan', ?)`).run(new Date().toISOString());
  return result;
}

class FileIngester {
  private getFile;
  private upsertFile;
  private getSessionCwd;
  private upsertProject;
  private upsertSession;
  private insertMessage;
  private setTitle;
  private setLastPrompt;
  private setName;
  private setCost;
  private refreshAggregates;

  constructor(
    private db: DB,
    private cfg: Config,
    private result: ScanResult,
  ) {
    this.getFile = db.prepare<[string], FileRow>(
      `SELECT size, mtime_ms, offset, opted_out FROM ingest_files WHERE path = ?`,
    );
    this.upsertFile = db.prepare(
      `INSERT INTO ingest_files(path, session_id, size, mtime_ms, offset, opted_out)
       VALUES (@path, @sessionId, @size, @mtimeMs, @offset, @optedOut)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         offset = excluded.offset, opted_out = excluded.opted_out`,
    );
    this.getSessionCwd = db.prepare<[string], { cwd: string | null }>(`SELECT cwd FROM sessions WHERE id = ?`);
    this.upsertProject = db.prepare<[string, string], { id: number }>(
      `INSERT INTO projects(cwd, name) VALUES (?, ?)
       ON CONFLICT(cwd) DO UPDATE SET name = name RETURNING id`,
    );
    this.upsertSession = db.prepare(
      `INSERT INTO sessions(id, project_id, cwd, git_branch, cc_version, source_path, transcript_gone)
       VALUES (@id, @projectId, @cwd, @gitBranch, @version, @path, 0)
       ON CONFLICT(id) DO UPDATE SET
         project_id  = COALESCE(excluded.project_id, project_id),
         cwd         = COALESCE(excluded.cwd, cwd),
         git_branch  = COALESCE(excluded.git_branch, git_branch),
         cc_version  = COALESCE(excluded.cc_version, cc_version),
         source_path = excluded.source_path,
         transcript_gone = 0`,
    );
    this.insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages(uuid, session_id, parent_uuid, ts, role, kind, tool_name, text, is_sidechain)
       VALUES (@uuid, @sessionId, @parentUuid, @ts, @role, @messageKind, @toolName, @text, @isSidechain)`,
    );
    this.setTitle = db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`);
    this.setLastPrompt = db.prepare(`UPDATE sessions SET last_prompt = ? WHERE id = ?`);
    this.setName = db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`);
    this.setCost = db.prepare(`UPDATE sessions SET cost_usd = ? WHERE id = ?`);
    this.refreshAggregates = db.prepare(
      `UPDATE sessions SET
         first_ts = (SELECT MIN(ts) FROM messages WHERE session_id = @id),
         last_ts  = (SELECT MAX(ts) FROM messages WHERE session_id = @id),
         msg_count = (SELECT COUNT(*) FROM messages WHERE session_id = @id),
         user_prompt_count = (SELECT COUNT(*) FROM messages
                              WHERE session_id = @id AND kind = 'prompt' AND is_sidechain = 0)
       WHERE id = @id`,
    );
  }

  ingest(path: string): void {
    const { size, mtimeMs } = statSync(path);
    const mtime = Math.floor(mtimeMs);
    const sessionId = basename(path, '.jsonl');
    const prev = this.getFile.get(path);
    if (prev && prev.size === size && prev.mtime_ms === mtime) return;

    const fileRow = { path, sessionId, size, mtimeMs: mtime, offset: prev?.offset ?? 0, optedOut: 0 };
    if (prev?.opted_out) {
      this.result.filesOptedOut++;
      this.upsertFile.run({ ...fileRow, optedOut: 1 });
      return;
    }
    // A file that shrank was rewritten; re-read it. Inserts are idempotent, so that's safe.
    const start = prev && size >= prev.offset ? prev.offset : 0;
    const { lines, consumed } = readCompleteLines(path, start, size);
    this.result.filesChanged++;

    const events = lines.map(normalizeLine);
    const messages = events.filter((e): e is MessageEvent => e.kind === 'message');
    const cwd = messages.find((m) => m.cwd)?.cwd ?? this.getSessionCwd.get(sessionId)?.cwd ?? null;
    if (cwd && this.cfg.isOptedOut(cwd)) {
      this.result.filesOptedOut++;
      this.upsertFile.run({ ...fileRow, offset: start + consumed, optedOut: 1 });
      return;
    }

    const lastWith = <K extends 'cwd' | 'gitBranch' | 'version'>(k: K) => messages.findLast((m) => m[k])?.[k] ?? null;

    this.db.transaction(() => {
      const projectId = cwd ? this.upsertProject.get(cwd, basename(cwd))!.id : null;
      this.upsertSession.run({
        id: sessionId,
        projectId,
        cwd,
        gitBranch: lastWith('gitBranch'),
        version: lastWith('version'),
        path,
      });
      for (const e of events) {
        switch (e.kind) {
          case 'message':
            this.result.messagesAdded += this.insertMessage.run({
              ...e,
              sessionId,
              isSidechain: e.isSidechain ? 1 : 0,
            }).changes;
            break;
          case 'title':
            this.setTitle.run(e.title, sessionId);
            break;
          case 'last_prompt':
            this.setLastPrompt.run(e.text, sessionId);
            break;
          case 'name':
            this.setName.run(e.name, sessionId);
            break;
          case 'cost':
            this.setCost.run(e.totalCostUsd, sessionId);
            break;
          case 'unknown':
            this.result.unknownTypes[e.type] = (this.result.unknownTypes[e.type] ?? 0) + 1;
            break;
          case 'invalid':
            this.result.invalidLines++;
            break;
        }
      }
      this.refreshAggregates.run({ id: sessionId });
      this.upsertFile.run({ ...fileRow, offset: start + consumed });
    })();
  }
}

/** Reads `[start, end)` and returns only newline-terminated lines, so a half-written last line is retried next scan. */
export function readCompleteLines(path: string, start: number, end: number): { lines: string[]; consumed: number } {
  const length = end - start;
  if (length <= 0) return { lines: [], consumed: 0 };
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], consumed: 0 };
  const lines = buf
    .subarray(0, lastNewline)
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim());
  return { lines, consumed: lastNewline + 1 };
}

/** Applies opt-out list changes to data already ingested. */
function purgeOptedOut(db: DB, cfg: Config): void {
  const sessions = db.prepare<[], { id: string; cwd: string }>(`SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL`).all();
  const doomed = sessions.filter((s) => cfg.isOptedOut(s.cwd));
  if (!doomed.length) return;
  const del = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const markFile = db.prepare(`UPDATE ingest_files SET opted_out = 1 WHERE session_id = ?`);
  db.transaction(() => {
    for (const s of doomed) {
      del.run(s.id);
      markFile.run(s.id);
    }
  })();
}

function markGoneTranscripts(db: DB): number {
  const rows = db
    .prepare<[], { id: string; source_path: string }>(
      `SELECT id, source_path FROM sessions WHERE transcript_gone = 0 AND source_path IS NOT NULL`,
    )
    .all();
  const mark = db.prepare(`UPDATE sessions SET transcript_gone = 1 WHERE id = ?`);
  let gone = 0;
  for (const r of rows) {
    if (!existsSync(r.source_path)) {
      mark.run(r.id);
      gone++;
    }
  }
  return gone;
}

function recordUnknownTypes(db: DB, found: Record<string, number>): void {
  if (!Object.keys(found).length) return;
  const row = db.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key = 'unknown_record_types'`).get();
  const totals: Record<string, number> = row ? JSON.parse(row.value) : {};
  for (const [type, n] of Object.entries(found)) totals[type] = (totals[type] ?? 0) + n;
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('unknown_record_types', ?)`).run(JSON.stringify(totals));
}
