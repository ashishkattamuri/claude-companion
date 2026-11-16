import type { ChangeRef, ReviewFile } from './api.js';
import { hunkText } from './reviewRows.js';

type FileLike = Pick<ReviewFile, 'abs' | 'path' | 'hash' | 'hunks' | 'hunkKeys' | 'stepIds' | 'stepNotes'>;

/** A hunk or a whole file, frozen as it is now, to ask a side question about. */
export function changeRef(f: FileLike, hunk: number | null, request: string | null): ChangeRef {
  const h = hunk === null ? null : (f.hunks[hunk] ?? null);
  const note = [...f.stepNotes].reverse().find((n) => n) ?? null;
  return {
    abs: f.abs,
    path: f.path,
    hunk: h ? hunk : null,
    hunkKey: h ? (f.hunkKeys[hunk!] ?? null) : null,
    fileHash: f.hash,
    diff: h ? hunkText(h) : f.hunks.map(hunkText).join('\n'),
    from: h ? h.newStart || 1 : null,
    to: h ? Math.max(h.newStart || 1, (h.newStart || 1) + h.newLines - 1) : null,
    stepIds: f.stepIds,
    note,
    request,
    at: new Date().toISOString(),
  };
}

/** Whether the code a thread asked about has changed since: its hunk is gone, or the file's change differs. */
export function changeIsStale(c: ChangeRef, files: Pick<ReviewFile, 'abs' | 'hash' | 'hunkKeys'>[]): boolean {
  const f = files.find((x) => x.abs === c.abs);
  if (!f) return true;
  return c.hunkKey ? !f.hunkKeys.includes(c.hunkKey) : f.hash !== c.fileHash;
}

/** The hunk that best stands for the one a thread asked about, as the file is now: same change, else overlapping lines. */
export function matchingHunk(c: ChangeRef, f: Pick<ReviewFile, 'hunks' | 'hunkKeys'>): number | null {
  if (c.hunk === null) return null;
  const same = c.hunkKey ? f.hunkKeys.indexOf(c.hunkKey) : -1;
  if (same >= 0) return same;
  const i = f.hunks.findIndex((h) => c.from !== null && c.to !== null && h.newStart <= c.to && h.newStart + Math.max(h.newLines, 1) - 1 >= c.from);
  return i >= 0 ? i : null;
}
