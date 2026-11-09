// Live check of the context and cache features against the real Claude Code CLI (Haiku; a few cents).
// Runs in a sandbox (see sandbox.mjs) on your own login: its own project folder and Companion DB,
// and every chat it starts is stopped and deleted at the end.
//
// Usage: npm run build && npm run test:live-context [-- --record <dir>]
//   --record <dir>  also records the window (Electron's paint stream) and writes <dir>/demo.mp4 and demo.gif
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
/** On a recording, lingers so a viewer can read the screen. */
const beat = (ms = 1500) => (record ? pause(ms) : Promise.resolve());

const app = await electron.launch({ args: [...(record ? ['--force-device-scale-factor=2'] : []), repo], env: sandbox.appEnv });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
const frames = record ? join(record, 'frames') : null;
if (frames) {
  mkdirSync(frames, { recursive: true });
  await pause(800);
  await app.evaluate(({ BrowserWindow }, dir) => {
    const fs = process.mainModule.require('node:fs');
    const path = process.mainModule.require('node:path');
    BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(false, (image) => {
      fs.writeFile(path.join(dir, `${Date.now()}.jpg`), image.toJPEG(90), () => {});
    });
  }, frames);
}

const shot = (name) => page.screenshot({ path: join(shots, `context-${name}.png`) });
const composer = page.locator('.composer textarea');
const head = () => page.locator('.head').innerText();
const answers = () => page.locator('.msg-wrap.answer').count();
const lastReply = () => page.locator('.a-text').last().innerText();
const type = async (loc, text) => {
  await loc.click();
  if (record) await loc.pressSequentially(text, { delay: 28 });
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
