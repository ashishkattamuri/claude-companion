import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import { readLiveSessions } from '../ingest/live.js';
import { scan } from '../ingest/scanner.js';
import type { DB } from '../store/db.js';
import { digestCandidates, digestSession } from './digest.js';
import { LlmError, type LlmClient } from './llm.js';
import { activeSessions, generateRecap, recapNeeded, recapWindow } from './recap.js';

export interface AnalyzerStatus {
  state: 'running' | 'idle' | 'error' | 'paused';
  step?: string;
  done?: number;
  total?: number;
  error?: string;
  updatedAt: string;
}

export interface RunOptions {
  forceRecap?: boolean;
  endedSessionIds?: string[];
  now?: number;
  chunkChars?: number;
}

export interface RunResult {
  ran: boolean;
  digested: number;
  llmCalls: number;
  recapWritten: boolean;
}

export function readStatus(db: DB): AnalyzerStatus | null {
  const row = db.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key = 'analyzer_status'`).get();
  return row ? JSON.parse(row.value) : null;
}

/** Like `readStatus`, but a "running" left behind by a crashed run reads as idle. */
export function currentStatus(db: DB, cfg: Config): AnalyzerStatus | null {
  const status = readStatus(db);
  if (status?.state !== 'running') return status;
  let pid = 0;
  try {
    pid = Number(readFileSync(lockPath(cfg), 'utf8'));
  } catch {}
  return pid && isAlive(pid) ? status : { state: 'idle', updatedAt: status.updatedAt };
}

function writeStatus(db: DB, s: Omit<AnalyzerStatus, 'updatedAt'>) {
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('analyzer_status', ?)`).run(
    JSON.stringify({ ...s, updatedAt: new Date().toISOString() }),
  );
}

/** True when opening the TUI should kick off a background run. */
export function analysisNeeded(db: DB, cfg: Config, now = Date.now()): boolean {
  if (recapNeeded(db, cfg, now)) return true;
  const live = new Set(readLiveSessions(cfg.claudeDir).map((l) => l.sessionId));
  return digestCandidates(db, cfg, { now, liveSessionIds: live }).length > 0;
}

/**
 * Scan, then bring session summaries up to date, then write today's recap if it's missing.
 * Only one run happens at a time; a second caller returns immediately.
 */
export async function runJobs(db: DB, cfg: Config, llm: LlmClient, opts: RunOptions = {}): Promise<RunResult> {
  const result: RunResult = { ran: false, digested: 0, llmCalls: 0, recapWritten: false };
  const lock = acquireLock(lockPath(cfg));
  if (!lock) return result;
  result.ran = true;
  const now = opts.now ?? Date.now();

  try {
    writeStatus(db, { state: 'running', step: 'scanning' });
    scan(db, cfg);

    const live = new Set(readLiveSessions(cfg.claudeDir).map((l) => l.sessionId));
    const candidates = digestCandidates(db, cfg, {
      now,
      liveSessionIds: live,
      endedSessionIds: new Set(opts.endedSessionIds ?? []),
    });
    // Summaries the recap needs come first, so a small budget still produces a good recap.
    const window = recapWindow(db, cfg, now);
    const needed = new Set(window ? activeSessions(db, window.start, window.end) : []);
    candidates.sort((a, b) => Number(needed.has(b.id)) - Number(needed.has(a.id)));

    const budget = cfg.limits.max_llm_calls_per_run;
    for (const [i, s] of candidates.entries()) {
      if (result.llmCalls >= budget) break;
      writeStatus(db, { state: 'running', step: 'summarising sessions', done: i, total: candidates.length });
      result.llmCalls += await digestSession(db, cfg, llm, s, { now, chunkChars: opts.chunkChars });
      result.digested++;
    }

    if ((opts.forceRecap || recapNeeded(db, cfg, now)) && result.llmCalls < budget) {
      writeStatus(db, { state: 'running', step: 'writing recap' });
      result.recapWritten = await generateRecap(db, cfg, llm, now);
      if (result.recapWritten) result.llmCalls++;
    }
    writeStatus(db, { state: 'idle' });
  } catch (err) {
    const rateLimited = err instanceof LlmError && err.rateLimited;
    writeStatus(db, {
      state: rateLimited ? 'paused' : 'error',
      error: rateLimited ? 'Paused: Claude usage limit reached. Will retry on the next run.' : (err as Error).message,
    });
    throw err;
  } finally {
    lock.release();
  }
  return result;
}

/** Starts `companion run-jobs` in the background, detached from the terminal. Output goes to a log file. */
export function spawnDetachedRun(cfg: Config, extraArgs: string[] = []): void {
  const dataDir = dirname(cfg.dbPath);
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, 'analyzer.log'), 'a');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'run-jobs', ...extraArgs], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
}

export const lockPath = (cfg: Config) => join(dirname(cfg.dbPath), 'analyzer.lock');

function acquireLock(path: string): { release: () => void } | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return { release: () => unlinkSync(path) };
    } catch {
      // Held by a live process: back off. Left behind by a dead one: clear it and retry.
      let pid = 0;
      try {
        pid = Number(readFileSync(path, 'utf8'));
      } catch {}
      if (pid && isAlive(pid)) return null;
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
