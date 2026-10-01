import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  name: string | null;
  version: string | null;
}

/**
 * Running sessions from Claude Code's registry at `~/.claude/sessions/<pid>.json` (undocumented).
 * Entries outlive crashed processes and PIDs get reused, so an entry only counts as live when the
 * PID exists and its start time matches `procStart` (which Claude Code writes in UTC).
 */
export function readLiveSessions(claudeDir: string): LiveSession[] {
  const dir = join(claudeDir, 'sessions');
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        return typeof j.pid === 'number' && typeof j.sessionId === 'string' ? [j] : [];
      } catch {
        return [];
      }
    });
  if (!entries.length) return [];
  const starts = processStartTimes(entries.map((e) => e.pid));
  return entries
    .filter((e) => {
      const started = starts.get(e.pid);
      return started !== undefined && (!e.procStart || squash(e.procStart) === started);
    })
    .map((e) => ({
      pid: e.pid,
      sessionId: e.sessionId,
      cwd: e.cwd ?? '',
      status: e.status ?? 'unknown',
      name: e.name ?? null,
      version: e.version ?? null,
    }));
}

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');

function processStartTimes(pids: number[]): Map<number, string> {
  const map = new Map<number, string>();
  let out = '';
  try {
    out = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
  } catch (err) {
    // ps exits 1 when some PIDs are gone but still prints the rest.
    out = (err as { stdout?: string }).stdout ?? '';
  }
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), squash(m[2]!));
  }
  return map;
}
