// Live end-to-end check against the real Claude Code CLI (uses Haiku; costs a few cents).
// Drives a session from the conversation view and from the terminal, and checks both stay in sync.
// Usage: npm run build && node test/e2e/live.mjs   (screenshots in test/e2e/screenshots/live-*.png)
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

// Runs on Electron's Node (npm run test:live) so it can open a real second terminal with node-pty.
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const repo = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'companion-live-'));
const realDb = join(homedir(), '.local/share/claude-companion/db.sqlite');
const db = join(scratch, 'db.sqlite');
if (existsSync(realDb)) copyFileSync(realDb, db);
const probeDir = '/tmp/companion-e2e-dir';
rmSync(probeDir, { recursive: true, force: true });

const jobs = new Set();
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE)/.test(k)));
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

  // 3. The terminal pane shows the same session.
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const termText = () => page.locator('.term-pane .xterm-rows').innerText();
  check('terminal pane shows the same conversation', await until(async () => (await termText()).includes('READY')));
  await shot('5-split');

  // 4. A second terminal (iTerm's role) attaches with `claude attach` and drives the same session.
  const job = (await page.locator('.crumbs').innerText()).match(/claude attach ([0-9a-f]{8})/)?.[1];
  check('header shows the attach command', !!job);
  jobs.add(job);
  const screen = new Terminal({ cols: 110, rows: 36, allowProposedApi: true });
  const iterm = pty.spawn('claude', ['attach', job], { cols: 110, rows: 36, cwd: repo, env: { ...cleanEnv, TERM: 'xterm-256color' } });
  iterm.onData((d) => screen.write(d));
  const itermText = () => {
    const b = screen.buffer.active;
    let out = '';
    for (let i = 0; i < screen.rows; i++) out += `${b.getLine(b.viewportY + i)?.translateToString(true) ?? ''}\n`;
    return out;
  };
  check('second terminal attaches and sees the session', await until(async () => itermText().includes('READY'), 20000));
  iterm.write('\x1b[200~Reply with exactly: FROM-ITERM\x1b[201~');
  await new Promise((r) => setTimeout(r, 300));
  iterm.write('\r');
  check('input typed in the second terminal shows in the conversation', await until(async () => (await thread()).includes('Reply with exactly: FROM-ITERM')));
  check("…with Claude's reply", await until(async () => (await page.locator('.a-text').last().innerText()).includes('FROM-ITERM')));
  check("…and in Companion's terminal pane", await until(async () => (await termText()).includes('FROM-ITERM')));
  await composer.fill('Reply with exactly: FROM-APP');
  await composer.press('Enter');
  check('a message sent from Companion shows in the second terminal', await until(async () => /⏺\s*FROM-APP/.test(itermText())));
  iterm.kill();
  await shot('6-two-terminals');

  // 5. End the session; it can be continued later.
  await page.getByRole('button', { name: 'End', exact: true }).click();
  check('ending the session marks it not running', await until(async () => (await page.locator('.status-pill').innerText()).includes('Not running'), 15000));
  check('composer offers to continue', (await page.locator('.composer .send').innerText()).includes('Continue'));
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await shot('7-ended');

  // 6. Continue the ended session from the composer: it resumes as a background session.
  await composer.fill('Reply with exactly: CONTINUED');
  await composer.press('Enter');
  check('sending to an ended session resumes it', await until(async () => (await page.locator('.a-text').last().innerText()).includes('CONTINUED')));
  check('earlier messages are still there', (await thread()).includes('FROM-ITERM'));
  const resumedJob = (await page.locator('.crumbs').innerText()).match(/claude attach ([0-9a-f]{8})/)?.[1];
  if (resumedJob) jobs.add(resumedJob);
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await until(async () => (await page.locator('.status-pill').innerText()).includes('Not running'), 15000);

  // 7. A session running in another terminal is shown live and read-only.
  const other = page.locator('.s-row', { has: page.locator('.where', { hasText: 'other terminal' }) }).first();
  if (await other.count()) {
    await other.click();
    check('a plain session from another terminal opens view-only', await until(async () => (await page.locator('.status-pill').innerText()).includes('View only')));
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
  // Quitting Companion leaves background sessions running; stop the ones this test started.
  const { execFileSync } = await import('node:child_process');
  for (const j of jobs) if (j) try { execFileSync('claude', ['stop', j], { env: cleanEnv, stdio: 'ignore' }); } catch {}
  rmSync(scratch, { recursive: true, force: true });
  rmSync(probeDir, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}/live-*.png`);
process.exit(failed.length ? 1 : 0);
