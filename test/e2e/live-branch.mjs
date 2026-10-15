// Live check of "let's discuss this in a separate chat" against the real Claude Code CLI (Haiku;
// a few cents): session notes are written, Claude opens a new chat through Companion's tool, and
// the new chat knows the earlier conversation without showing it.
// Usage: npm run build && npm run test:live-branch
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

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

  // A plain `claude` in another terminal (as in iTerm), with Companion's tool registered the way
  // `companion tools install` does it. Asking there opens the new chat in Companion.
  const mcpConfig = join(scratch, 'user-mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { companion: { command: require('electron'), args: [join(repo, 'dist/cli.js'), 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', COMPANION_DB: db } } } }));
  const before = await page.locator('.head h1').innerText();
  const iterm = pty.spawn('claude', ['--model', 'haiku', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__companion__start_new_chat'], {
    cols: 120, rows: 40, cwd: repo, env: { ...cleanEnv, TERM: 'xterm-256color' },
  });
  let screen = '';
  iterm.onData((d) => (screen += d));
  await until(async () => /❯/.test(screen), 30000);
  await new Promise((r) => setTimeout(r, 1500));
  iterm.write("\x1b[200~We're choosing between REST and GraphQL. Let's discuss the issues with these approaches in a separate chat.\x1b[201~");
  await new Promise((r) => setTimeout(r, 400));
  iterm.write('\r');
  check('asking in a plain terminal opens the new chat in Companion', await until(async () => (await page.locator('.head h1').innerText()) !== before && (await composer.inputValue()).length > 10, 120000));
  console.log(`  prefilled: "${await composer.inputValue()}"`);
  jobs.add(await job());
  await shot('5-from-terminal');
  iterm.kill();
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
