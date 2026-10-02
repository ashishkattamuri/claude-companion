// A stand-in for the `claude` CLI, for end-to-end tests that cost nothing and need no login.
// It does what Companion relies on: registers in <claude dir>/sessions/<pid>.json, appends to the
// session transcript, takes input typed into its terminal, and shows a numbered permission menu.
// Prompts containing "needs-approval" ask for permission before "running" a command.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const claudeDir = process.env.FAKE_CLAUDE_DIR;
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
const initialPrompt = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const cwd = process.cwd();

const transcript = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
mkdirSync(join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
const registry = join(claudeDir, 'sessions', `${process.pid}.json`);
mkdirSync(join(claudeDir, 'sessions'), { recursive: true });

let last = null;
const record = (rec) => {
  const uuid = randomUUID();
  appendFileSync(transcript, `${JSON.stringify({ uuid, parentUuid: last, sessionId, cwd, timestamp: new Date().toISOString(), ...rec })}\n`);
  last = uuid;
};
const status = (s, waitingFor) => writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId, cwd, status: s, waitingFor }));
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pending = null; // a permission request waiting for a key

async function handle(prompt) {
  record({ type: 'user', message: { role: 'user', content: prompt } });
  out(`\n> ${prompt}\n`);
  status('busy');
  await sleep(150);
  if (prompt.includes('needs-approval')) {
    const toolId = `toolu_${randomUUID().slice(0, 8)}`;
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake-1', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'touch approved.txt', description: 'Create a marker file' } }] } });
    out('\n Bash command\n Create a marker file\n\n touch approved.txt\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again\n   3. No\n\n Esc to cancel\n');
    status('waiting', 'permission prompt');
    pending = toolId;
    return;
  }
  reply(`echo: ${prompt}`);
}

function reply(text) {
  record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake-1', content: [{ type: 'text', text }] } });
  out(`\n⏺ ${text}\n\n❯ `);
  status('idle');
}

function answer(key) {
  const toolId = pending;
  pending = null;
  // Clear the dialog the way the real CLI redraws over it.
  out('\x1b[2J\x1b[H');
  if (key === '3') {
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'User rejected', is_error: true }] } });
    return reply('Okay, I will not run it.');
  }
  writeFileSync(join(cwd, 'approved.txt'), '');
  record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: '' }] } });
  reply('Created approved.txt.');
}

// Input arrives raw from the pseudo-terminal: bracketed pastes, typed characters, Enter.
let line = '';
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const text = chunk.replace(/\x1b\[200~|\x1b\[201~/g, '');
  for (const ch of text) {
    if (pending && /[123]/.test(ch)) return answer(ch);
    if (ch === '\r' || ch === '\n') {
      const prompt = line.trim();
      line = '';
      if (prompt) void handle(prompt);
    } else if (ch === '\x03') {
      cleanup();
    } else if (ch === '\x7f') {
      line = line.slice(0, -1);
    } else {
      line += ch;
      out(ch);
    }
  }
});

function cleanup() {
  rmSync(registry, { force: true });
  process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);

out(`Fake Claude Code · session ${sessionId}\n\n❯ `);
record({ type: 'permission-mode', permissionMode: 'default' });
status('idle');
if (initialPrompt) void handle(initialPrompt);
