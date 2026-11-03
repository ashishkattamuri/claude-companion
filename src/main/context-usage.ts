import { spawn } from 'node:child_process';
import type { ContextBreakdown } from '../shared/api.js';

/** "3.3k" → 3300, "1m" → 1_000_000, "607" → 607. */
function tokens(s: string): number | null {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim());
  if (!m) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const n = Number(m[1]) * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Reads the category table of Claude Code's `/context` report. Deferred tools are listed there but
 * aren't loaded into the context, so they're left out; free space is what's left of the window.
 * Returns null when the report isn't in the expected shape.
 */
export function parseContextReport(md: string): ContextBreakdown | null {
  const start = md.search(/^#+\s*Estimated usage by category/im);
  if (start < 0) return null;
  const categories: { name: string; tokens: number }[] = [];
  let autocompact = 0;
  for (const line of md.slice(start).split('\n').slice(1)) {
    if (/^#/.test(line.trim())) break; // next section
    const cells = line.split('|').map((c) => c.trim());
    const [, name = '', raw = ''] = cells;
    if (cells.length < 4 || /^-+$/.test(name) || name === 'Category') continue;
    const n = tokens(raw);
    if (n === null || /deferred/i.test(name) || /^free space$/i.test(name)) continue;
    if (/^autocompact buffer$/i.test(name)) autocompact = n;
    else categories.push({ name, tokens: n });
  }
  return categories.length ? { categories, autocompact } : null;
}

export interface ContextUsageDeps {
  claudeBin: string;
  env: () => Record<string, string>;
  /** Called when a session's breakdown changes. */
  onChanged: () => void;
  timeoutMs?: number;
}

/**
 * A session's context breakdown, from `claude -p /context` on a fork of the session. That runs
 * locally (no model call) and with --no-session-persistence writes no transcript at all. One run
 * per session at a time; a refresh asked for meanwhile runs once the current one finishes.
 */
export class ContextUsage {
  private latest = new Map<string, ContextBreakdown>();
  private running = new Set<string>();
  private again = new Set<string>();
  private tried = new Set<string>();

  constructor(private d: ContextUsageDeps) {}

  /** The last breakdown read for a session; starts a first read when there's none yet. */
  get(sessionId: string, cwd: string | null): ContextBreakdown | null {
    const hit = this.latest.get(sessionId);
    if (!hit && cwd && !this.tried.has(sessionId)) {
      this.tried.add(sessionId); // a failed first read waits for the next turn instead of retrying on every redraw
      this.refresh(sessionId, cwd);
    }
    return hit ?? null;
  }

  refresh(sessionId: string, cwd: string): void {
    if (!/^[\w-]+$/.test(sessionId)) return;
    if (this.running.has(sessionId)) {
      this.again.add(sessionId);
      return;
    }
    this.running.add(sessionId);
    void this.read(sessionId, cwd)
      .then((b) => {
        if (b) {
          this.latest.set(sessionId, b);
          this.d.onChanged();
        }
      })
      .finally(() => {
        this.running.delete(sessionId);
        if (this.again.delete(sessionId)) this.refresh(sessionId, cwd);
      });
  }

  private read(sessionId: string, cwd: string): Promise<ContextBreakdown | null> {
    return new Promise((resolve) => {
      let out = '';
      let proc;
      try {
        proc = spawn(
          this.d.claudeBin,
          // A live background session can't be resumed elsewhere, but a fork of it can. Nothing is saved.
          ['-p', '/context', '--resume', sessionId, '--fork-session', '--no-session-persistence', '--output-format', 'json'],
          { cwd, env: this.d.env(), stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch {
        return resolve(null);
      }
      const timer = setTimeout(() => proc.kill('SIGTERM'), this.d.timeoutMs ?? 60_000);
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('error', () => resolve(null));
      proc.on('close', () => {
        clearTimeout(timer);
        try {
          const r = JSON.parse(out) as { is_error?: boolean; result?: string };
          resolve(!r.is_error && typeof r.result === 'string' ? parseContextReport(r.result) : null);
        } catch {
          resolve(null);
        }
      });
    });
  }
}
