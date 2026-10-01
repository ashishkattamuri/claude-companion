// End-to-end check of the built desktop app, driven by Playwright.
// Runs against an isolated config, database and transcript folder, with a fake `claude`.
// Usage: npm run build && npm run test:e2e   (screenshots land in test/e2e/screenshots/)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

const root = mkdtempSync(join(tmpdir(), 'companion-e2e-'));
const project = join(root, 'demo-app');
mkdirSync(project);
const projectsDir = join(root, 'claude/projects/-demo-app');
mkdirSync(projectsDir, { recursive: true });

// The fixture transcript, moved into a folder that exists so it can be resumed.
const SESSION = '11111111-1111-1111-1111-111111111111';
const fixture = readFileSync(join(repo, 'test/fixtures/basic.jsonl'), 'utf8').replaceAll('/work/demo-app', project);
writeFileSync(join(projectsDir, `${SESSION}.jsonl`), fixture);

const fakeClaude = join(root, 'fake-claude.sh');
writeFileSync(
  fakeClaude,
  `#!/bin/sh
if [ "$1" = "-p" ]; then echo '{"type":"result","is_error":true,"result":"no model calls in e2e"}'; exit 0; fi
echo "FAKE_CLAUDE args=[$*]"
echo "cwd=$(pwd)"
printf "type something: "
read line
echo "GOT=$line"
`,
  { mode: 0o755 },
);

const config = join(root, 'config.toml');
writeFileSync(config, `[sources]\nclaude_dir = "${join(root, 'claude')}"\n[data]\ndir = "${join(root, 'data')}"\n`);

const env = {
  ...process.env,
  COMPANION_CONFIG: config,
  COMPANION_DB: join(root, 'data/db.sqlite'),
  COMPANION_CLAUDE_BIN: fakeClaude,
};
delete env.ELECTRON_RUN_AS_NODE;

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const termText = (page) => page.locator('.term-view:visible .xterm-rows').innerText();
const until = async (fn, ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const app = await electron.launch({ args: [repo], env });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });

  check('opens on Today', await until(async () => /Good (morning|afternoon|evening)/.test(await page.locator('h1').innerText())));
  await page.screenshot({ path: join(shots, '1-today.png') });

  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  check('lists the session', await until(async () => (await page.locator('.list-row').first().innerText()).includes('Webhook retry logic')));
  check('shows session details', (await page.locator('.detail').innerText()).includes('Also add a test for exponential backoff'));
  await page.screenshot({ path: join(shots, '2-sessions.png') });

  await page.locator('.detail').getByRole('button', { name: 'Resume' }).click();
  check('resumes in an embedded terminal', await until(async () => (await termText(page)).includes(`FAKE_CLAUDE args=[--resume ${SESSION}]`)));
  check('runs in the project folder', (await termText(page)).includes(`cwd=${project}`) || (await termText(page)).includes('demo-app'));
  await page.keyboard.type('hello from the GUI');
  await page.keyboard.press('Enter');
  check('keyboard input reaches claude', await until(async () => (await termText(page)).includes('GOT=hello from the GUI')));
  check('tab shows as exited after claude quits', await until(async () => (await page.locator('.term-view:visible').innerText()).includes('exited')));
  await page.screenshot({ path: join(shots, '3-terminal.png') });

  await page.keyboard.press('Meta+n');
  await page.locator('.dialog textarea').fill('Write the changelog');
  await page.screenshot({ path: join(shots, '4-new-session.png') });
  await page.keyboard.press('Meta+Enter');
  check(
    'starts a new session with its own id and the prompt',
    await until(async () => /FAKE_CLAUDE args=\[--session-id [0-9a-f-]{36} Write the changelog\]/.test(await termText(page))),
  );
  check('sidebar lists both tabs', (await page.locator('.nav-item.term').count()) === 2);

  await page.keyboard.press('Meta+w');
  check('⌘W closes the current tab, not the window', await until(async () => (await page.locator('.nav-item.term').count()) === 1));
} finally {
  await app.process().kill();
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}`);
process.exit(failed.length ? 1 : 0);
