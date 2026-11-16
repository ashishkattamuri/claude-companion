import { structuredPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { hunkKey } from '../src/adapter/changes.js';
import { changeQuestion } from '../src/main/side-chat.js';
import { changeIsStale, changeRef, matchingHunk } from '../src/shared/changeRef.js';

const v0 = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
const file = (after: string, extra: Partial<{ stepIds: string[]; stepNotes: (string | null)[] }> = {}) => {
  const hunks = structuredPatch('f', 'f', v0, after, '', '', { context: 2 }).hunks.map((h) => ({ ...h }));
  return {
    abs: '/p/a.ts',
    path: 'a.ts',
    hash: after,
    hunks,
    hunkKeys: hunks.map(hunkKey),
    stepIds: extra.stepIds ?? ['s1'],
    stepNotes: extra.stepNotes ?? ['Renaming line two.'],
  };
};

describe('asking about a change', () => {
  const v1 = v0.replace('line 2\n', 'line two\n').replace('line 25\n', 'line twenty-five\n');

  it('freezes the exact hunk, where it is, and the edit that made it', () => {
    const c = changeRef(file(v1), 1, 'Rename lines');
    expect(c).toMatchObject({ abs: '/p/a.ts', path: 'a.ts', hunk: 1, from: 24, to: 28, stepIds: ['s1'], note: 'Renaming line two.', request: 'Rename lines' });
    expect(c.diff).toContain('-line 25');
    expect(c.diff).toContain('+line twenty-five');
    expect(c.diff).not.toContain('line two');
    const whole = changeRef(file(v1), null, null);
    expect(whole).toMatchObject({ hunk: null, hunkKey: null, from: null });
    expect(whole.diff).toContain('line two');
  });

  it('is stale once the hunk changes, but not when another hunk does', () => {
    const c = changeRef(file(v1), 1, null);
    expect(changeIsStale(c, [file(v1)])).toBe(false);
    expect(changeIsStale(c, [file(v1.replace('line two', 'line 2b'))])).toBe(false);
    expect(changeIsStale(c, [file(v1.replace('line twenty-five', 'line 25!'))])).toBe(true);
    expect(changeIsStale(c, [])).toBe(true);
    const whole = changeRef(file(v1), null, null);
    expect(changeIsStale(whole, [file(v1.replace('line two', 'line 2b'))])).toBe(true);
  });

  it('finds the same hunk in the latest code, or the one over the same lines', () => {
    const c = changeRef(file(v1), 1, null);
    const later = file(v1.replace('line twenty-five', 'line 25!'));
    expect(matchingHunk(c, later)).toBe(1);
    expect(matchingHunk(c, file(v0.replace('line 2\n', 'line two\n')))).toBeNull();
  });

  it('asks with the frozen diff, keeps rationale apart from inference, and stays read-only', () => {
    const q = changeQuestion(changeRef(file(v1), 1, null), 'Which callers could break?');
    expect(q).toContain('<diff path="a.ts">');
    expect(q).toContain('+line twenty-five');
    expect(q).toContain('lines 24–28');
    expect(q).toContain('"Inferred:"');
    expect(q).toContain("don't change any files");
    expect(q).toContain('unless the conversation shows a test run');
    expect(q.trim().split('\n').at(-1)).toBe('Which callers could break?');
  });
});
