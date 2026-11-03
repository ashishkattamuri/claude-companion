import type { ReviewFile, ReviewHunk } from './api.js';

export type Row = { kind: 'ctx' | 'add' | 'del'; old: number | null; new: number | null; text: string } | { kind: 'gap'; count: number | null };

/** Diff rows with numbered lines, and a gap row wherever unchanged lines are folded away. */
export function diffRows(f: Pick<ReviewFile, 'hunks' | 'oldLineCount' | 'partial'>): Row[] {
  const rows: Row[] = [];
  let prevEnd = 1; // first old line after the previous hunk
  f.hunks.forEach((h: ReviewHunk, i: number) => {
    // jsdiff (and so Claude Code) numbers a pure insertion by the old line it goes before.
    const gap = h.oldStart - prevEnd;
    if (f.partial ? i > 0 : gap > 0) rows.push({ kind: 'gap', count: f.partial ? null : gap });
    let o = h.oldStart || 1;
    let n = h.newStart || 1;
    for (const line of h.lines) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      const text = line.slice(1);
      if (line.startsWith('+')) rows.push({ kind: 'add', old: null, new: n++, text });
      else if (line.startsWith('-')) rows.push({ kind: 'del', old: o++, new: null, text });
      else rows.push({ kind: 'ctx', old: o++, new: n++, text });
    }
    prevEnd = o;
  });
  const tail = f.oldLineCount - prevEnd + 1;
  if (!f.partial && f.hunks.length && tail > 0) rows.push({ kind: 'gap', count: tail });
  return rows;
}
