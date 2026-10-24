import { category } from './categories.js';
import { describe, type AuditReport, type Finding } from './detectors.js';
import type { Review, ReviewedFinding } from './review.js';
import type { Timeline } from './timeline.js';

/**
 * An audit as the window shows it: built once when the audit runs and stored, so opening the Audit
 * tab doesn't re-read the transcript. Steps carry the conversation view's item ids to jump to.
 */

export interface AuditStepRef {
  /** Step number, as the review cites it (#N). */
  n: number;
  /** The conversation item to jump to; null for steps inside a subagent. */
  itemId: string | null;
  label: string;
}

export interface AuditFindingView {
  id: string;
  category: string;
  categoryName: string;
  status: 'confirmed' | 'rejected' | 'unreviewed' | 'new';
  confidence: Finding['confidence'];
  title: string;
  reason: string | null;
  cause: string | null;
  fix: string | null;
  tokens: number;
  /** Share of the session's weighted cost. */
  share: number;
  costUsd: number | null;
  steps: AuditStepRef[];
}

export interface AuditView {
  sessionId: string;
  createdAt: string;
  /** The reviewing model, or null when only the detectors ran. */
  model: string | null;
  /** Why the review didn't run, when it didn't. */
  reviewError: string | null;
  /** Tool calls in the main conversation when the audit ran; later ones aren't covered. */
  coversSteps: number;
  calls: number;
  tokens: number;
  costUsd: number | null;
  wasted: { tokens: number; share: number; costUsd: number | null };
  /** Waste the detectors flagged but couldn't confirm (shown before a review only). */
  toReview: { tokens: number; share: number; costUsd: number | null } | null;
  leanCalls: number | null;
  summary: string;
  topFixes: { fix: string; findings: string[]; tokens: number; share: number; costUsd: number | null }[];
  findings: AuditFindingView[];
}

export function buildAuditView(
  tl: Timeline,
  report: AuditReport,
  review: Review | null,
  opts: { createdAt: string; reviewError?: string | null },
): AuditView {
  const share = (w: number) => (report.weighted ? w / report.weighted : 0);
  const usd = (w: number) => (report.costUsd !== null ? report.costUsd * share(w) : null);
  const findings: (Finding & Partial<ReviewedFinding>)[] = review ? review.findings : report.findings.map((f, i) => ({ ...f, id: `F${i + 1}` }));
  const known = (id: string) => {
    try {
      return category(id).name;
    } catch {
      return 'Other';
    }
  };
  const wasted = review ? review.wasted : report.wasted;
  return {
    sessionId: tl.sessionId,
    createdAt: opts.createdAt,
    model: review?.model ?? null,
    reviewError: opts.reviewError ?? null,
    coversSteps: tl.steps.filter((s) => s.agent === null).length,
    calls: report.calls,
    tokens: report.tokens,
    costUsd: report.costUsd,
    wasted: { tokens: wasted.tokens, share: wasted.share, costUsd: wasted.costUsd },
    toReview: review ? null : { tokens: report.toReview.tokens, share: report.toReview.share, costUsd: report.toReview.costUsd },
    leanCalls: review?.leanCalls ?? null,
    summary: review?.summary ?? '',
    topFixes: (review?.topFixes ?? []).map((t) => ({ ...t, share: share(t.weighted), costUsd: usd(t.weighted) })),
    findings: findings.map((f) => ({
      id: f.id!,
      category: f.category,
      categoryName: known(f.category),
      status: f.status ?? 'unreviewed',
      confidence: f.confidence,
      title: f.title,
      reason: f.reason ?? null,
      cause: f.cause ?? null,
      fix: f.fix ?? null,
      tokens: f.tokens,
      share: share(f.weighted),
      costUsd: usd(f.weighted),
      steps: f.steps.map((i) => {
        const s = tl.steps[i]!;
        return { n: i + 1, itemId: s.agent === null ? s.id : null, label: describe(s) };
      }),
    })),
  };
}
