// Live check of "let's discuss this in a separate chat" against the real Claude Code CLI (Haiku;
// a few cents): session notes are written, Claude opens a new chat through Companion's tool, and
// the new chat knows the earlier conversation without showing it.
// Usage: npm run build && npm run test:live-branch
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'companion-branch-'));
const realDb = join(homedir(), '.local/share/claude-companion/db.sqlite');
const db = join(scratch, 'db.sqlite');
if (existsSync(realDb)) copyFileSync(realDb, db);

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE)/.test(k)));
const env = {
  ...cleanEnv,
  COMPANION_DB: db,
  COMPANION_NO_ANALYSIS: '1',
  COMPANION_NOTES_DELAY_MS: '1500',
  COMPANION_USER_DATA: join(scratch, 'user-data'),
};
const jobs = new Set();
const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const until = async (fn, ms = 90000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const app = await electron.launch({ args: [repo], env });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 });
const thread = () => page.locator('.thread').innerText();
const lastReply = () => page.locator('.a-text').last().innerText();
const composer = page.locator('.composer textarea');
const job = async () => (await page.locator('.crumbs').innerText()).match(/claude attach ([0-9a-f]{8})/)?.[1];
const shot = (name) => page.screenshot({ path: join(shots, `branch-${name}.png`) });

try {
  await page.waitForSelector('.sidebar');
  await page.keyboard.press('Meta+n');
  await page.selectOption('#ns-project', repo);
  await page.selectOption('#ns-model', 'haiku');
  await page.fill('#ns-prompt', 'Remember these facts for later: the cache uses Redis with a 300 second TTL, and the project codename is PELICAN-42. Reply with just: OK');
  await page.keyboard.press('Meta+Enter');
  check('the first chat replies', await until(async () => /\bOK\b/.test(await lastReply())));
  jobs.add(await job());
  const parentTitle = await page.locator('.head h1').innerText();

  check('session notes are written after the turn', await until(async () => (await page.locator('.rail').innerText()).includes('Updated'), 120000));
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  check('the notes keep the specifics', /PELICAN-42/.test(await page.locator('.notes-preview').innerText()) && /300/.test(await page.locator('.notes-preview').innerText()));
  await shot('1-notes');

  await composer.fill("Let's brainstorm cache eviction policies in a separate chat.");
  await composer.press('Enter');
  check('Claude opens a new chat and Companion switches to it', await until(async () => (await page.locator('.head h1').innerText()) !== parentTitle && (await page.locator('.crumbs').innerText()).includes('from')));
  jobs.add(await job());
  check('the opening message is prefilled', await until(async () => (await composer.inputValue()).length > 10, 10000));
  console.log(`  prefilled: "${await composer.inputValue()}"`);
  check('the new chat shows none of the earlier conversation', !(await thread()).includes('PELICAN'));
  check('the opening message does not repeat the background', !(await composer.inputValue()).includes('PELICAN'));
  await shot('2-new-chat');

  await composer.fill('Quick check: what were the project codename and the cache TTL from our earlier chat? One line.');
  await composer.press('Enter');
  check('the new chat knows the earlier conversation', await until(async () => /PELICAN-42/.test(await lastReply()) && /300/.test(await lastReply())));
  console.log(`  answer: "${await lastReply()}"`);
  await shot('3-knows-context');

  await page.locator('.from-link').click();
  check('the original chat shows the step', await until(async () => /opened a new chat/i.test(await thread())));
  check('…and links to the new chat', await until(async () => /chats opened from here/i.test(await page.locator('.rail').innerText()), 15000));
  await shot('4-original');
} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
  await shot('error').catch(() => {});
} finally {
  await app.close().catch(() => app.process().kill());
  for (const j of jobs) if (j) try { execFileSync('claude', ['stop', j], { env: cleanEnv, stdio: 'ignore' }); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}/branch-*.png`);
process.exit(failed.length ? 1 : 0);
