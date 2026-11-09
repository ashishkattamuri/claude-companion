// Live check of the context and cache features against the real Claude Code CLI (Haiku; a few cents).
// Runs in a sandbox (see sandbox.mjs) on your own login: its own project folder and Companion DB,
// and every chat it starts is stopped and deleted at the end.
//
// Usage: npm run build && npm run test:live-context [-- --record <dir> [--from <issue>]]
//   --record <dir>   also records the window (Electron's paint stream) and writes <dir>/demo.mp4 and demo.gif
//   --from <issue>   start the recording at that issue's section (33, 34, …); every section still runs
// Screenshots: test/e2e/screenshots/context-*.png
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { liveSandbox } from './sandbox.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const shots = join(repo, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const recordAt = process.argv.indexOf('--record');
const record = recordAt > 0 ? process.argv[recordAt + 1] : null;
const fromAt = process.argv.indexOf('--from');
const recordFrom = fromAt > 0 ? process.argv[fromAt + 1] : '33';

const sandbox = liveSandbox('context');
const project = sandbox.project;

// Something worth reading, so the chat's context is the size of real work (well over 30k tokens).
const areas = ['checkout', 'payments', 'webhooks', 'retries', 'invoices', 'refunds', 'search', 'auth'];
const changelog = ['# Changelog', ''];
for (let v = 240; v > 0; v--) {
  changelog.push(`## 1.${Math.floor(v / 10)}.${v % 10}`, '');
  for (let i = 0; i < 5; i++) {
    const a = areas[(v * 7 + i * 3) % areas.length];
    changelog.push(`- ${a}: ${v === 37 && i === 0 ? 'first retry policy for failed payment webhooks (exponential backoff, 5 attempts)' : `tidy ${a} handler ${v}.${i}, update tests and docs for the ${a} module`}`);
  }
  changelog.push('');
}
writeFileSync(join(project, 'CHANGELOG.md'), changelog.join('\n'));

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 120000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return true;
    await pause(300);
  }
  return false;
};
let recording = false;
/** On a recording, lingers so a viewer can read the screen. */
const beat = (ms = 1500) => (recording ? pause(ms) : Promise.resolve());

const app = await electron.launch({ args: [...(record ? ['--force-device-scale-factor=2'] : []), repo], env: sandbox.appEnv });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
const frames = record ? join(record, 'frames') : null;
/** Each issue's section starts here; the recording starts at the --from section. */
async function section(issue) {
  console.log(`── #${issue}`);
  if (!frames || recording || issue !== recordFrom) return;
  recording = true;
  mkdirSync(frames, { recursive: true });
  await app.evaluate(({ BrowserWindow }, dir) => {
    const fs = process.mainModule.require('node:fs');
    const path = process.mainModule.require('node:path');
    BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(false, (image) => {
      fs.writeFile(path.join(dir, `${Date.now()}.jpg`), image.toJPEG(90), () => {});
    });
  }, frames);
  await pause(1000);
}

const shot = (name) => page.screenshot({ path: join(shots, `context-${name}.png`) });
const composer = page.locator('.composer textarea');
const head = () => page.locator('.head').innerText();
const answers = () => page.locator('.msg-wrap.answer').count();
const lastReply = () => page.locator('.a-text').last().innerText();
const type = async (loc, text) => {
  await loc.click();
  if (recording) await loc.pressSequentially(text, { delay: 28 });
  else await loc.fill(text);
};
/** Claude has finished: the chat is Ready and the last reply has stopped changing. */
async function settled(minAnswers) {
  await until(async () => (await answers()) >= minAnswers && (await head()).includes('Ready'), 180000);
  let prev = '';
  for (let i = 0; i < 20; i++) {
    const cur = await lastReply().catch(() => '');
    if (cur && cur === prev && (await head()).includes('Ready')) break;
    prev = cur;
    await pause(700);
  }
}
const cacheLine = () => page.locator('.cache-line').innerText();

try {
  await page.waitForSelector('.sidebar');

  // ── #33 Cache timer ────────────────────────────────────────────────────────────────────────
  await section('33');
  await page.keyboard.press('Meta+n');
  await page.selectOption('#ns-project', project);
  await page.selectOption('#ns-model', 'haiku');
  await type(page.locator('#ns-prompt'), 'Read CHANGELOG.md in full, then tell me in one sentence what the latest release changed.');
  await beat(600);
  await page.keyboard.press('Meta+Enter');
  await settled(1);
  check('the rail shows the cache as warm after the first reply', await until(async () => /Cache warm · .*left/.test(await cacheLine()), 30000));
  const ctx = Number((await page.locator('.rail-big .muted').innerText()).match(/^([\d.]+)k/)?.[1] ?? 0) * 1000;
  check(`the chat is big enough for the cold-cache note (${Math.round(ctx / 1000)}k tokens)`, ctx >= 30000);
  await beat(2500);
  await shot('33-warm');

  await type(composer, 'Which release first added a retry policy for payment webhooks? One line.');
  await composer.press('Enter');
  await settled(2);
  const ratio = Number((await cacheLine()).match(/(\d+)% of its input from the cache/)?.[1] ?? -1);
  check(`the follow-up read most of the chat from the cache (${ratio}%)`, ratio >= 50);
  await page.locator('.cache-line').hover();
  await beat(3000);
  await shot('33-warm-followup');

  // Two hours later: the cache has expired. Only the window's clock moves; the chat is untouched.
  await page.clock.install();
  await page.clock.fastForward('02:00:00');
  check('the rail shows the cache as expired', await until(async () => /Cache expired 1 h ago/.test(await cacheLine()), 30000));
  check('a note above the composer warns that the next message reprocesses the chat', await until(() => page.locator('.cold-note').isVisible(), 10000));
  check('the note gives the size of the chat', /~\d+k tokens/.test(await page.locator('.cold-note').innerText()));
  await page.locator('.cold-note').scrollIntoViewIfNeeded();
  await beat(3500);
  await shot('33-expired');
  await page.getByRole('button', { name: 'Send here anyway' }).click();
  check('"Send here anyway" dismisses the note', await until(async () => !(await page.locator('.cold-note').isVisible()), 5000));
  await beat(1500);
  // Back to the real time for the sections that follow.
  await page.clock.setSystemTime(Date.now());

  // ── #34 Explain cache misses ───────────────────────────────────────────────────────────────
  // A real miss: switching models mid-chat, since each model has its own cache.
  await section('34');
  await type(composer, '/model sonnet');
  await composer.press('Enter');
  // Claude Code asks first, since the switch re-reads the whole history; Companion shows the question.
  const yes = page.getByRole('button', { name: /Yes, switch to Sonnet/ });
  check('Claude Code asks before switching models', await until(() => yes.isVisible(), 30000));
  await beat(2500);
  await yes.click();
  check('Claude Code runs /model', await until(async () => /Ran \/model|Set model to/i.test(await page.locator('.thread').innerText()), 30000));
  await beat(1000);
  await type(composer, 'Without running any tools, from what you already read: what did release 1.3.7 add? One line.');
  await composer.press('Enter');
  // If Claude still asks to run something, let it.
  await until(async () => {
    if ((await page.locator('.approval .actions button').count()) > 0) {
      await page.locator('.approval .actions button').first().click();
      await until(async () => (await page.locator('.approval').count()) === 0, 15000);
    }
    return (await answers()) >= 3 && (await head()).includes('Ready');
  }, 180000);
  await settled(3);
  const miss = page.locator('.cache-miss').last();
  check('the reply after the switch is marked as a cache miss', await until(() => miss.isVisible(), 20000));
  const missText = await miss.innerText().catch(() => '');
  console.log(`   ${missText}`);
  check('the marker names the model switch as the cause', /The model changed \(Haiku [\d.]+ → Sonnet [\d.]+\)/.test(missText));
  check('the marker gives how much was processed again', /~\d+k tokens processed again/.test(missText));
  check('earlier turns that read the cache are not marked', (await page.locator('.cache-miss').count()) === 1);
  await miss.scrollIntoViewIfNeeded();
  await miss.hover();
  await beat(4000);
  await shot('34-model-miss');

  // ── #35 Compaction history ─────────────────────────────────────────────────────────────────
  await section('35');
  await type(page.locator('.rail-input'), 'Keep the release numbers we found');
  await beat(800);
  await page.locator('.rail').getByRole('button', { name: 'Compact', exact: true }).click();
  const marker = page.locator('.compaction').last();
  check('a compaction marker appears in the conversation', await until(() => marker.isVisible(), 240000));
  await marker.scrollIntoViewIfNeeded();
  const markerText = await marker.innerText();
  console.log(`   ${markerText.replace(/\n/g, ' | ')}`);
  check('it shows the size before and after', /Compacted \d+k → \d+k tokens/.test(markerText));
  check('it says you started it', /by you/.test(markerText));
  const kept = marker.getByRole('button', { name: 'What Claude kept' });
  check('the summary Claude kept can be opened', await until(() => kept.isVisible(), 60000));
  check('the rail counts the compaction', /Compacted once/.test(await page.locator('.rail').innerText()));
  const after = Number(markerText.match(/→ (\d+)k/)?.[1]);
  check('the rail headline shows the compacted size', (await page.locator('.rail-big .muted').innerText()).startsWith(`${after}k`));
  await beat(2000);
  await kept.click();
  const summaryText = await page.locator('.compaction-summary').innerText().catch(() => '');
  check('the summary is the one Claude works from (it mentions the changelog)', /changelog/i.test(summaryText));
  check('the summary keeps the focus you gave (release 1.3.7)', /1\.3\.7/.test(summaryText));
  await page.locator('.compaction-summary').hover();
  await beat(2500);
  await page.mouse.wheel(0, 500);
  await beat(2500);
  await shot('35-compaction');

  // ── #36 Heaviest in context ────────────────────────────────────────────────────────────────
  await section('36');
  // New tool output after the compaction: the list only counts what's in the context now.
  await type(composer, 'Read the first 800 lines of CHANGELOG.md, then run `grep -c retries CHANGELOG.md`, then tell me the count in one line.');
  await composer.press('Enter');
  await until(async () => {
    if ((await page.locator('.approval .actions button').count()) > 0) {
      await page.locator('.approval .actions button').first().click();
      await until(async () => (await page.locator('.approval').count()) === 0, 15000);
    }
    return (await answers()) >= 4 && (await head()).includes('Ready');
  }, 240000);
  await settled(4);
  const rows = page.locator('.heavy-row');
  check('the rail lists the heaviest results in the context', await until(async () => (await rows.count()) > 0, 30000));
  const heavyText = await page.locator('.heavy').innerText().catch(() => '');
  console.log(`   ${heavyText.replace(/\n/g, ' | ')}`);
  check('the changelog read is on top, with its size', /^Read [^\n]*CHANGELOG\.md[^\n]*\n~\d+(\.\d)?k/.test(await rows.first().innerText()));
  check('reads from before the compaction are left out', (await rows.count()) <= 2);
  await page.locator('.heavy').scrollIntoViewIfNeeded();
  await page.locator('.heavy').hover();
  await beat(3000);
  await shot('36-heavy');
  await rows.first().click();
  check('clicking one shows it in the conversation', await until(() => page.locator('.tool.focused').isVisible(), 10000));
  await beat(2500);
  await page.locator('.rail').getByRole('button', { name: 'Compact without these…' }).click();
  const focusValue = await page.locator('.rail-input').inputValue();
  check('"Compact without these" fills in the compacting focus', /drop their raw output: Read [^;]*CHANGELOG\.md/.test(focusValue));
  await beat(3500);
  await shot('36-compact-focus');
} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
  await shot('error').catch(() => {});
} finally {
  if (frames) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.endFrameSubscription()).catch(() => {});
  await app.close().catch(() => app.process().kill());
  if (sandbox.cleanup().length) checks.push(['no sessions left behind in ~/.claude', false]);
}

if (frames) {
  // The paint stream only sends a frame when something changes: hold each one until the next,
  // but no longer than 1.2s, so waits for Claude don't drag.
  const files = readdirSync(frames).filter((f) => f.endsWith('.jpg')).sort((a, b) => parseInt(a) - parseInt(b));
  const list = files.map((f, i) => `file '${join(frames, f)}'\nduration ${Math.min(1.2, ((parseInt(files[i + 1] ?? f) - parseInt(f)) / 1000) || 0.04).toFixed(3)}`);
  writeFileSync(join(record, 'frames.txt'), `${list.join('\n')}\nfile '${join(frames, files.at(-1))}'\n`);
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
  ff('-f', 'concat', '-safe', '0', '-i', join(record, 'frames.txt'), '-vf', 'scale=1440:-2,fps=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', join(record, 'demo.mp4'));
  ff('-i', join(record, 'demo.mp4'), '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', join(record, 'demo.gif'));
  console.log(`Recording: ${record}/demo.mp4, ${record}/demo.gif`);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots: ${shots}/context-*.png`);
process.exit(failed.length ? 1 : 0);
