import { hunkKey, type FileChange } from '../adapter/changes.js';
import type { ReviewFile } from '../shared/api.js';
import type { DB } from '../store/db.js';

/**
 * Your explicit review marks, kept apart from merely having looked: a file marked reviewed remembers
 * which hunks you reviewed, so when Claude edits it again only the hunks that changed need another
 * look. Nothing here is ever set by opening or scrolling.
 */

export type MarkKind = 'reviewed' | 'understood';

interface Mark {
  keys: string[];
  at: string;
}

export function readMarks(db: DB, sessionId: string, kind: MarkKind): Map<string, Mark> {
  const rows = db.prepare(`SELECT target, keys_json, at FROM review_marks WHERE session_id = ? AND kind = ?`).all(sessionId, kind) as {
    target: string;
    keys_json: string;
    at: string;
  }[];
  const out = new Map<string, Mark>();
  for (const r of rows) {
    try {
      out.set(r.target, { keys: JSON.parse(r.keys_json) as string[], at: r.at });
    } catch {
      /* a broken row reads as no mark */
    }
  }
  return out;
}

export function setMark(db: DB, sessionId: string, kind: MarkKind, target: string, keys: string[] | null): void {
  if (keys === null) {
    db.prepare(`DELETE FROM review_marks WHERE session_id = ? AND kind = ? AND target = ?`).run(sessionId, kind, target);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO review_marks(session_id, kind, target, keys_json, at) VALUES (?, ?, ?, ?, ?)`).run(
    sessionId,
    kind,
    target,
    JSON.stringify(keys),
    new Date().toISOString(),
  );
}

export const fileKeys = (f: Pick<FileChange, 'hunks'>): string[] => f.hunks.map(hunkKey);

/**
 * Where your review of a file stands. A hunk is still reviewed when the same change (same removed and
 * added lines) is in the file now. When the file's earlier content wasn't recorded the hunks are its
 * edits one by one and can't be matched reliably, so any change means the whole file needs a look.
 */
export function fileReview(f: Pick<FileChange, 'hunks' | 'before'>, mark: Mark | undefined): ReviewFile['review'] {
  if (!mark) return { state: 'unreviewed', at: null, changedHunks: [] };
  const seen = new Set(mark.keys);
  const keys = fileKeys(f);
  const changed = keys.flatMap((k, i) => (seen.has(k) ? [] : [i]));
  if (!changed.length) return { state: 'reviewed', at: mark.at, changedHunks: [] };
  if (f.before === null) return { state: 'changed', at: mark.at, changedHunks: keys.map((_, i) => i) };
  return { state: 'changed', at: mark.at, changedHunks: changed };
}
