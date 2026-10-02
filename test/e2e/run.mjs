// Offline end-to-end check of the built app: no login, no model calls. A fake `claude`
// (fake-claude.mjs) writes transcripts and registry files into an isolated Claude folder.
// Usage: npm run build && npm run test:e2e   (screenshots land in test/e2e/screenshots/)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });

const root = mkdtempSync(join(tmpdir(), 'companion-e2e-'));
const claudeDir = join(root, 'claude');
const project = join(root, 'demo-app');
mkdirSync(project);
mkdirSync(join(claudeDir, 'projects'), { recursive: true });

// An earlier session from the fixture, so the list isn't empty.
const SESSION = '11111111-1111-1111-1111-111111111111';
const fixtureDir = join(claudeDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(fixtureDir, { recursive: true });
writeFileSync(
  join(fixtureDir, `${SESSION}.jsonl`),
  readFileSync(join(repo, 'test/fixtures/basic.jsonl'), 'utf8').replaceAll('/work/demo-app', project),
);

const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!/bin/sh\nexec node "${join(repo, 'test/e2e/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
const config = join(root, 'config.toml');
writeFileSync(config, `[sources]\nclaude_dir = "${claudeDir}"\n[data]\ndir = "${join(root, 'data')}"\n`);

const env = {
  ...process.env,
  COMPANION_CONFIG: config,
  COMPANION_DB: join(root, 'data/db.sqlite'),
  COMPANION_CLAUDE_BIN: fake,
  COMPANION_NO_ANALYSIS: '1',
  COMPANION_USER_DATA: join(root, 'user-data'),
  FAKE_CLAUDE_DIR: claudeDir,
};
delete env.ELECTRON_RUN_AS_NODE;

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const until = async (fn, ms = 10000) => {
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
  await page.setViewportSize({ width: 1440, height: 900 });
  const thread = () => page.locator('.thread').innerText();
  const status = () => page.locator('.status-pill').innerText();

  check('opens on Today', await until(async () => /Good (morning|afternoon|evening)/.test(await page.locator('h1').innerText())));
  check('lists the earlier session', await until(async () => (await page.locator('.sessions').innerText()).includes('Webhook retry logic')));
  await page.screenshot({ path: join(shots, '1-today.png') });

  await page.locator('.s-row', { hasText: 'Webhook retry logic' }).click();
  check('shows an earlier conversation', await until(async () => (await thread()).includes('Also add a test for exponential backoff')));
  check('marks it as not running', (await status()).includes('Not running'));

  await page.keyboard.press('Meta+n');
  await page.selectOption('#ns-project', project);
  await page.fill('#ns-prompt', 'hello from the sheet');
  await page.keyboard.press('Meta+Enter');
  check('starts a session and shows the reply', await until(async () => (await thread()).includes('echo: hello from the sheet')));
  check('labels the first message as sent from Companion', (await thread()).includes('from Companion'));

  const composer = page.locator('.composer textarea');
  await composer.fill('please needs-approval');
  await composer.press('Enter');
  check('shows an approval card with the command', await until(async () => (await page.locator('.approval .cmd').innerText()).includes('touch approved.txt')));
  check('sidebar marks the session as needing you', await until(async () => (await page.locator('.s-row.selected .dot.needs').count()) === 1));
  await page.screenshot({ path: join(shots, '2-approval.png') });
  await page.locator('.approval .actions button', { hasText: 'Yes' }).first().click();
  check('approving in the UI answers the terminal', await until(async () => existsSync(join(project, 'approved.txt'))));
  check('the tool call shows as done', await until(async () => (await thread()).includes('Created approved.txt.')));

  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('.term-pane .xterm-screen').click();
  await page.keyboard.type('typed in xterm');
  await page.keyboard.press('Enter');
  check('typing in the terminal shows in the conversation', await until(async () => (await thread()).includes('echo: typed in xterm')));
  check('labels it as typed in the terminal', (await thread()).includes('typed in the terminal'));
  await page.screenshot({ path: join(shots, '3-split.png') });

  await page.getByRole('button', { name: 'End', exact: true }).click();
  check('ending the session marks it not running', await until(async () => (await status()).includes('Not running')));
} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
} finally {
  await app.close().catch(() => app.process().kill());
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}`);
process.exit(failed.length ? 1 : 0);
