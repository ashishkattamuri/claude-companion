import { structuredPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { diffRows } from '../src/shared/reviewRows.js';

const file = (before: string, after: string) => ({
  hunks: structuredPatch('f', 'f', before, after, '', '', { context: 1 }).hunks,
  oldLineCount: before ? before.split('\n').length - (before.endsWith('\n') ? 1 : 0) : 0,
  partial: false,
});
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('diffRows', () => {
  it('numbers old and new lines and folds the unchanged ones around and between hunks', () => {
    const before = lines(20);
    const after = before.replace('line 5\n', 'line five\n').replace('line 15\n', 'line 15\nline 15b\n');
    const rows = diffRows(file(before, after));
    expect(rows[0]).toEqual({ kind: 'gap', count: 3 }); // lines 1–3
    expect(rows).toContainEqual({ kind: 'del', old: 5, new: null, text: 'line 5' });
    expect(rows).toContainEqual({ kind: 'add', old: null, new: 5, text: 'line five' });
    expect(rows).toContainEqual({ kind: 'add', old: null, new: 16, text: 'line 15b' });
    expect(rows.filter((r) => r.kind === 'gap')).toEqual([
      { kind: 'gap', count: 3 },
      { kind: 'gap', count: 8 }, // lines 7–14
      { kind: 'gap', count: 4 }, // lines 17–20
    ]);
  });

  it('shows a new file with no gaps', () => {
    const rows = diffRows(file('', 'a\nb\n'));
    expect(rows).toEqual([
      { kind: 'add', old: null, new: 1, text: 'a' },
      { kind: 'add', old: null, new: 2, text: 'b' },
    ]);
  });

  it("separates a partial file's edits without claiming how many lines are between them", () => {
    const hunks = [
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-a', '+b'] },
      { oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, lines: ['-c', '+d'] },
    ];
    const gaps = diffRows({ hunks, oldLineCount: 0, partial: true }).filter((r) => r.kind === 'gap');
    expect(gaps).toEqual([{ kind: 'gap', count: null }]);
  });
});
