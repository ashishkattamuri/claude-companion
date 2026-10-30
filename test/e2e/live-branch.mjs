// Live check of "let's discuss this in a separate chat" against the real Claude Code CLI (Haiku;
// a few cents): session notes are written, Claude opens a new chat through Companion's tool, and
// the new chat knows the earlier conversation without showing it, and looks up details the notes
// left out in the earlier conversation itself.
// Runs in a sandbox (see sandbox.mjs): needs CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
// Usage: npm run build && npm run test:live-branch
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { liveSandbox } from './sandbox.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
// Its own Claude Code config folder, project folder and database; deleted at the end.
const sandbox = liveSandbox('branch');
const project = sandbox.project;
const cleanEnv = sandbox.claudeEnv;
const env = { ...sandbox.appEnv, COMPANION_NOTES_DELAY_MS: '1500' };
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
const shot = (name) => page.screenshot({ path: join(shots, `branch-${name}.png`) });

// A file the first chat reads and that is then deleted: one line of it is a detail no notes keep.
const row = (i) => `row ${i}: ${createHash('sha1').update(String(i)).digest('hex').slice(0, 10)}`;
writeFileSync(join(project, 'build.log'), `${Array.from({ length: 300 }, (_, i) => row(i + 1)).join('\n')}\n`);

/** The plain terminal session (see below); it must have exited before the sandbox is cleaned up. */
let iterm = null;
const closeTerminal = async () => {
  if (!iterm) return;
  const exited = new Promise((r) => iterm.onExit(r));
  iterm.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
  iterm = null;
};

try {
  await page.waitForSelector('.sidebar');
  await page.keyboard.press('Meta+n');
  await page.selectOption('#ns-project', project);
  await page.selectOption('#ns-model', 'haiku');
  await page.selectOption('#ns-mode', 'default');
  await page.fill('#ns-prompt', 'Remember these facts for later: the cache uses Redis with a 300 second TTL, and the project codename is PELICAN-42. Also read build.log in full and count its lines. Reply with just: OK <line count>');
  await page.keyboard.press('Meta+Enter');
  check('the first chat replies', await until(async () => /\bOK\b/.test(await lastReply())));
  rmSync(join(project, 'build.log'));

  check('session notes are written after the turn', await until(async () => (await page.locator('.rail').innerText()).includes('Updated'), 120000));
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  check('the notes keep the specifics', /PELICAN-42/.test(await page.locator('.notes-preview').innerText()) && /300/.test(await page.locator('.notes-preview').innerText()));
  await shot('1-notes');

  // The title as it is now: Claude Code retitles a chat after its first turn.
  const parentTitle = await page.locator('.head h1').innerText();
  await composer.fill("Let's brainstorm cache eviction policies in a separate chat.");
  await composer.press('Enter');
  check('Claude opens a new chat and Companion switches to it', await until(async () => (await page.locator('.head h1').innerText()) !== parentTitle && (await page.locator('.crumbs').innerText()).includes(`from ${parentTitle}`)));
  console.log(`  switched to: "${await page.locator('.head h1').innerText()}" (${(await page.locator('.crumbs').innerText()).replace(/\s+/g, ' ')})`);
  await shot('2a-switched');
  check('the new chat starts on its opening message right away', await until(async () => (await page.locator('.u-msg').count()) >= 1 && (await page.locator('.a-text').count()) >= 1));
  const opening = await page.locator('.u-msg .u-text').first().innerText();
  console.log(`  opening message: "${opening}"`);
  check('the opening message does not repeat the background', !opening.includes('PELICAN'));
  check('the new chat shows none of the earlier notes', !(await thread()).includes('earlier_conversation_notes'));
  await shot('2-new-chat');

  await composer.fill('Quick check: what were the project codename and the cache TTL from our earlier chat? One line.');
  await composer.press('Enter');
  check('the new chat knows the earlier conversation', await until(async () => /PELICAN-42/.test(await lastReply()) && /300/.test(await lastReply())));
  console.log(`  answer: "${await lastReply()}"`);
  await shot('3-knows-context');

  await composer.fill('build.log has since been deleted. In our earlier chat you read it: what exactly was on its "row 237" line? Quote the line.');
  await composer.press('Enter');
  check('the new chat looks up a detail the notes left out, word for word', await until(async () => (await lastReply()).includes(row(237).split(': ')[1]), 120000));
  console.log(`  answer: "${await lastReply()}"`);
  const usedTool = sandbox.transcriptDirs().some((d) =>
    readdirSync(d).some((f) => f.endsWith('.jsonl') && readFileSync(join(d, f), 'utf8').includes('"name":"mcp__companion__search_earlier_conversation"')),
  );
  check('…by searching the earlier conversation', usedTool);
  await shot('3b-looked-up');

  await page.locator('.from-link').click();
  check('the original chat shows the step', await until(async () => /opened a new chat/i.test(await thread())));
  check('…and links to the new chat', await until(async () => /chats opened from here/i.test(await page.locator('.rail').innerText()), 15000));
  await shot('4-original');

  // A plain `claude` in another terminal (as in iTerm), with Companion's tool registered the way
  // `companion tools install` does it. Asking there opens the new chat in Companion.
  const mcpConfig = join(sandbox.root, 'user-mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { companion: { command: require('electron'), args: [join(repo, 'dist/cli.js'), 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', COMPANION_CONFIG: env.COMPANION_CONFIG, COMPANION_DB: env.COMPANION_DB } } } }));
  const before = await page.locator('.head h1').innerText();
  iterm = pty.spawn('claude', ['--model', 'haiku', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__companion__start_new_chat'], {
    cols: 120, rows: 40, cwd: project, env: { ...cleanEnv, TERM: 'xterm-256color' },
  });
  let screen = '';
  iterm.onData((d) => (screen += d));
  await until(async () => /❯/.test(screen), 30000);
  await new Promise((r) => setTimeout(r, 1500));
  iterm.write("\x1b[200~We're choosing between REST and GraphQL. Let's discuss the issues with these approaches in a separate chat.\x1b[201~");
  await new Promise((r) => setTimeout(r, 400));
  iterm.write('\r');
  check('asking in a plain terminal opens the new chat in Companion', await until(async () => (await page.locator('.head h1').innerText()) !== before && (await page.locator('.u-msg').count()) >= 1, 120000));
  await shot('5-from-terminal');
  await closeTerminal();

} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
  await shot('error').catch(() => {});
} finally {
  await closeTerminal();
  await app.close().catch(() => app.process().kill());
  // Stop every background session the run started, including copies and new chats, and delete the sandbox.
  if (sandbox.cleanup().length) checks.push(['no sessions left behind in ~/.claude', false]);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}/branch-*.png`);
process.exit(failed.length ? 1 : 0);
