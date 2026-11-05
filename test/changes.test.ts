import { structuredPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { applyHunks, collectChanges } from '../src/adapter/changes.js';

/** Builds transcript lines the way Claude Code writes them: a tool_use, then its tool_result with toolUseResult. */
function transcript() {
  const lines: string[] = [];
  let n = 0;
  const push = (rec: object) => lines.push(JSON.stringify({ uuid: `u${++n}`, timestamp: '2026-11-02T10:00:00Z', ...rec }));
  const user = (text: string) => push({ type: 'user', message: { role: 'user', content: text } });
  const say = (text: string) => push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const tool = (id: string, name: string, input: object, result: object, isError = false) => {
    push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const uuid = `u${n}`;
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] }, toolUseResult: result });
    return uuid;
  };
  const patch = (a: string, b: string) => structuredPatch('f', 'f', a, b, '', '', { context: 4 }).hunks;
  return { lines, user, say, tool, patch };
}

const ORIGINAL = ['export function retry(fn) {', '  return fn();', '}', '', 'export const LIMIT = 3;', ''].join('\n');

describe('collectChanges', () => {
  it("gives each file's net change over the session, with the steps and the why", () => {
    const t = transcript();
    t.user('Add backoff to retry and raise the limit');
    t.say('I will add exponential backoff.');
    const v1 = ORIGINAL.replace('  return fn();', '  return withBackoff(fn);');
    const e1 = t.tool('t1', 'Edit', { file_path: '/p/retry.ts' }, {
      filePath: '/p/retry.ts', oldString: '  return fn();', newString: '  return withBackoff(fn);', originalFile: ORIGINAL, replaceAll: false, structuredPatch: t.patch(ORIGINAL, v1),
    });
    const v2 = v1.replace('LIMIT = 3', 'LIMIT = 5');
    const e2 = t.tool('t2', 'Edit', { file_path: '/p/retry.ts' }, {
      filePath: '/p/retry.ts', oldString: 'LIMIT = 3', newString: 'LIMIT = 5', originalFile: v1, replaceAll: false, structuredPatch: t.patch(v1, v2),
    });
    const w = t.tool('t3', 'Write', { file_path: '/p/backoff.ts' }, {
      type: 'create', filePath: '/p/backoff.ts', content: 'export const withBackoff = (fn) => fn();\n', originalFile: null, structuredPatch: [],
    });
    t.tool('t4', 'Edit', { file_path: '/p/other.ts' }, { filePath: '/p/other.ts' }, true); // failed: not a change

    const [retry, backoff, ...rest] = collectChanges(t.lines);
    expect(rest).toEqual([]);
    expect(retry).toMatchObject({ abs: '/p/retry.ts', isNew: false, before: ORIGINAL, after: v2, added: 2, removed: 2, stepIds: [e1, e2] });
    expect(retry!.requests).toEqual(['Add backoff to retry and raise the limit']);
    expect(retry!.remarks).toEqual(['I will add exponential backoff.']);
    expect(retry!.stepNotes).toEqual(['I will add exponential backoff.', 'I will add exponential backoff.']);
    expect(retry!.hunks.flatMap((h) => h.lines)).toEqual(expect.arrayContaining(['-  return fn();', '+  return withBackoff(fn);', '-export const LIMIT = 3;', '+export const LIMIT = 5;']));
    expect(backoff).toMatchObject({ abs: '/p/backoff.ts', isNew: true, before: '', added: 1, removed: 0, oldLineCount: 0, stepIds: [w] });
  });

  it("falls back to the session's own edits when the file's content wasn't recorded", () => {
    const t = transcript();
    t.tool('t1', 'Edit', { file_path: '/p/big.ts' }, {
      filePath: '/p/big.ts', oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-a', '+b'] }],
    });
    const [big] = collectChanges(t.lines);
    expect(big).toMatchObject({ before: null, after: null, added: 1, removed: 1 });
    expect(big!.hunks[0]!.oldStart).toBe(10);
  });

  it("rebuilds the content before from the file on disk when Claude Code didn't record it", () => {
    const t = transcript();
    const v1 = ORIGINAL.replace('  return fn();', '  return withBackoff(fn);');
    const v2 = v1.replace('LIMIT = 3', 'LIMIT = 5');
    // Claude Code leaves originalFile out for files Claude hadn't read in full.
    t.tool('t1', 'Edit', { file_path: '/p/r.ts' }, { filePath: '/p/r.ts', oldString: '  return fn();', newString: '  return withBackoff(fn);', originalFile: null, structuredPatch: t.patch(ORIGINAL, v1), contentNotInModelContext: true });
    t.tool('t2', 'Edit', { file_path: '/p/r.ts' }, { filePath: '/p/r.ts', oldString: 'LIMIT = 3', newString: 'LIMIT = 5', originalFile: null, structuredPatch: t.patch(v1, v2), contentNotInModelContext: true });
    const [r] = collectChanges(t.lines, () => v2);
    expect(r).toMatchObject({ before: ORIGINAL, after: v2, added: 2, removed: 2 });
    // …and keeps the edits one by one when the file on disk doesn't fit them any more.
    const [moved] = collectChanges(t.lines, () => 'rewritten since\n');
    expect(moved).toMatchObject({ before: null, added: 2, removed: 2 });
  });

  it('gives the same change the same hash, and a different change a different one', () => {
    const run = (to: string) => {
      const t = transcript();
      t.tool('t1', 'Edit', { file_path: '/p/x.ts' }, { filePath: '/p/x.ts', oldString: 'LIMIT = 3', newString: to, originalFile: ORIGINAL, structuredPatch: [] });
      return collectChanges(t.lines)[0]!.hash;
    };
    expect(run('LIMIT = 5')).toBe(run('LIMIT = 5'));
    expect(run('LIMIT = 5')).not.toBe(run('LIMIT = 6'));
  });
});

describe('applyHunks', () => {
  it('applies a patch, and refuses one that does not fit', () => {
    const after = ORIGINAL.replace('LIMIT = 3', 'LIMIT = 9');
    const hunks = structuredPatch('f', 'f', ORIGINAL, after, '', '', { context: 2 }).hunks;
    expect(applyHunks(ORIGINAL, hunks)).toBe(after);
    expect(applyHunks('something else entirely\n', hunks)).toBeNull();
  });
});
