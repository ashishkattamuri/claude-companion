import { describe, expect, it } from 'vitest';
import { PtyManager } from '../src/main/pty.js';

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error('timed out'));
      }
    }, 20);
  });
}

const spec = (id: string, script: string) => ({
  id,
  sessionId: `session-${id}`,
  title: id,
  cwd: process.cwd(),
  file: '/bin/sh',
  args: ['-c', script],
  env: { PATH: '/usr/bin:/bin' },
});

describe('PtyManager', () => {
  it('runs a program in a real terminal and streams its output with offsets', async () => {
    const m = new PtyManager();
    const chunks: [string, number][] = [];
    m.on('data', (_id, data, end) => chunks.push([data, end]));
    let exit: number | null = null;
    m.on('exit', (_id, code) => (exit = code));

    m.open(spec('a', '[ -t 0 ] && echo "is a tty"; read line; echo "got:$line"'));
    await waitFor(() => chunks.map((c) => c[0]).join('').includes('is a tty'));
    m.write('a', 'hello\r');
    await waitFor(() => exit !== null);

    const all = chunks.map((c) => c[0]).join('');
    expect(all).toContain('got:hello');
    expect(chunks.at(-1)![1]).toBe(all.length);
    expect(m.replay('a')).toEqual({ data: all, end: all.length });
    expect(m.get('a')).toMatchObject({ exited: true, exitCode: 0 });
    expect(m.running()).toHaveLength(0);
  });

  it('finds open tabs by session and kills on close', async () => {
    const m = new PtyManager();
    let exited = false;
    m.on('exit', () => (exited = true));
    m.open(spec('b', 'sleep 30'));
    expect(m.findBySession('session-b')?.id).toBe('b');
    m.close('b');
    await waitFor(() => exited);
    expect(m.list()).toHaveLength(0);
  });
});
