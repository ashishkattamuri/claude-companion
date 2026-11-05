import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Lets a test make starting the attach fail, as when node-pty's helper is gone with a deleted folder.
const failSpawn = vi.hoisted(() => ({ on: false }));
vi.mock('node-pty', async (real) => {
  const actual = await real<typeof import('node-pty')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (failSpawn.on) throw new Error('posix_spawnp failed.');
      return actual.spawn(...args);
    },
  };
});

const { SessionChannel } = await import('../src/main/session.js');

describe('SessionChannel.attach', () => {
  let dir = '';
  let ch: InstanceType<typeof SessionChannel> | null = null;
  afterEach(() => {
    failSpawn.on = false;
    ch?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A background chat that's still running: registered in Claude Code's registry, under this test's own pid. */
  const backgroundChat = (claudeBin: string) => {
    const entry = { pid: process.pid, sessionId: 's1', jobId: 'abcd1234', status: 'idle', waitingFor: null };
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ ...entry, kind: 'bg', cwd: dir }));
    ch = new SessionChannel('s1', { projectsDir: dir, claudeDir: dir, claudeBin, env: () => ({ PATH: '/usr/bin:/bin' }) }, { cwd: dir, title: 'A chat', mode: 'history' });
    ch.useBackground(entry);
    return ch;
  };

  it("doesn't throw when the attach can't start: it stays a background chat and says why", () => {
    dir = mkdtempSync(join(tmpdir(), 'attach-'));
    const chat = backgroundChat('claude');
    failSpawn.on = true;
    let attached: boolean | undefined;
    expect(() => (attached = chat.attach())).not.toThrow();
    expect(attached).toBe(false);
    expect(chat.state.mode).toBe('background');
    expect(chat.state.attachError).toBe("Couldn't attach to this background chat: posix_spawnp failed.");
    // Trying again once it can start clears the error.
    failSpawn.on = false;
  });

  it('says why when `claude attach` exits with an error straight away', async () => {
    dir = mkdtempSync(join(tmpdir(), 'attach-'));
    const claude = join(dir, 'claude');
    writeFileSync(claude, '#!/bin/sh\nprintf "\\033[31mError: no background session abcd1234\\033[0m\\n"\nexit 1\n', { mode: 0o755 });
    const chat = backgroundChat(claude);
    expect(chat.attach()).toBe(true);
    await vi.waitFor(() => expect(chat.state.attachError).toBe("Couldn't attach to this background chat: Error: no background session abcd1234"), { timeout: 10_000 });
    expect(chat.state.mode).toBe('background');
    expect(chat.attached).toBe(false);
  }, 15_000);
});
