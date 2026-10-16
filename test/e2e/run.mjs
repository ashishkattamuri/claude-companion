// Offline end-to-end check of the built app: no login, no model calls. A fake `claude`
// (fake-claude.mjs) writes transcripts and registry files into an isolated Claude folder.
// Usage: npm run build && npm run test:e2e   (screenshots land in test/e2e/screenshots/)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
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
  COMPANION_NO_NOTES: '1',
  COMPANION_SOCKET: join(root, 'app.sock'),
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

// The built CLI runs on Electron's Node: the launcher, and the MCP server Claude sessions start.
{
  const { spawnSync } = await import('node:child_process');
  const launcher = spawnSync(process.execPath, [join(repo, 'bin/companion.js'), '--help'], { encoding: 'utf8', env });
  check('the companion command runs on Electron\'s Node', launcher.status === 0 && launcher.stdout.includes('scan'));
  const electronBin = (await import('node:module')).createRequire(import.meta.url)('electron');
  const init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n';
  const mcp = spawnSync(electronBin, [join(repo, 'dist/cli.js'), 'mcp'], { input: init, encoding: 'utf8', env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 });
  check('the MCP server starts and answers', mcp.stdout.includes('"name":"companion"'));
}

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
  check('typing in the terminal pane shows in the conversation', await until(async () => (await thread()).includes('echo: typed in xterm')));
  check('labels it as typed in the terminal', (await thread()).includes('typed in the terminal'));

  // Another terminal (say iTerm, via `claude attach`) joins the same session and types into it.
  const job = (await page.locator('.crumbs').innerText()).match(/claude attach ([0-9a-f]{8})/)?.[1];
  check('header shows the attach command for other terminals', !!job);
  const iterm = createConnection(join(claudeDir, 'fake-socks', `${job}.sock`));
  await new Promise((r) => iterm.once('connect', r));
  iterm.write('\x1b[200~typed in iTerm\x1b[201~');
  await new Promise((r) => setTimeout(r, 100));
  iterm.write('\r');
  check('input from another attached terminal shows in the conversation', await until(async () => (await thread()).includes('echo: typed in iTerm')));
  check("…and in Companion's terminal pane", await until(async () => (await page.locator('.term-pane .xterm-rows').innerText()).includes('echo: typed in iTerm')));
  await composer.fill('and back from Companion');
  await composer.press('Enter');
  let seenByIterm = '';
  iterm.on('data', (d) => (seenByIterm += d));
  check('a message sent from Companion reaches the other terminal', await until(async () => seenByIterm.includes('echo: and back from Companion')));
  iterm.end();
  await page.screenshot({ path: join(shots, '3-split.png') });

  await page.getByRole('button', { name: 'End', exact: true }).click();
  check('ending the session stops it', await until(async () => (await status()).includes('Not running')));

  await composer.fill('picking this back up');
  await composer.press('Enter');
  check('sending to an ended session continues it', await until(async () => (await thread()).includes('echo: picking this back up')));
  check('and keeps the earlier conversation', (await thread()).includes('echo: typed in iTerm'));

  // Claude calls the new-chat tool ("let's discuss this in a separate chat"): the request reaches
  // the app through its socket, exactly as Companion's MCP server sends it.
  const parentJob = (await page.locator('.crumbs').innerText()).match(/claude attach ([0-9a-f]{8})/)?.[1];
  const parentId = readdirSync(join(claudeDir, 'sessions'))
    .map((f) => JSON.parse(readFileSync(join(claudeDir, 'sessions', f), 'utf8')))
    .find((r) => r.jobId === parentJob)?.sessionId;
  const reply = await new Promise((resolve) => {
    const c = createConnection(join(root, 'app.sock'), () =>
      c.write(`${JSON.stringify({ method: 'new_chat', params: { claudePid: 1, sessionId: parentId, title: 'Brainstorm caching', prompt: 'Let us brainstorm the caching idea.' } })}\n`),
    );
    let buf = '';
    c.on('data', (d) => (buf += d));
    c.on('end', () => resolve(JSON.parse(buf)));
  });
  check('the new-chat request succeeds', reply.ok === true);
  check('the app switches to the new chat', await until(async () => (await page.locator('.head h1').innerText()).includes('Brainstorm caching')));
  check('it starts on its opening message right away', await until(async () => (await thread()).includes('echo: Let us brainstorm the caching idea.')));
  check('…labelled as sent from Companion', (await thread()).includes('from Companion'));
  check('the new chat starts clean', !(await thread()).includes('echo: hello from the sheet'));
  check('it links back to where it came from', (await page.locator('.crumbs').innerText()).includes('from'));
  const childId = (await page.locator('.crumbs').innerText()).match(/claude attach ([0-9a-f]{8})/)?.[1];
  const childArgs = readdirSync(join(claudeDir, 'fake-args'))
    .filter((f) => f.startsWith(childId))
    .map((f) => JSON.parse(readFileSync(join(claudeDir, 'fake-args', f), 'utf8')))[0] ?? [];
  const hidden = childArgs[childArgs.indexOf('--append-system-prompt') + 1] ?? '';
  check('the earlier conversation is passed as hidden context', hidden.includes('echo: picking this back up') && childArgs.includes('--system-prompt-snapshot'));
  check('sessions get the new-chat tool', childArgs.includes('--mcp-config') && childArgs.includes('mcp__companion__start_new_chat'));
  await page.screenshot({ path: join(shots, '4-new-chat.png') });

  await page.locator('.from-link').click();
  check('the sidebar shows the new chat by its title', (await page.locator('.sessions').innerText()).includes('Brainstorm caching'));
  check('the original chat lists the new one', await until(async () => (await page.locator('.rail').innerText()).includes('Brainstorm caching')));

  // Context tools on the original chat: pin a file, compact with a focus, hand off.
  writeFileSync(join(project, 'notes.md'), 'design notes');
  await page.evaluate(([id, f]) => window.companion.pinFile(id, f), [parentId, join(project, 'notes.md')]);
  check('a pinned file shows in the panel', await until(async () => (await page.locator('.rail').innerText()).includes('notes.md')));
  await page.fill(`#compact-focus-${parentId}`, 'keep the API shape');
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  check('compact sends /compact with the focus and pinned files', await until(async () => (await thread()).includes('/compact keep the API shape Keep full details about these pinned files: notes.md')));
  await page.getByRole('button', { name: 'Hand off to a fresh session' }).click();
  check('hand off opens a fresh session from this one', await until(async () => (await page.locator('.head h1').innerText()).startsWith('Continued:')));
  check('…and starts on it right away', await until(async () => (await thread()).includes('echo: Let\'s pick up where we left off')));
  check('…and the pinned file carried over', await until(async () => (await page.locator('.rail').innerText()).includes('notes.md')));
  await page.screenshot({ path: join(shots, '5-context-tools.png') });

} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
} finally {
  await app.close().catch(() => app.process().kill());
  // Quitting Companion leaves background sessions running, as it should; stop the fake ones.
  const socks = join(claudeDir, 'fake-socks');
  for (const f of existsSync(socks) ? readdirSync(socks) : []) {
    await new Promise((r) => {
      const c = createConnection(join(socks, f), () => c.end('\x00STOP'));
      c.resume(); // read to the end, or 'close' never fires
      c.on('close', r);
      c.on('error', r);
      setTimeout(r, 2000);
    });
  }
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}`);
process.exit(failed.length ? 1 : 0);
