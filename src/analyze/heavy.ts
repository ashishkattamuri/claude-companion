/**
 * The tool results taking up the most room in a chat's context right now: everything since the last
 * compaction, biggest first. Built on the audit's timeline, so the token estimates match the audit's
 * (each result's share of the prompt growth it caused), but needs no model call.
 */
import { describe } from './audit/detectors.js';
import type { Timeline } from './audit/timeline.js';
import type { AuditView } from './audit/view.js';

export interface HeavyItem {
  /** The conversation item to jump to. */
  itemId: string;
  label: string;
  /** Estimated tokens the result takes up. */
  tokens: number;
  /** Model calls it has been sent with so far. */
  calls: number;
  /** Messages you've sent since. */
  turnsAgo: number;
  /** The audit's fix, when the audit flagged this step. */
  fix: string | null;
}

/** Smaller results aren't worth listing. */
const MIN_TOKENS = 1_000;

export function heaviest(tl: Timeline, audit: AuditView | null = null, n = 5): HeavyItem[] {
  const since = tl.compactions.length ? Math.max(...tl.compactions) : -1;
  const lastTurn = tl.messages.at(-1)?.turn ?? 0;
  const fixes = new Map<string, string>();
  for (const f of audit?.findings ?? [])
    if (f.fix && f.status !== 'rejected') for (const s of f.steps) if (s.itemId && !fixes.has(s.itemId)) fixes.set(s.itemId, f.fix);
  return tl.steps
    .filter((s) => s.agent === null && s.result && s.result.firstCall !== null && s.result.firstCall >= since && s.result.tokens >= MIN_TOKENS)
    .sort((a, b) => b.result!.tokens - a.result!.tokens)
    .slice(0, n)
    .map((s) => ({
      itemId: s.id,
      // Paths as Claude sees them from the project folder, as in the rest of the rail.
      label: s.cwd ? describe(s).split(`${s.cwd}/`).join('') : describe(s),
      tokens: s.result!.tokens,
      calls: s.result!.sent,
      turnsAgo: Math.max(0, lastTurn - s.turn),
      fix: fixes.get(s.id) ?? null,
    }));
}
