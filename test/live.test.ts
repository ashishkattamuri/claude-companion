import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLiveSessions } from '../src/ingest/live.js';

describe('readLiveSessions', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists terminal sessions but not `claude -p` runs, such as Companion’s own /context reads', () => {
    dir = mkdtempSync(join(tmpdir(), 'live-'));
    mkdirSync(join(dir, 'sessions'));
    // This test's own process stands in for a running claude (no procStart: only the pid is checked).
    const entry = (sessionId: string, entrypoint: string) => ({ pid: process.pid, sessionId, cwd: '/p', kind: 'interactive', entrypoint, status: 'busy' });
    writeFileSync(join(dir, 'sessions', 'a.json'), JSON.stringify(entry('terminal-chat', 'cli')));
    writeFileSync(join(dir, 'sessions', 'b.json'), JSON.stringify(entry('print-run', 'sdk-cli')));
    expect(readLiveSessions(dir).map((s) => s.sessionId)).toEqual(['terminal-chat']);
  });
});
