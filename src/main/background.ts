import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code background sessions (`claude --bg`) are kept running by Claude Code itself, and any
 * number of terminals can attach to one with `claude attach <id>`. Input from every attached
 * terminal is a real message in the same session. Companion attaches its terminal pane the same
 * way, so a session can be driven from Companion and from iTerm at the same time.
 */

export interface BackgroundEntry {
  pid: number;
  sessionId: string;
  jobId: string;
  status: string | null;
  waitingFor: string | null;
}

interface Deps {
  claudeBin: string;
  claudeDir: string;
  env: () => Record<string, string>;
}

/** A running background session, by its short job id or full session id. */
export function findBackground(claudeDir: string, id: string, ignorePid?: number): BackgroundEntry | null {
  let files: string[];
  try {
    files = readdirSync(join(claudeDir, 'sessions')).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(claudeDir, 'sessions', f), 'utf8'));
      if (r.kind !== 'bg' || (r.jobId !== id && r.sessionId !== id) || r.pid === ignorePid || !isAlive(r.pid)) continue;
      return { pid: r.pid, sessionId: r.sessionId, jobId: r.jobId, status: r.status ?? null, waitingFor: r.waitingFor ?? null };
    } catch {
      // A registry file being rewritten; the next poll reads it.
    }
  }
  return null;
}

/** Reads one entry by pid: cheaper than scanning, for polling a session we already know. */
export function readBackground(claudeDir: string, pid: number): BackgroundEntry | null {
  try {
    const r = JSON.parse(readFileSync(join(claudeDir, 'sessions', `${pid}.json`), 'utf8'));
    if (!isAlive(pid)) return null;
    return { pid, sessionId: r.sessionId, jobId: r.jobId, status: r.status ?? null, waitingFor: r.waitingFor ?? null };
  } catch {
    return null;
  }
}

/**
 * Runs `claude --bg <args>` and waits for the session to register. `--bg` picks the session id
 * itself (it ignores --session-id), so the id is read back from the registry.
 */
export async function startBackground(deps: Deps, cwd: string, args: string[]): Promise<BackgroundEntry> {
  // When resuming, a process that is still shutting down can briefly share the id; skip it.
  const resumeId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const stale = resumeId ? findBackground(deps.claudeDir, resumeId)?.pid : undefined;
  const out = await new Promise<string>((resolve, reject) => {
    execFile(deps.claudeBin, ['--bg', ...args], { cwd, env: deps.env(), timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split('\n')[0]));
      else resolve(`${stdout}\n${stderr}`);
    });
  });
  const jobId = stripAnsi(out).match(/backgrounded\s*·\s*([0-9a-f]{6,})/i)?.[1];
  if (!jobId) throw new Error(`Unexpected reply from claude --bg: ${stripAnsi(out).trim().slice(0, 200)}`);
  for (let i = 0; i < 100; i++) {
    const entry = findBackground(deps.claudeDir, jobId, stale);
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Background session ${jobId} did not start.`);
}

/** Runs `claude stop` and waits until the session's process has actually exited. */
export async function stopBackground(deps: Deps, jobId: string): Promise<void> {
  const pid = findBackground(deps.claudeDir, jobId)?.pid;
  await new Promise<void>((resolve) => {
    execFile(deps.claudeBin, ['stop', jobId], { env: deps.env(), timeout: 15_000 }, () => resolve());
  });
  for (let i = 0; pid && isAlive(pid) && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
