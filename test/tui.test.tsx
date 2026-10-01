import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import type { LiveSession } from '../src/ingest/live.js';
import { scan } from '../src/ingest/scanner.js';
import type { LaunchRequest } from '../src/launcher/claude.js';
import { openDb, type DB } from '../src/store/db.js';
import { App } from '../src/tui/App.js';

const SESSION = '11111111-1111-1111-1111-111111111111';
const tick = () => new Promise((r) => setTimeout(r, 30));
const ENTER = '\r';
const DOWN = '\u001B[B';
const BACKSPACE = '\u007F';

let root: string;
let db: DB;
let cfg: Config;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-tui-'));
  const projectDir = join(root, 'claude', 'projects', '-work-demo-app');
  mkdirSync(projectDir, { recursive: true });
  copyFileSync(new URL('./fixtures/basic.jsonl', import.meta.url), join(projectDir, `${SESSION}.jsonl`));
  writeFileSync(join(root, 'config.toml'), `[sources]\nclaude_dir = "${join(root, 'claude')}"\n`);
  cfg = loadConfig(join(root, 'config.toml'));
  db = openDb(':memory:');
  scan(db, cfg);
  // The fixture's cwd doesn't exist; point the session at a real folder so it can be resumed.
  db.prepare(`UPDATE sessions SET cwd = ?`).run(root);
  db.prepare(`UPDATE projects SET cwd = ?`).run(root);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function renderApp(live: LiveSession[] = []) {
  const launch = vi.fn(async (_req: LaunchRequest) => ({ code: 0 }));
  const ui = render(<App db={db} cfg={cfg} loadLive={() => live} launch={launch} />);
  return { ...ui, launch };
}

describe('Sessions tab', () => {
  it('lists sessions with title, project and a preview', () => {
    const { lastFrame } = renderApp();
    const frame = lastFrame()!;
    expect(frame).toContain('Webhook retry logic');
    expect(frame).toContain('demo-app');
    expect(frame).toContain('2 prompts');
    expect(frame).toContain('$0.42');
  });

  it('resumes the selected session in its project folder', async () => {
    const { stdin, launch } = renderApp();
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(launch).toHaveBeenCalledWith({ cwd: root, args: ['--resume', SESSION] });
  });

  it('refuses to resume a session that is already running', async () => {
    const live: LiveSession = { pid: 4242, sessionId: SESSION, cwd: root, status: 'busy', name: 'demo', version: null };
    const { stdin, launch, lastFrame } = renderApp([live]);
    await tick();
    expect(lastFrame()).toContain('1 live');
    expect(lastFrame()).toContain('working in pid 4242');
    stdin.write(ENTER);
    await tick();
    expect(launch).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Already running in another terminal (pid 4242)');
  });

  it('shows a live session even before it has a transcript', () => {
    const live: LiveSession = { pid: 7, sessionId: 'fresh', cwd: '/work/new-thing', status: 'idle', name: 'fresh-start', version: null };
    expect(renderApp([live]).lastFrame()).toContain('fresh-start');
  });

  it('starts a new session in a chosen project with a first prompt', async () => {
    const { stdin, launch } = renderApp();
    await tick();
    stdin.write('n');
    await tick();
    stdin.write(DOWN); // past "Current directory" to the demo-app project
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('write the changelog');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(launch).toHaveBeenCalledWith({ cwd: root, args: ['write the changelog'] });
  });

  it('searches transcripts and does not switch tabs while typing', async () => {
    const { stdin, lastFrame } = renderApp();
    await tick();
    stdin.write('/');
    await tick();
    stdin.write('nomatch2');
    await tick();
    expect(lastFrame()).toContain('Sessions');
    expect(lastFrame()).not.toContain('Coming in');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('0 sessions matching "nomatch2"');

    stdin.write('/');
    await tick();
    for (let i = 0; i < 'nomatch2'.length; i++) {
      stdin.write(BACKSPACE);
      await tick();
    }
    stdin.write('backoff');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('Webhook retry logic');
  });

  it('switches to placeholder tabs with number keys', async () => {
    const { stdin, lastFrame } = renderApp();
    await tick();
    stdin.write('2');
    await tick();
    expect(lastFrame()).toContain('Coming in M2');
  });
});
