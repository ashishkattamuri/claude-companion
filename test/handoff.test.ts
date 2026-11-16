import { structuredPatch } from 'diff';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectChanges } from '../src/adapter/changes.js';
import { collectTrail } from '../src/adapter/trail.js';
import { buildPackage, claimForSend, composeMessage, listReturns, savePackage, toPackage } from '../src/analyze/handoff.js';
import { openDb } from '../src/store/db.js';

function transcript() {
  const lines: string[] = [];
  let n = 0;
  const push = (rec: object) => lines.push(JSON.stringify({ uuid: `u${++n}`, timestamp: `2026-11-02T10:00:${String(n).padStart(2, '0')}Z`, ...rec }));
  return {
    lines,
    user: (text: string) => push({ type: 'user', message: { role: 'user', content: text } }),
    say: (text: string) => push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    tool: (id: string, name: string, input: object, result: object | null, isError = false) => {
      push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? "The user doesn't want to proceed with this tool use." : 'ok', is_error: isError }] }, toolUseResult: result });
    },
  };
}

function child() {
  const t = transcript();
  t.user('Add caching');
  t.say('I will cache the lookups.');
  t.tool('e1', 'Edit', { file_path: '/w/a.ts' }, { filePath: '/w/a.ts', oldString: 'x', newString: 'y', originalFile: 'x\n', structuredPatch: structuredPatch('f', 'f', 'x\n', 'y\n', '', '').hunks });
  t.tool('b1', 'Bash', { command: 'npm test' }, { stdout: 'Tests  4 passed (4)', stderr: '' });
  t.tool('b2', 'Bash', { command: 'rm -rf dist' }, null, true);
  t.say('Done: lookups are cached.');
  return t;
}

const input = (t: ReturnType<typeof transcript>, over: object = {}) => ({
  childId: 'c1',
  parentId: 'p1',
  childTitle: 'Caching',
  parentTitle: 'Main',
  kind: 'branch',
  files: collectChanges(t.lines),
  trail: collectTrail(t.lines),
  display: (abs: string) => abs.replace('/w/', ''),
  disk: () => 'same' as const,
  lastReply: { id: 'u9', text: 'Done: lookups are cached.' },
  todos: [
    { content: 'Cache writes', status: 'pending' },
    { content: 'Cache reads', status: 'completed' },
  ],
  childStatus: 'idle' as const,
  childCwd: '/w',
  parentCwd: '/w',
  ...over,
});

describe('return packages', () => {
  it('collects the outcome as a claim, changes, decisions, test evidence and concerns', () => {
    const pkg = buildPackage(input(child()));
    expect(pkg.outcome?.text).toBe('Done: lookups are cached.');
    expect(pkg.remaining).toEqual(['Cache writes']);
    expect(pkg.changes).toEqual([{ path: 'a.ts', added: 1, removed: 1, disk: 'same', verified: 'passed' }]);
    expect(pkg.decisions.map((d) => d.text)).toEqual(['I will cache the lookups.']);
    expect(pkg.verification.map((v) => [v.command, v.outcome, v.stale])).toEqual([['npm test', 'passed', false]]);
    expect(pkg.concerns).toEqual(['1 step was denied permission.']);
    expect(pkg.workspace.same).toBe(true);
    const msg = composeMessage({ ...pkg, version: 1 });
    expect(msg).toContain("in the child's own words (a claim, not verified)");
    expect(msg).toContain('already in this folder');
    expect(msg).toContain('- npm test: passed');
  });

  it('says plainly when nothing was verified and the changes are in another folder', () => {
    const t = transcript();
    t.user('go');
    t.tool('e1', 'Edit', { file_path: '/wt/a.ts' }, { filePath: '/wt/a.ts', oldString: 'x', newString: 'y', originalFile: 'x\n', structuredPatch: structuredPatch('f', 'f', 'x\n', 'y\n', '', '').hunks });
    const pkg = buildPackage(input(t, { childCwd: '/wt', childStatus: 'working', lastReply: null }));
    const msg = composeMessage({ ...pkg, version: 2 });
    expect(msg).toContain('Verification: not verified. No test or check ran.');
    expect(msg).toContain('in /wt, not merged into this folder');
    expect(msg).toContain('the child has not replied yet');
    expect(pkg.concerns[0]).toContain('still working');
    expect(pkg.suggestion).toContain('nothing has been merged');
    expect(composeMessage({ ...pkg, version: 2 }, ['changes'])).not.toContain('Verification');
  });

  it('versions packages by what the child did, and sends each version once', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'handoff-')), 'db.sqlite'));
    const t = child();
    const v1 = savePackage(db, buildPackage(input(t)));
    expect(savePackage(db, buildPackage(input(t))).id).toBe(v1.id); // nothing new: same version
    expect(claimForSend(db, v1.id, 'hello').ok).toBe(true);
    expect(claimForSend(db, v1.id, 'hello')).toEqual({ ok: false, error: 'Version 1 was already sent to the original chat.' });

    t.say('One more thing.');
    const pkg2 = buildPackage(input(t));
    expect(toPackage(v1, pkg2.stateKey).outdated).toBe(true);
    const v2 = savePackage(db, pkg2);
    expect(v2.version).toBe(2);
    expect(listReturns(db, 'c1').map((r) => [r.version, r.status])).toEqual([
      [1, 'sent'],
      [2, 'draft'],
    ]);
    expect(toPackage(listReturns(db, 'c1')[0]!, pkg2.stateKey).message).toBe('hello');
  });
});
