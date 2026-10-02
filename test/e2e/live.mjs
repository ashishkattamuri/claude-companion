// Live end-to-end check against the real Claude Code CLI (uses Haiku; costs a few cents).
// Drives a session from the conversation view and from the terminal, and checks both stay in sync.
// Usage: npm run build && node test/e2e/live.mjs   (screenshots in test/e2e/screenshots/live-*.png)
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'companion-live-'));
const realDb = join(homedir(), '.local/share/claude-companion/db.sqlite');
const db = join(scratch, 'db.sqlite');
if (existsSync(realDb)) copyFileSync(realDb, db);
const probeDir = '/tmp/companion-e2e-dir';
rmSync(probeDir, { recursive: true, force: true });

const env = { ...process.env, COMPANION_DB: db, COMPANION_NO_ANALYSIS: '1', COMPANION_USER_DATA: join(scratch, 'user-data') };
delete env.ELECTRON_RUN_AS_NODE;

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const until = async (fn, ms = 60000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const app = await electron.launch({ args: [repo], env });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 });
const thread = () => page.locator('.thread').innerText();
const shot = (name) => page.screenshot({ path: join(shots, `live-${name}.png`) });

try {
  await page.waitForSelector('.sidebar');

  // 1. Start a session from the UI.
  await page.keyboard.press('Meta+n');
  await page.selectOption('#ns-project', repo.replace(/\/$/, ''));
  await page.selectOption('#ns-model', 'haiku');
  await page.fill('#ns-prompt', 'Reply with exactly the word READY and nothing else.');
  await shot('1-new-session');
  await page.keyboard.press('Meta+Enter');
  check('new session shows the first message', await until(async () => (await thread()).includes('Reply with exactly the word READY')));
  check("Claude's reply appears in the conversation", await until(async () => /\bREADY\b/.test(await page.locator('.a-text').last().innerText())));
  check('status becomes Ready', await until(async () => (await page.locator('.status-pill').innerText()).includes('Ready')));
  await shot('2-first-reply');

  // 2. Drive it from the conversation view, through an approval.
  const composer = page.locator('.composer textarea');
  await composer.fill(`Use the Bash tool to run exactly: mkdir -p ${probeDir} && ls -d ${probeDir} . Do nothing else.`);
  await composer.press('Enter');
  check('approval card appears for the command', await until(async () => (await page.locator('.approval').count()) > 0 && (await page.locator('.approval .cmd').innerText()).includes(probeDir)));
  check('sidebar marks the session as needing you', (await page.locator('.s-row.selected .dot.needs').count()) === 1);
  check('approval card offers the real options', (await page.locator('.approval .actions button').count()) >= 3);
  await shot('3-approval');
  await page.locator('.approval .actions button').first().click();
  check('approving in the UI runs the command', await until(async () => existsSync(probeDir)));
  check('approval card goes away', await until(async () => (await page.locator('.approval').count()) === 0));
  check('message shows it came from Companion', await until(async () => (await thread()).includes('from Companion')));
  check('Claude finishes', await until(async () => (await page.locator('.status-pill').innerText()).includes('Ready')));
  await shot('4-after-approval');

  // 3. The terminal shows the same session.
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const termText = () => page.locator('.term-pane .xterm-rows').innerText();
  check('terminal shows the same conversation', await until(async () => (await termText()).includes('READY')));
  await shot('5-split');

  // 4. Drive it from the terminal; the conversation follows.
  await page.locator('.term-pane .xterm-screen').click();
  await page.keyboard.type('Reply with exactly: TYPED-IN-TERMINAL');
  await page.keyboard.press('Enter');
  check('message typed in the terminal appears in the conversation', await until(async () => (await thread()).includes('Reply with exactly: TYPED-IN-TERMINAL')));
  check('it is labelled as typed in the terminal', await until(async () => (await thread()).includes('typed in the terminal')));
  check("Claude's reply to it appears in the conversation", await until(async () => (await page.locator('.a-text').last().innerText()).includes('TYPED-IN-TERMINAL')));
  await shot('6-typed-in-terminal');

  // 5. End the session; it can be continued later.
  await page.getByRole('button', { name: 'End', exact: true }).click();
  check('ending the session marks it not running', await until(async () => (await page.locator('.status-pill').innerText()).includes('Not running'), 15000));
  check('composer offers to continue', (await page.locator('.composer .send').innerText()).includes('Continue'));
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await shot('7-ended');

  // 6. Continue the ended session from the composer: it resumes in a new terminal.
  await composer.fill('Reply with exactly: CONTINUED');
  await composer.press('Enter');
  check('sending to an ended session resumes it', await until(async () => (await page.locator('.a-text').last().innerText()).includes('CONTINUED')));
  check('earlier messages are still there', (await thread()).includes('TYPED-IN-TERMINAL'));
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await until(async () => (await page.locator('.status-pill').innerText()).includes('Not running'), 15000);

  // 7. A session running in another terminal is shown live and read-only.
  const other = page.locator('.s-row', { has: page.locator('.where', { hasText: 'other terminal' }) }).first();
  if (await other.count()) {
    await other.click();
    check('session from another terminal opens read-only', await until(async () => (await page.locator('.status-pill').innerText()).includes('another terminal')));
    check('its conversation is shown', await until(async () => (await page.locator('.thread .u-msg').count()) > 0));
    check('its composer is disabled', await page.locator('.composer textarea').isDisabled());
    await shot('8-mirror');
  } else {
    console.log('– no session running in another terminal; skipped the mirror checks');
  }
} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
  await shot('error').catch(() => {});
} finally {
  await app.close().catch(() => app.process().kill());
  rmSync(scratch, { recursive: true, force: true });
  rmSync(probeDir, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}/live-*.png`);
process.exit(failed.length ? 1 : 0);
