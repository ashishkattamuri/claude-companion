// Recorded live take of Companion against the real Claude CLI, in the demo project, on the user's
// own login. Clean Companion DB that sees only ~/workspace/acme. Frames from Electron's paint
// stream (2x) as <outDir>/frames/<ms>.jpg, screenshots in <outDir>/shots, MARK lines in log.txt.
// Copy this file, fill in the scenario, build the app (npm run build), then from the repo:
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron <copy>.mjs <outDir>
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.env.COMPANION_REPO ?? process.cwd();
const { _electron: electron } = createRequire(join(repo, 'package.json'))('playwright');

const out = process.argv[2];
if (!out) throw new Error('usage: take.mjs <outDir>');
const project = join(homedir(), 'workspace/acme/checkout-service');
const projectDir = join(homedir(), '.claude/projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
// What was there before the take: only what the take adds is deleted at the end.
const before = new Set(existsSync(projectDir) ? readdirSync(projectDir) : []);
mkdirSync(join(out, 'frames'), { recursive: true });
mkdirSync(join(out, 'shots'), { recursive: true });

const t0 = Date.now();
const log = (m) => {
  const line = `${Date.now()} ${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`;
  console.log(line);
  appendFileSync(join(out, 'log.txt'), `${line}\n`);
};
const mark = (k) => log(`MARK ${k}`);

const scratch = mkdtempSync(join(tmpdir(), 'companion-demo-'));
writeFileSync(join(scratch, 'config.toml'), `[sources]\nopt_out = ["/**", "!~/workspace/acme"]\n`);
// No Claude Code markers from this shell, and the built renderer rather than a dev server.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_ENV_ELECTRON_VITE)/.test(k)));
const env = {
  ...cleanEnv,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  COMPANION_CONFIG: join(scratch, 'config.toml'),
  COMPANION_DB: join(scratch, 'db.sqlite'),
  COMPANION_NO_ANALYSIS: '1',
  COMPANION_USER_DATA: join(scratch, 'user-data'),
};
const startedAt = Date.now();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 300000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return true;
    await pause(300);
  }
  return false;
};

const app = await electron.launch({ args: ['--force-device-scale-factor=2', repo], env });
const page = await app.firstWindow();
await app.evaluate(async ({ BrowserWindow, dialog }, project) => {
  BrowserWindow.getAllWindows()[0].setSize(1440, 900);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
}, project);
await pause(800);
await app.evaluate(({ BrowserWindow }, dir) => {
  const fs = process.mainModule.require('node:fs');
  const path = process.mainModule.require('node:path');
  BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(false, (image) => {
    fs.writeFile(path.join(dir, `${Date.now()}.jpg`), image.toJPEG(92), () => {});
  });
}, join(out, 'frames'));

const composer = page.locator('.composer textarea');
const head = () => page.locator('.head').innerText();
const answers = () => page.locator('.msg-wrap.answer').count();
const lastReply = () => page.locator('.a-text').last().innerText();
const shot = (name) => page.screenshot({ path: join(out, 'shots', `${name}.png`) });
/** Types like a person, so it reads on video. */
const type = async (loc, text, delay = 32) => {
  await loc.click();
  await loc.pressSequentially(text, { delay });
};
/** Waits until Claude has finished: the chat is Ready and the last reply has stopped changing. */
async function settled(minAnswers) {
  await until(async () => (await answers()) >= minAnswers && (await head()).includes('Ready'));
  let prev = '';
  for (let i = 0; i < 20; i++) {
    const cur = await lastReply().catch(() => '');
    if (cur && cur === prev && (await head()).includes('Ready')) break;
    prev = cur;
    await pause(700);
  }
}

try {
  await page.waitForSelector('.sidebar');
  mark('start');

  // ── Scenario: replace with the take's beats. ─────────────────────────────────────────────
  await page.keyboard.press('Meta+n');
  await pause(600);
  // The folder picker is stubbed to answer with the demo project (see showOpenDialog above).
  await page.getByRole('button', { name: 'Choose…' }).click();
  await pause(400);
  await page.selectOption('#ns-model', 'haiku'); // sonnet/opus when answer quality shows on screen
  await type(page.locator('#ns-prompt'), 'Where is the retry logic for payment webhooks?');
  mark('ask');
  await page.keyboard.press('Meta+Enter');
  await settled(1);
  mark('answered');
  await shot('answered');

  await type(composer, 'Explain the backoff in two sentences.');
  await composer.press('Enter');
  await settled(2);
  mark('followup');
  // ─────────────────────────────────────────────────────────────────────────────────────────

  await pause(1500);
  await shot('end');
  mark('end');
} catch (err) {
  log(`ERROR ${err?.stack ?? err}`);
  await shot('error').catch(() => {});
} finally {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.endFrameSubscription()).catch(() => {});
  await app.close().catch(() => app.process().kill());
  try {
    for (const a of JSON.parse(execFileSync('claude', ['agents', '--json'], { env: cleanEnv, encoding: 'utf8' })))
      if (a.kind === 'background' && String(a.cwd).startsWith(project) && a.startedAt >= startedAt) execFileSync('claude', ['stop', a.id], { env: cleanEnv, stdio: 'ignore' });
  } catch {}
  // The take's chats were only for the recording. A stopping session writes to its transcript
  // once more, so wait for that first.
  await pause(5000);
  const made = (existsSync(projectDir) ? readdirSync(projectDir) : []).filter((f) => !before.has(f));
  log(`created in ~/.claude/projects: ${made.join(', ') || 'nothing'}`);
  for (const f of made) rmSync(join(projectDir, f), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  log('done');
}
process.exit(0);
