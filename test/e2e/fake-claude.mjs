// A stand-in for the `claude` CLI, for end-to-end tests that cost nothing and need no login.
// It mirrors what Companion relies on from Claude Code background sessions:
//   fake --bg [--resume <id>] [prompt]   start a session daemon, print "backgrounded · <job>"
//   fake attach <job>                    connect this terminal; every attached terminal shares it
//   fake stop <job>                      end the session
// The daemon registers in <claude dir>/sessions/<pid>.json (kind "bg"), appends to the transcript,
// and shows a numbered permission menu for prompts containing "needs-approval".
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const claudeDir = process.env.FAKE_CLAUDE_DIR;
const socketFor = (job) => join(claudeDir, 'fake-socks', `${job}.sock`);
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === '--bg') startDaemon(rest);
else if (cmd === 'mcp') mcp(rest);
else if (cmd === 'attach') attach(rest[0]);
else if (cmd === 'stop') stop(rest[0]);
else if (cmd === '__daemon') runDaemon(rest);
else {
  console.error(`fake claude: unsupported arguments: ${process.argv.slice(2).join(' ')}`);
  process.exit(2);
}

// `claude mcp add|get|remove`, enough for the user-scope registration.
function mcp([sub, ...args]) {
  const file = join(claudeDir, 'fake-mcp.json');
  const servers = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  // The name is the first argument that isn't an option or an option's value.
  const name = args.find((a, i) => !a.startsWith('-') && !['--scope', '-s', '-e', '--env'].includes(args[i - 1]));
  if (sub === 'add') servers[name] = args;
  if (sub === 'remove') delete servers[args.at(-1)];
  if (sub === 'get' && !servers[args[0]]) {
    console.error(`No MCP server named "${args[0]}".`);
    process.exit(1);
  }
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(file, JSON.stringify(servers));
}

function startDaemon(args) {
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  // Like Claude Code: resuming a session with extra flags starts a copy, under a new id.
  const copy = resume && args.length > 2;
  const sessionId = copy ? randomUUID() : (resume ?? randomUUID());
  if (copy) {
    const dir = join(claudeDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
    const from = join(dir, `${resume}.jsonl`);
    if (existsSync(from)) writeFileSync(join(dir, `${sessionId}.jsonl`), readFileSync(from, 'utf8').replaceAll(resume, sessionId));
    console.log(`note: started a copy of that conversation as ${sessionId.slice(0, 8)}.`);
  }
  const job = sessionId.slice(0, 8);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', sessionId, ...args], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`backgrounded · ${job}`);
}

function attach(job) {
  const sock = createConnection(socketFor(job));
  sock.on('error', () => {
    console.error(`No job matching '${job}'.`);
    process.exit(1);
  });
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', (d) => sock.write(d));
  sock.on('data', (d) => process.stdout.write(d));
  sock.on('close', () => process.exit(0));
}

function stop(job) {
  const sock = createConnection(socketFor(job), () => sock.end('\x00STOP'));
  sock.on('error', () => process.exit(0));
  sock.on('close', () => process.exit(0));
}

function runDaemon([sessionId, ...args]) {
  const job = sessionId.slice(0, 8);
  // Parse options the way the real CLI does: --allowedTools takes every value up to the next
  // option, so a prompt right after it is swallowed unless `--` ends the options.
  const oneValue = new Set(['--model', '--permission-mode', '--resume', '--mcp-config', '--system-prompt-snapshot', '--append-system-prompt']);
  let initialPrompt;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      initialPrompt = args[i + 1];
      break;
    }
    if (oneValue.has(a)) i++;
    else if (a === '--allowedTools') while (args[i + 1] && !args[i + 1].startsWith('-')) i++;
    else if (!a.startsWith('-')) initialPrompt = a;
  }
  // Tests check what a session was started with (e.g. the hidden context of a new chat).
  mkdirSync(join(claudeDir, 'fake-args'), { recursive: true });
  writeFileSync(join(claudeDir, 'fake-args', `${sessionId}.json`), JSON.stringify(args));
  const cwd = process.cwd();
  const projectDir = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  const registry = join(claudeDir, 'sessions', `${process.pid}.json`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  mkdirSync(join(claudeDir, 'fake-socks'), { recursive: true });

  const clients = new Set();
  let screen = '';
  const out = (s) => {
    const text = s.replace(/\n/g, '\r\n');
    screen += text;
    for (const c of clients) c.write(text);
  };
  let last = null;
  const record = (rec) => {
    const uuid = randomUUID();
    appendFileSync(transcript, `${JSON.stringify({ uuid, parentUuid: last, sessionId, cwd, timestamp: new Date().toISOString(), ...rec })}\n`);
    last = uuid;
  };
  const status = (s, waitingFor) =>
    writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId, cwd, kind: 'bg', jobId: job, status: s, waitingFor }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let pending = null;
  let line = '';

  // Like Claude Code, list the session's tools on its first turn: Companion's tool is there only
  // when the session was started with Companion's MCP config, or it's registered for all sessions.
  let listedTools = false;
  const hasTool = args.includes('--mcp-config') || existsSync(join(claudeDir, 'fake-mcp.json')) && readFileSync(join(claudeDir, 'fake-mcp.json'), 'utf8').includes('companion');
  async function handle(prompt) {
    if (!listedTools) {
      listedTools = true;
      record({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['WebSearch', ...(hasTool ? ['mcp__companion__start_new_chat'] : [])], removedNames: [] } });
    }
    record({ type: 'user', message: { role: 'user', content: prompt } });
    out(`\n> ${prompt}\n`);
    status('busy');
    await sleep(150);
    if (prompt.includes('needs-approval')) {
      pending = `toolu_${randomUUID().slice(0, 8)}`;
      record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake-1', content: [{ type: 'tool_use', id: pending, name: 'Bash', input: { command: 'touch approved.txt', description: 'Create a marker file' } }] } });
      out("\n Bash command\n Create a marker file\n\n touch approved.txt\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel\n");
      // Like Claude Code, the registry says "waiting" a moment after the dialog is drawn.
      const id = pending;
      setTimeout(() => pending === id && status('waiting', 'permission prompt'), 1200);
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
    out('\x1b[2J\x1b[H'); // the real CLI redraws over the dialog
    if (key === '3') {
      record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'User rejected', is_error: true }] } });
      return reply('Okay, I will not run it.');
    }
    writeFileSync(join(cwd, 'approved.txt'), '');
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: '' }] } });
    reply('Created approved.txt.');
  }
  function input(chunk) {
    if (chunk.includes('\x00STOP')) return shutdown();
    for (const ch of chunk.replace(/\x1b\[200~|\x1b\[201~/g, '')) {
      if (pending && /[123]/.test(ch)) return answer(ch);
      if (ch === '\r' || ch === '\n') {
        const prompt = line.trim();
        line = '';
        if (prompt) void handle(prompt);
      } else if (ch === '\x7f') line = line.slice(0, -1);
      else if (ch >= ' ') {
        line += ch;
        out(ch);
      }
    }
  }
  function shutdown() {
    rmSync(registry, { force: true });
    rmSync(socketFor(job), { force: true });
    for (const c of clients) c.end();
    process.exit(0);
  }

  rmSync(socketFor(job), { force: true });
  createServer((c) => {
    clients.add(c);
    c.setEncoding('utf8');
    c.write(screen); // a newly attached terminal sees the session as it is
    c.on('data', input);
    c.on('close', () => clients.delete(c));
    c.on('error', () => clients.delete(c));
  }).listen(socketFor(job));
  process.on('SIGTERM', shutdown);

  out(`Fake Claude Code · session ${sessionId}\n\n❯ `);
  if (!args.includes('--resume')) record({ type: 'permission-mode', permissionMode: 'default' });
  status('idle');
  // A real session's Companion MCP server says hello once Claude Code has connected to it.
  if (hasTool && process.env.COMPANION_SOCKET) {
    setTimeout(() => {
      const c = createConnection(process.env.COMPANION_SOCKET, () => c.end(`${JSON.stringify({ method: 'hello', params: { claudePid: process.pid, sessionId } })}\n`));
      c.on('error', () => {});
    }, 300);
  }
  if (initialPrompt) void handle(initialPrompt);
}
