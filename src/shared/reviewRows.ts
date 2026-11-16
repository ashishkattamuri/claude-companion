import type { ReviewFile, ReviewHunk } from './api.js';

export type Row =
  | { kind: 'ctx' | 'add' | 'del'; old: number | null; new: number | null; text: string; hunk: number }
  | { kind: 'gap'; count: number | null }
  /** Where a hunk starts: its index, and the lines it spans in the file after the change. */
  | { kind: 'hunk'; hunk: number; from: number; to: number };

/** Diff rows with numbered lines, a header where each hunk starts, and a gap row wherever unchanged lines are folded away. */
export function diffRows(f: Pick<ReviewFile, 'hunks' | 'oldLineCount' | 'partial'>, opts: { headers?: boolean } = {}): Row[] {
  const rows: Row[] = [];
  let prevEnd = 1; // first old line after the previous hunk
  f.hunks.forEach((h: ReviewHunk, i: number) => {
    // jsdiff (and so Claude Code) numbers a pure insertion by the old line it goes before.
    const gap = h.oldStart - prevEnd;
    if (f.partial ? i > 0 : gap > 0) rows.push({ kind: 'gap', count: f.partial ? null : gap });
    if (opts.headers) rows.push({ kind: 'hunk', hunk: i, from: h.newStart || 1, to: Math.max(h.newStart || 1, (h.newStart || 1) + h.newLines - 1) });
    let o = h.oldStart || 1;
    let n = h.newStart || 1;
    for (const line of h.lines) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      const text = line.slice(1);
      if (line.startsWith('+')) rows.push({ kind: 'add', old: null, new: n++, text, hunk: i });
      else if (line.startsWith('-')) rows.push({ kind: 'del', old: o++, new: null, text, hunk: i });
      else rows.push({ kind: 'ctx', old: o++, new: n++, text, hunk: i });
    }
    prevEnd = o;
  });
  const tail = f.oldLineCount - prevEnd + 1;
  if (!f.partial && f.hunks.length && tail > 0) rows.push({ kind: 'gap', count: tail });
  return rows;
}

/** A hunk as unified-diff text, e.g. to quote it in a question about it. */
export function hunkText(h: ReviewHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`;
}
