// Live check of what side chats rely on from the real Claude Code CLI (Haiku; a few cents): a fork
// of a chat (`-p --resume <chat> --fork-session --session-id <id>`) knows the chat, leaves its
// transcript untouched, reads the chat's history from the prompt cache, and can be continued.
// Runs in a sandbox (see sandbox.mjs): needs CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
// Usage: npm run test:live-side
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveSandbox } from './sandbox.mjs';

const sandbox = liveSandbox('side');
const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const MODEL = 'claude-haiku-5-5';
const claude = (args, prompt) =>
  execFileSync('claude', ['-p', '--model', MODEL, ...args], { cwd: sandbox.project, env: sandbox.claudeEnv, input: prompt, encoding: 'utf8', timeout: 180_000 });
/** The stream-json events of a run, as Companion reads them. */
const events = (out) => out.trim().split('\n').flatMap((l) => {
  try {
    return [JSON.parse(l)];
  } catch {
    return [];
  }
});
const findTranscript = (id) => {
  const projects = join(sandbox.claudeDir, 'projects');
  for (const d of readdirSync(projects)) if (readdirSync(join(projects, d)).includes(`${id}.jsonl`)) return join(projects, d, `${id}.jsonl`);
  return null;
};

try {
  const chat = randomUUID();
  claude(['--session-id', chat], 'Remember this code word for later: ORCA-7. Reply with just OK.');
  const parentFile = findTranscript(chat);
  check('the chat has a transcript', !!parentFile);
  const before = readFileSync(parentFile, 'utf8');

  const fork = randomUUID();
  const first = events(
    claude(['--resume', chat, '--fork-session', '--session-id', fork, '--output-format', 'stream-json', '--verbose'], 'Side question: what was the code word? Reply with just the word.'),
  );
  const result = first.find((e) => e.type === 'result');
  check('the fork runs under the id Companion gave it', first.find((e) => e.type === 'system')?.session_id === fork);
  check('the fork knows the chat', /ORCA-7/.test(result?.result ?? ''));
  check("the chat's transcript is untouched", readFileSync(parentFile, 'utf8') === before);
  const u = result?.usage ?? {};
  console.log(`  usage: ${u.cache_read_input_tokens} cached, ${u.input_tokens} fresh, ${u.cache_creation_input_tokens} written to cache, ${u.output_tokens} out`);
  check("the chat's history comes from the prompt cache", (u.cache_read_input_tokens ?? 0) > (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));

  const next = events(claude(['--resume', fork, '--output-format', 'stream-json', '--verbose'], 'And spelled backwards? Reply with just that.'));
  check('a follow-up continues the fork', /7-ACRO/i.test(next.find((e) => e.type === 'result')?.result ?? ''));
  check('…without touching the chat', readFileSync(parentFile, 'utf8') === before);
} catch (err) {
  console.error(err);
  checks.push(['no exceptions', false]);
} finally {
  const leaked = sandbox.cleanup();
  check('nothing leaked into ~/.claude', leaked.length === 0);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
