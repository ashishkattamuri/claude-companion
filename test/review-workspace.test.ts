import { structuredPatch } from 'diff';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectChanges } from '../src/adapter/changes.js';
import { classifyCommand, collectTrail, commandScope, testOutcome, verificationFor } from '../src/adapter/trail.js';
import { groundOverview, isTrivial, overviewKey, relevantRequests } from '../src/analyze/overview.js';
import { fileKeys, fileReview, readMarks, setMark } from '../src/analyze/reviewMarks.js';
import { openDb } from '../src/store/db.js';

function transcript() {
  const lines: string[] = [];
  let n = 0;
  const push = (rec: object) => lines.push(JSON.stringify({ uuid: `u${++n}`, timestamp: `2026-11-02T10:00:${String(n).padStart(2, '0')}Z`, ...rec }));
  const user = (text: string) => {
    push({ type: 'user', message: { role: 'user', content: text } });
    return `u${n}`;
  };
  const tool = (id: string, name: string, input: object, result: object | null, opts: { isError?: boolean; content?: string } = {}) => {
    push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const uuid = `u${n}`;
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: opts.content ?? 'ok', is_error: !!opts.isError }] }, toolUseResult: result });
    return uuid;
  };
  const patch = (a: string, b: string) => structuredPatch('f', 'f', a, b, '', '', { context: 3 }).hunks;
  return { lines, user, tool, patch };
}

describe('test and check commands', () => {
  it('recognises test runners and checks inside a command line', () => {
    expect(classifyCommand('npm test')).toMatchObject({ kind: 'test' });
    expect(classifyCommand('cd app && pnpm run test:unit -- --run')).toMatchObject({ kind: 'test' });
    expect(classifyCommand('CI=1 npx vitest run test/retry.test.ts 2>&1 | tail -20')).toMatchObject({ kind: 'test' });
    expect(classifyCommand('python -m pytest tests/test_api.py -q')).toMatchObject({ kind: 'test' });
    expect(classifyCommand('go test ./...')).toMatchObject({ kind: 'test' });
    expect(classifyCommand('npm run typecheck')).toMatchObject({ kind: 'check' });
    expect(classifyCommand('npx tsc --noEmit')).toMatchObject({ kind: 'check' });
    expect(classifyCommand('git status')).toBeNull();
    expect(classifyCommand('cat test/retry.test.ts')).toBeNull();
  });

  it('records the files a test command names, and nothing when it runs the configured suite', () => {
    expect(commandScope('npx vitest run test/retry.test.ts')).toEqual(['test/retry.test.ts']);
    expect(commandScope('pytest tests/test_api.py -q')).toEqual(['tests/test_api.py']);
    expect(commandScope('npm test')).toBeNull();
  });

  it('reads the outcome from the exit status, then the runner summary, and never guesses through a pipe', () => {
    expect(testOutcome('      Tests  157 passed (157)', false).outcome).toBe('passed');
    expect(testOutcome('      Tests  2 failed | 155 passed (157)', false).outcome).toBe('failed');
    expect(testOutcome('Error: something', true).outcome).toBe('failed');
    expect(testOutcome('', false).outcome).toBe('passed');
    expect(testOutcome('', false, true).outcome).toBe('unknown');
    expect(testOutcome('Tests  4 passed (4)', false, true)).toEqual({ outcome: 'passed', summary: 'Tests  4 passed (4)' });
  });
});

describe('collectTrail', () => {
  it('lists requests, edits, test runs and failures in transcript order', () => {
    const t = transcript();
    const ask = t.user('Add retries to the client');
    const edit = t.tool('e1', 'Edit', { file_path: '/p/a.ts' }, { filePath: '/p/a.ts', oldString: 'x', newString: 'y', originalFile: 'x\n', structuredPatch: t.patch('x\n', 'y\n') });
    const run = t.tool('b1', 'Bash', { command: 'npm test' }, { stdout: 'Tests  3 passed (3)', stderr: '', interrupted: false });
    t.tool('b2', 'Bash', { command: 'npx vitest run test/a.test.ts' }, { stdout: 'FAIL test/a.test.ts\nTests  1 failed (1)', stderr: '' }, { isError: true, content: 'FAIL' });
    t.tool('b3', 'Bash', { command: 'rm -rf build' }, null, { isError: true, content: "The user doesn't want to proceed with this tool use." });
    t.user('<system-reminder>ignore</system-reminder>');

    const trail = collectTrail(t.lines);
    expect(trail.requests).toEqual([{ id: ask, ts: expect.any(String), text: 'Add retries to the client' }]);
    expect(trail.edits).toMatchObject([{ stepId: edit, abs: '/p/a.ts' }]);
    expect(trail.tests.map((r) => [r.command, r.outcome, r.scope])).toEqual([
      ['npm test', 'passed', null],
      ['npx vitest run test/a.test.ts', 'failed', ['test/a.test.ts']],
    ]);
    expect(trail.tests[0]!.stepId).toBe(run);
    expect(trail.failures.map((f) => [f.tool, f.denied])).toEqual([
      ['Bash', false],
      ['Bash', true],
    ]);
  });

  it("judges a file's evidence by what ran after its last edit", () => {
    const t = transcript();
    t.user('go');
    t.tool('e1', 'Edit', { file_path: '/p/a.ts' }, { filePath: '/p/a.ts', oldString: 'x', newString: 'y', originalFile: 'x\n', structuredPatch: t.patch('x\n', 'y\n') });
    t.tool('b1', 'Bash', { command: 'npm test' }, { stdout: 'Tests  3 passed (3)', stderr: '' });
    t.tool('e2', 'Edit', { file_path: '/p/b.ts' }, { filePath: '/p/b.ts', oldString: 'x', newString: 'z', originalFile: 'x\n', structuredPatch: t.patch('x\n', 'z\n') });
    const trail = collectTrail(t.lines);
    const seq = (abs: string) => trail.edits.findLast((e) => e.abs === abs)!.seq;
    expect(verificationFor(seq('/p/a.ts'), trail.tests).state).toBe('passed');
    expect(verificationFor(seq('/p/b.ts'), trail.tests).state).toBe('stale');
    expect(verificationFor(seq('/p/b.ts'), []).state).toBe('none');
  });
});

describe('review overview', () => {
  const t = transcript();
  const ask = t.user('Retry webhook calls');
  t.tool('e1', 'Edit', { file_path: '/p/src/a.ts' }, { filePath: '/p/src/a.ts', oldString: 'x', newString: 'y', originalFile: 'x\n', structuredPatch: t.patch('x\n', 'y\n') });
  t.tool('e2', 'Edit', { file_path: '/p/README.md' }, { filePath: '/p/README.md', oldString: 'x', newString: 'y', originalFile: 'x\n', structuredPatch: t.patch('x\n', 'y\n') });
  const later = t.user('thanks, also what about the docs?');
  const files = collectChanges(t.lines);
  const display = (abs: string) => abs.replace('/p/', '');

  it('keeps only changed files and real requests, and puts unclaimed files in Other changes', () => {
    const asked = relevantRequests(files, collectTrail(t.lines).requests);
    expect(asked.map((r) => r.id)).toEqual([ask, later]);
    const o = groundOverview(
      {
        implemented: 'Retries.',
        behaviors: [{ title: 'Retry calls', summary: 's', why: '', files: ['src/a.ts', 'src/invented.ts'], requests: [1, 9], risk: 'high', risk_reason: 'r' }],
        deviations: [{ text: 'No backoff.', requests: [1] }],
      },
      files,
      asked,
      display,
      { model: 'sonnet', key: 'k' },
    );
    expect(o.behaviors.map((b) => [b.title, b.files, b.requestIds])).toEqual([
      ['Retry calls', ['src/a.ts'], [ask]],
      ['Other changes', ['README.md'], []],
    ]);
    expect(o.behaviors[0]!.why).toBeNull();
    expect(o.deviations).toEqual([{ text: 'No backoff.', requestIds: [ask] }]);
  });

  it('is keyed by the exact changes, and a one-file change needs no model call', () => {
    const trail = collectTrail(t.lines);
    expect(overviewKey(files, trail.requests)).toBe(overviewKey([...files].reverse(), trail.requests));
    expect(overviewKey(files.slice(0, 1), trail.requests)).not.toBe(overviewKey(files, trail.requests));
    expect(isTrivial(files.slice(0, 1))).toBe(true);
    expect(isTrivial(files)).toBe(false);
  });
});

describe('review marks', () => {
  const v0 = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const v1 = v0.replace('line 2\n', 'line two\n').replace('line 25\n', 'line twenty-five\n');
  const v2 = v1.replace('line 25\n', 'line 25\n').replace('line twenty-five\n', 'line 25 again\n');
  const change = (after: string) => {
    const t = transcript();
    t.tool('e', 'Edit', { file_path: '/p/a.ts' }, { filePath: '/p/a.ts', oldString: 'x', newString: 'y', originalFile: v0, structuredPatch: t.patch(v0, after) });
    return collectChanges(t.lines)[0]!;
  };

  it('keeps reviewed hunks reviewed and flags only the hunks that changed', () => {
    const first = change(v1);
    expect(first.hunks).toHaveLength(2);
    const mark = { keys: fileKeys(first), at: 'then' };
    expect(fileReview(first, mark)).toEqual({ state: 'reviewed', at: 'then', changedHunks: [] });
    const second = change(v2);
    expect(fileReview(second, mark)).toEqual({ state: 'changed', at: 'then', changedHunks: [1] });
    expect(fileReview(second, undefined).state).toBe('unreviewed');
  });

  it('flags the whole file when its earlier content was not recorded', () => {
    const partial = { ...change(v2), before: null };
    expect(fileReview(partial, { keys: fileKeys(change(v1)), at: 'then' }).changedHunks).toEqual([0, 1]);
  });

  it('persists marks and clears them', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'marks-')), 'db.sqlite'));
    setMark(db, 's1', 'reviewed', '/p/a.ts', ['k1']);
    setMark(db, 's1', 'understood', 'b1', ['h1']);
    expect([...readMarks(db, 's1', 'reviewed').keys()]).toEqual(['/p/a.ts']);
    setMark(db, 's1', 'reviewed', '/p/a.ts', null);
    expect(readMarks(db, 's1', 'reviewed').size).toBe(0);
    expect(readMarks(db, 's1', 'understood').get('b1')?.keys).toEqual(['h1']);
  });
});
