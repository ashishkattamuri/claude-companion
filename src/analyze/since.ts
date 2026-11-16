import { collectChanges, hunkKey, type FileChange } from '../adapter/changes.js';
import { collectTrail, type TestRun, type TrailFailure, type TrailRequest } from '../adapter/trail.js';
import type { DB } from '../store/db.js';

/**
 * "Since you last looked": what a session did after your viewing checkpoint. The checkpoint is a
 * position in the transcript plus each changed file's net change and hunks at that point, so the
 * comparison is between stable snapshots, not timestamps. It moves only when you say you've caught
 * up; reading, scrolling or opening the chat never moves it. While you read, the view is frozen at
 * the position you opened it at (`upto`) and anything newer is counted separately as incoming.
 */

export interface Checkpoint {
  at: string;
  /** Transcript position (1-based count of non-empty lines) you had seen up to. */
  seq: number;
  /** The uuid of the record at that position, to find it again if lines move. */
  lastId: string | null;
  files: Record<string, { hash: string; keys: string[] }>;
}

export interface SinceFile {
  abs: string;
  /** new: first changed since; changed: changed again; reverted: its net change is gone. */
  change: 'new' | 'changed' | 'reverted';
  added: number;
  removed: number;
  /** Indices of the current hunks that weren't there at the checkpoint. */
  newHunks: number[];
  /** The file's earlier content wasn't recorded, so hunks can't be matched: all count as new. */
  partial: boolean;
  /** The steps since the checkpoint that edited it, with what Claude said just before each. */
  steps: { id: string; ts: string; note: string | null }[];
}

export interface SinceData {
  /** none: first look; ok: compared with your checkpoint; lost: the checkpoint's place in the transcript is gone. */
  baseline: 'none' | 'ok' | 'lost';
  checkpointAt: string | null;
  /** The position the view is frozen at, and the latest position in the transcript. */
  upto: number;
  latest: number;
  /** Edits and test runs after `upto`, not shown until you ask. */
  incoming: { edits: number; tests: number; requests: number };
  files: SinceFile[];
  requests: TrailRequest[];
  tests: (TestRun & { editedAfter: string[] })[];
  /** Tests that passed before the checkpoint, for files edited since: their evidence no longer holds. */
  staleTests: (TestRun & { files: string[] })[];
  failures: TrailFailure[];
  /** Edits since the checkpoint, oldest first. */
  edits: { stepId: string; ts: string; abs: string }[];
}

export function readCheckpoint(db: DB, sessionId: string): Checkpoint | null {
  const row = db.prepare(`SELECT at, seq, last_id, files_json FROM review_checkpoints WHERE session_id = ?`).get(sessionId) as
    | { at: string; seq: number; last_id: string | null; files_json: string }
    | undefined;
  if (!row) return null;
  try {
    return { at: row.at, seq: row.seq, lastId: row.last_id, files: JSON.parse(row.files_json) };
  } catch {
    return null;
  }
}

/** Sets the checkpoint at `upto`: what you've seen is the transcript up to there. */
export function saveCheckpoint(db: DB, sessionId: string, lines: string[], upto: number, readFile?: (abs: string) => string | null): Checkpoint {
  const cut = lines.slice(0, Math.min(upto, lines.length));
  const files: Checkpoint['files'] = {};
  for (const f of collectChanges(cut, readFile)) files[f.abs] = { hash: f.hash, keys: f.hunks.map(hunkKey) };
  const cp: Checkpoint = { at: new Date().toISOString(), seq: cut.length, lastId: uuidAt(cut, cut.length), files };
  db.prepare(`INSERT OR REPLACE INTO review_checkpoints(session_id, at, seq, last_id, files_json) VALUES (?, ?, ?, ?, ?)`).run(
    sessionId,
    cp.at,
    cp.seq,
    cp.lastId,
    JSON.stringify(files),
  );
  return cp;
}

export function sinceLastLook(lines: string[], cp: Checkpoint | null, upto: number | null, readFile?: (abs: string) => string | null): SinceData {
  const latest = lines.length;
  const end = Math.max(0, Math.min(upto ?? latest, latest));
  const cut = lines.slice(0, end);
  let baseline: SinceData['baseline'] = cp ? 'ok' : 'none';
  let from = 0;
  if (cp) {
    from = locate(lines, cp);
    if (from < 0) {
      baseline = 'lost';
      from = 0;
    }
  }
  const trail = collectTrail(cut);
  const files = collectChanges(cut, readFile);
  const prev = baseline === 'ok' ? cp!.files : {};
  const editsSince = trail.edits.filter((e) => e.seq > from);
  const edited = new Set(editsSince.map((e) => e.abs));

  const out: SinceFile[] = [];
  for (const f of files) {
    const before = prev[f.abs];
    if (before && before.hash === f.hash && !edited.has(f.abs)) continue;
    if (!before && !edited.has(f.abs)) continue;
    const keys = new Set(before?.keys ?? []);
    const partial = f.before === null;
    out.push({
      abs: f.abs,
      change: before ? 'changed' : 'new',
      added: f.added,
      removed: f.removed,
      newHunks: f.hunks.flatMap((h, i) => (partial || !keys.has(hunkKey(h)) ? [i] : [])),
      partial,
      steps: stepsSince(f, editsSince),
    });
  }
  // A file changed at the checkpoint whose net change is now gone: edited back to how it was.
  for (const abs of Object.keys(prev)) {
    if (files.some((f) => f.abs === abs) || !edited.has(abs)) continue;
    out.push({ abs, change: 'reverted', added: 0, removed: 0, newHunks: [], partial: false, steps: editsSince.filter((e) => e.abs === abs).map((e) => ({ id: e.stepId, ts: e.ts, note: null })) });
  }

  const lastEdit = new Map<string, number>();
  for (const e of trail.edits) lastEdit.set(e.abs, e.seq);
  const tests = trail.tests.filter((t) => t.seq > from).map((t) => ({ ...t, editedAfter: [...lastEdit].filter(([, s]) => s > t.seq).map(([abs]) => abs) }));
  // The latest passing run before the checkpoint, if files it preceded were edited since.
  const before = trail.tests.filter((t) => t.seq <= from && t.outcome === 'passed').at(-1);
  const staleTests = before && edited.size && baseline === 'ok' ? [{ ...before, files: [...edited] }] : [];

  const full = end < latest ? collectTrail(lines) : null;
  return {
    baseline,
    checkpointAt: baseline === 'ok' ? cp!.at : null,
    upto: end,
    latest,
    incoming: {
      edits: full ? full.edits.filter((e) => e.seq > end).length : 0,
      tests: full ? full.tests.filter((t) => t.seq > end).length : 0,
      requests: full ? full.requests.filter((r) => r.seq > end).length : 0,
    },
    files: out,
    requests: trail.requests.filter((r) => r.seq > from),
    tests,
    staleTests,
    failures: trail.failures.filter((f) => f.seq > from),
    edits: editsSince.map((e) => ({ stepId: e.stepId, ts: e.ts, abs: e.abs })),
  };
}

/** Where the checkpoint is in the transcript now: its position if the record there is still the same, else wherever that record moved. */
function locate(lines: string[], cp: Checkpoint): number {
  if (cp.seq === 0) return 0;
  if (!cp.lastId || uuidAt(lines, cp.seq) === cp.lastId) return cp.seq <= lines.length ? cp.seq : -1;
  for (let i = lines.length; i > 0; i--) if (uuidAt(lines, i) === cp.lastId) return i;
  return -1;
}

function uuidAt(lines: string[], seq: number): string | null {
  const line = lines[seq - 1];
  if (!line) return null;
  try {
    const rec = JSON.parse(line);
    return typeof rec?.uuid === 'string' ? rec.uuid : null;
  } catch {
    return null;
  }
}

function stepsSince(f: FileChange, edits: { stepId: string }[]): SinceFile['steps'] {
  const ids = new Set(edits.map((e) => e.stepId));
  return f.stepIds.flatMap((id, i) => (ids.has(id) ? [{ id, ts: f.stepTs[i] ?? '', note: f.stepNotes[i] ?? null }] : []));
}
