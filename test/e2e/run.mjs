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
// Two old experiments, to clean up from the sidebar.
const OLD = ['aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-00000000000b'];
for (const [i, id] of OLD.entries())
  writeFileSync(
    join(fixtureDir, `${id}.jsonl`),
    readFileSync(join(fixtureDir, `${SESSION}.jsonl`), 'utf8').replaceAll(SESSION, id).replaceAll('Webhook retry logic', `Old experiment ${'AB'[i]}`),
  );

// The project is a GitHub repository, and Claude Code has one MCP server Companion has no use for.
// Installing the (fake) GitHub plugin brings a fake GitHub MCP server.
{
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/acme/demo-app.git']);
}
writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { notes: { type: 'stdio', command: 'true', args: [] } } }));

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
  FAKE_GITHUB_SERVER: join(repo, 'test/fixtures/fake-github-mcp-server.mjs'),
  FAKE_GH_LOG: join(root, 'gh-calls.log'),
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

  // Side chats: a question about a message, answered in a fork of the chat. The thread shows only
  // that message, and the chat's own transcript never changes.
  {
    const parentFile = join(fixtureDir, `${SESSION}.jsonl`);
    const before = readFileSync(parentFile, 'utf8');
    const message = page.locator('.msg-wrap.user').first();
    await message.hover();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shots, '1a-side-hover.png'), clip: { x: 268, y: 60, width: 900, height: 260 } });
    await message.locator('.side-ask').click();
    const panel = page.locator('.side-panel');
    const anchorText = await message.locator('.u-text').innerText();
    check('side chat opens on the message it replies to', await until(async () => (await panel.locator('.side-anchor').innerText()).includes(anchorText.slice(0, 40))));
    check('side chat shows only that message, not the rest of the chat', !(await panel.innerText()).includes('Also add a test for exponential backoff'));
    await panel.locator('textarea').fill('slow-side what was the retry limit?');
    await panel.locator('textarea').press('Enter');
    check('side chat shows what Claude is doing while it answers', await until(async () => (await panel.innerText()).includes('Read notes.md')));
    check(
      'side chat answers from the whole chat',
      await until(async () => (await panel.innerText()).includes('side: slow-side what was the retry limit? (the chat began with "Add retry logic'), 8000),
    );
    check('side chat shows how much came from the cache', (await panel.locator('.side-usage').innerText()).includes('18k from cache'));
    const sideArgs = () =>
      readdirSync(join(claudeDir, 'fake-args'))
        .filter((f) => f.startsWith('side-'))
        .map((f) => [f.slice(5, -5), JSON.parse(readFileSync(join(claudeDir, 'fake-args', f), 'utf8'))]);
    const [forkId, args] = sideArgs()[0] ?? [];
    check('side chat runs in a fork of the chat', !!args && args.includes('--fork-session') && args[args.indexOf('--resume') + 1] === SESSION);
    check("the chat's own transcript is untouched", readFileSync(parentFile, 'utf8') === before);
    check('the message shows a reply badge', await until(async () => (await page.locator('.convo .side-badge').innerText()).includes('1 reply')));
    await panel.locator('textarea').fill('and how long between tries?');
    await panel.locator('textarea').press('Enter');
    check('a follow-up continues the same thread', await until(async () => (await panel.innerText()).includes('side: and how long between tries?')));
    const follow = sideArgs().find(([id]) => id === forkId)?.[1];
    check('a follow-up resumes the fork instead of forking again', !!follow && !follow.includes('--fork-session') && follow[follow.indexOf('--resume') + 1] === forkId);
    await page.screenshot({ path: join(shots, '1b-side-chat.png') });
    // The tick that rescans transcripts runs every 5s.
    await new Promise((r) => setTimeout(r, 6000));
    check('the fork is not listed as a chat', (await page.locator('.s-row', { hasText: 'Webhook retry logic' }).count()) === 1);
    await panel.locator('.side-head button', { hasText: 'Delete' }).click();
    check('deleting the thread deletes its fork', await until(async () => !existsSync(join(fixtureDir, `${forkId}.jsonl`))));
    await page.locator('.side-head button[aria-label^="Close"]').click();
  }

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

  // A slash command that opens a menu Companion can't read (/plugin): shown as drawn, driven by keys.
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await composer.fill('/plugin');
  await composer.press('Enter');
  const menuCard = page.locator('.menu-card');
  check('a menu Companion cannot read is shown as drawn', await until(async () => (await menuCard.locator('.menu-screen').innerText()).includes('❯ Browse and install plugins')));
  await composer.fill('after the menu');
  await composer.press('Enter');
  check('…and says messages wait until it closes', await until(async () => (await menuCard.innerText()).includes('1 message will send once the menu is closed')));
  await page.screenshot({ path: join(shots, '3b-menu.png') });
  await menuCard.getByRole('button', { name: 'Down' }).click();
  check('arrow keys move through it', await until(async () => (await menuCard.locator('.menu-screen').innerText()).includes('❯ Manage installed plugins')));
  await menuCard.getByRole('button', { name: 'Esc · close' }).click();
  check('Esc closes it and the chat no longer needs you', await until(async () => (await menuCard.count()) === 0 && !(await status()).includes('Needs you')));
  check('the message typed meanwhile is sent after', await until(async () => (await thread()).includes('echo: after the menu')));
  await composer.fill('/plugin');
  await composer.press('Enter');
  await until(async () => (await menuCard.count()) === 1);
  await menuCard.getByRole('button', { name: 'Open terminal' }).click();
  check('"Open terminal" shows the terminal next to it', await until(async () => (await page.locator('.term-pane').count()) === 1));
  await menuCard.getByRole('button', { name: 'Enter' }).click();
  check('Enter picks the highlighted item', await until(async () => (await page.locator('.term-pane .xterm-rows').innerText()).includes('(chose: Browse and install plugins)')));
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();

  await page.getByRole('button', { name: 'End', exact: true }).click();
  check('ending the session stops it', await until(async () => (await status()).includes('Not running')));

  // Several messages in quick succession (e.g. sent again because nothing seemed to happen) while
  // the chat is still starting up: they all go to the same session, and all of them show.
  for (const text of ['picking this back up', 'are you there?', 'hello?']) {
    await composer.fill(text);
    await composer.press('Enter');
  }
  check('sending to an ended session continues it', await until(async () => (await thread()).includes('echo: picking this back up')));
  check('messages sent while it starts up all show, with replies', await until(async () => (await thread()).includes('echo: are you there?') && (await thread()).includes('echo: hello?')));
  check('…and it is resumed once, not as extra empty sessions', readdirSync(join(claudeDir, 'sessions')).length === 1);
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
  check('…and the earlier-conversation search, pre-approved', childArgs.includes('mcp__companion__search_earlier_conversation') && hidden.includes('search_earlier_conversation'));

  // The new chat looks up a detail in the chat it came from, as Companion's MCP server asks.
  const childSession = readdirSync(join(claudeDir, 'sessions'))
    .map((f) => JSON.parse(readFileSync(join(claudeDir, 'sessions', f), 'utf8')))
    .find((r) => r.jobId === childId)?.sessionId;
  const ask = (sessionId, params) =>
    new Promise((resolve) => {
      const c = createConnection(join(root, 'app.sock'), () => c.write(`${JSON.stringify({ method: 'search_earlier', params: { claudePid: 1, sessionId, ...params } })}\n`));
      let buf = '';
      c.on('data', (d) => (buf += d));
      c.on('end', () => resolve(JSON.parse(buf)));
    });
  const found = await ask(childSession, { query: 'typed in iTerm' });
  check('a new chat can search the chat it came from', found.ok && found.message.includes('echo: typed in iTerm') && found.message.includes('the parent chat'));
  const outline = await ask(childSession, {});
  check('…or get an outline of it', outline.ok && /Turn \d+ · #\d+/.test(outline.message));
  const refused = await ask(parentId, { query: 'anything' });
  check('a chat not opened from another has nothing to search', !refused.ok && refused.error.includes('not opened from another chat'));
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

  // Cleaning up the sidebar: hide a chat and bring it back, then delete two together.
  const row = (title) => page.locator('.s-row', { hasText: title });
  await row('Old experiment A').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide' }).click();
  check('a hidden chat leaves the sidebar', await until(async () => (await row('Old experiment A').count()) === 0));
  await page.getByRole('button', { name: 'Show hidden (1)' }).click();
  check('"Show hidden" lists it again, marked hidden', await until(async () => (await row('Old experiment A').innerText()).includes('hidden')));
  await row('Old experiment A').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in sidebar' }).click();
  check('it can be shown again', await until(async () => (await page.getByRole('button', { name: /Show hidden/ }).count()) === 0 && (await row('Old experiment A').count()) === 1));

  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); // confirm "Delete"
  });
  await row('Old experiment A').click({ modifiers: ['Meta'] });
  await row('Old experiment B').click({ modifiers: ['Meta'] });
  check('⌘-click picks several chats', (await page.locator('.picked-bar').innerText()).includes('2 selected'));
  await page.screenshot({ path: join(shots, '6-picked.png') });
  await page.locator('.picked-bar').getByRole('button', { name: 'Delete…' }).click();
  check('deleting them removes both from the sidebar', await until(async () => (await row('Old experiment').count()) === 0));
  check('…and deletes their transcripts', OLD.every((id) => !existsSync(join(fixtureDir, `${id}.jsonl`))));
  await new Promise((r) => setTimeout(r, 5500)); // the next background scan
  check('…and they stay gone after a rescan', (await row('Old experiment').count()) === 0 && (await row('Webhook retry logic').count()) === 1);

  // Auditing a session for wasted steps: from the row's menu, reviewed by the (fake) model.
  await row('Webhook retry logic').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Audit…' }).click();
  const audit = page.locator('.audit-view');
  check('"Audit…" opens the chat on its Audit tab and runs an audit', await until(async () => (await audit.innerText()).includes('Looked up the webhook handler')));
  check('…showing the summary and the top fix', (await audit.innerText()).includes('One avoidable lookup.') && (await audit.innerText()).includes('Pin src/webhook.ts'));
  check('the sidebar row shows its waste', await until(async () => (await row('Webhook retry logic').innerText()).includes('waste')));
  check('…and so does the header', (await page.locator('.audit-pill').count()) === 1);
  await audit.locator('.finding summary').first().click();
  await page.screenshot({ path: join(shots, '6b-audit.png') });
  await audit.locator('.step-ref').first().click();
  check('a finding\'s step opens in the conversation, highlighted', await until(async () => (await page.locator('.tool.focused').count()) === 1));

  // Connectors: Claude Code's /plugin as a page.
  await app.evaluate(({ dialog }) => {
    globalThis.dialogs = [];
    dialog.showMessageBox = async (_w, o) => (globalThis.dialogs.push(o.message), { response: 0, checkboxChecked: false }); // confirm
  });
  const dialogs = () => app.evaluate(() => globalThis.dialogs);
  const nav = (label) => page.locator('.nav button', { hasText: label }).click();
  const cards = page.locator('.plugin-card');
  const card = (name) => page.locator('.plugin-card', { has: page.locator('.plugin-name', { hasText: new RegExp(`^${name}$`) }) });
  const sheet = page.locator('.plugin-sheet');
  const tab = (label) => page.getByRole('tab', { name: new RegExp(`^${label}`) }).click();
  const fakeState = () => JSON.parse(readFileSync(join(claudeDir, 'fake-plugins.json'), 'utf8'));
  const claudeServers = () => Object.keys(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers ?? {});

  await nav('Today');
  const offer = page.locator('.offer');
  check('Today offers GitHub for the recap', await until(async () => (await offer.innerText()).includes('GitHub plugin')));
  await offer.getByRole('button', { name: 'Find the GitHub plugin' }).click();
  check('…which opens Connectors searching for it', await until(async () => (await card('github').count()) === 1) && (await page.getByLabel('Search plugins').inputValue()) === 'github');
  await page.getByLabel('Search plugins').fill('');
  check('Discover shows the catalog as a grid, a page at a time', await until(async () => (await cards.count()) === 60));
  await page.screenshot({ path: join(shots, '7-connectors.png') });
  await page.getByRole('button', { name: /Show more/ }).click();
  check('…with more on request', await until(async () => (await cards.count()) === 74));

  await page.getByLabel('Search plugins').fill('modern');
  check('search narrows the grid', await until(async () => (await cards.count()) === 1));
  await card('code-modernization').getByRole('button', { name: 'Install' }).click();
  check('installing from a card installs it in Claude Code', await until(async () => (await card('code-modernization').innerText()).includes('Installed')) && !!fakeState().installed['code-modernization@anthropic-plugin-directory']);
  await card('code-modernization').click();
  check('its page shows what it adds', await until(async () => (await sheet.locator('.plugin-details').innerText()).includes('Component inventory')));
  await sheet.locator('select').first().selectOption('uplift');
  await sheet.getByRole('button', { name: 'Save options' }).click();
  check('options are saved through claude plugin configure', await until(async () => fakeState().installed['code-modernization@anthropic-plugin-directory'].config.track === 'uplift'));
  await page.screenshot({ path: join(shots, '8-plugin.png') });
  await sheet.getByRole('button', { name: 'Disable' }).click();
  check('it can be disabled', await until(async () => fakeState().installed['code-modernization@anthropic-plugin-directory'].enabled === false));
  await sheet.getByRole('button', { name: 'Enable' }).click();
  check('…and enabled again', await until(async () => fakeState().installed['code-modernization@anthropic-plugin-directory'].enabled === true));
  await sheet.getByRole('button', { name: 'Uninstall…' }).click();
  check('uninstalling asks first, then removes it', await until(async () => !fakeState().installed['code-modernization@anthropic-plugin-directory']) && (await dialogs()).some((m) => m.startsWith('Uninstall code-modernization')));
  await sheet.getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Search plugins').fill('runs-a-command');
  await card('runs-a-command').getByRole('button', { name: 'Install' }).click();
  check('a plugin that installs by running a command shows it before running it', await until(async () => !!fakeState().installed['runs-a-command@anthropic-plugin-directory']) && (await dialogs()).some((m) => m.includes('installs by running a command')));

  await page.getByLabel('Search plugins').fill('github');
  await card('github').getByRole('button', { name: 'Install' }).click();
  await until(async () => (await card('github').innerText()).includes('Installed'));
  await tab('Installed');
  check('Installed lists what is installed', await until(async () => (await cards.count()) === 1) && (await card('github').count()) === 1);
  await page.getByLabel('Search plugins').fill('');
  await until(async () => (await cards.count()) === 2);
  await tab('MCP servers');
  const ghServer = page.locator('.server-row', { hasText: 'plugin:github:github' });
  check("the GitHub plugin's MCP server is listed with Claude Code's own servers", await until(async () => (await ghServer.count()) === 1) && (await page.locator('.server-row', { hasText: 'notes' }).count()) === 1);
  await ghServer.getByRole('button', { name: 'Use in morning recap' }).click();
  check('…and can feed the morning recap, read-only', await until(async () => (await ghServer.innerText()).includes('Signed in as @octo')) && readFileSync(join(root, 'gh-calls.log'), 'utf8').split('\n').filter(Boolean).every((l) => JSON.parse(l).tool === 'get_me'));

  await page.getByLabel('Server name').fill('docs');
  await page.getByLabel('Server URL or command').fill('https://example.com/mcp');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  check('an MCP server can be added to Claude Code', await until(async () => claudeServers().includes('docs')));
  await page.locator('.server-row', { hasText: 'docs' }).getByRole('button', { name: 'Remove…' }).click();
  check('…and removed', await until(async () => !claudeServers().includes('docs')) && claudeServers().includes('notes'));

  await tab('Marketplaces');
  await page.getByLabel('Marketplace source').fill('acme/plugins');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const acme = page.locator('.server-row', { hasText: 'acme-plugins' });
  check('a marketplace can be added', await until(async () => (await acme.count()) === 1));
  await tab('Discover');
  await page.getByLabel('Search plugins').fill('acme');
  check("…and its plugins show in Discover", await until(async () => (await card('acme-plugins-lint').count()) === 1));
  await tab('Marketplaces');
  await acme.getByRole('button', { name: 'Remove…' }).click();
  check('…and removed, after asking', await until(async () => (await acme.count()) === 0) && (await dialogs()).some((m) => m.includes('acme-plugins marketplace')));

  await nav('Today');
  check('Today stops offering GitHub once it feeds the recap', await until(async () => (await offer.count()) === 0));

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
