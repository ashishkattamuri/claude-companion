import { useCallback, useEffect, useState } from 'react';
import type { AuditFindingView, AuditState, AuditView } from '../../shared/api';
import { api } from './api';
import { shortPath, timeAgo } from './format';

/** A session's audit: what was wasted, why, and what to change so it doesn't happen again. */

export function useAudit(sessionId: string) {
  const [state, setState] = useState<AuditState | null>(null);
  const load = useCallback(() => void api.getAudit(sessionId).then(setState), [sessionId]);
  useEffect(() => {
    load();
    return api.onChanged(load);
  }, [load]);
  return { state, reload: load };
}

export function AuditPanel({
  state,
  onRun,
  onJump,
}: {
  state: AuditState | null;
  onRun: () => void;
  /** Shows a step in the conversation. */
  onJump: (itemId: string) => void;
}) {
  if (!state) return <div className="audit-view" />;
  const { audit, running, newSteps } = state;
  if (!audit)
    return (
      <div className="audit-view">
        <div className="empty">
          <h2>Audit this session</h2>
          <p className="muted">
            A second model reviews every step and tool call and flags what wasn't needed: repeated reads, dead-end trails, loops, failed calls, bloated output. Each
            finding comes with what it cost, the cause in your setup, and a fix.
          </p>
          {running ? <Running /> : <button className="btn primary" onClick={onRun}>Run audit…</button>}
        </div>
      </div>
    );

  const counted = audit.findings.filter((f) => f.status !== 'rejected');
  const rejected = audit.findings.filter((f) => f.status === 'rejected');
  return (
    <div className="audit-view">
      <div className="audit-inner">
        <div className="audit-head">
          <span className="muted small">
            {audit.model ? `Reviewed by ${cap(audit.model)}` : 'Detectors only'} · {timeAgo(audit.createdAt)} · covers {plural(audit.coversSteps, 'step')}
          </span>
          {running ? <Running /> : <button className="icon-btn" onClick={onRun}>Re-audit</button>}
        </div>
        {newSteps > 0 && !running && (
          <div className="notice warn">
            {newSteps} new step{newSteps === 1 ? '' : 's'} since this audit. Re-audit to include them.
          </div>
        )}
        {audit.reviewError && (
          <div className="notice warn">The review couldn't run ({audit.reviewError}). Showing what the detectors found; re-audit to try again.</div>
        )}

        <div className="audit-stats">
          <Stat label="Sent" value={audit.costUsd !== null ? usd(audit.costUsd) : `${tok(audit.tokens)} tokens`} sub={plural(audit.calls, 'model call')} />
          <Stat
            label="Wasted"
            value={amount(audit.wasted)}
            sub={`${pct(audit.wasted.share)} of the cost`}
            tone={audit.wasted.share >= 0.15 ? 'amber' : undefined}
          />
          {audit.leanCalls !== null ? (
            <Stat label="Lean path" value={`≈${plural(audit.leanCalls, 'call')}`} sub={`of ${audit.calls} made`} />
          ) : (
            audit.toReview && <Stat label="To review" value={amount(audit.toReview)} sub="likely, unconfirmed" />
          )}
        </div>

        {audit.summary && <p className="audit-summary">{audit.summary}</p>}

        {audit.topFixes.length > 0 && (
          <>
            <h3 className="section">Top fixes</h3>
            <ol className="audit-fixes">
              {audit.topFixes.map((t) => (
                <li key={t.fix}>
                  <span>{t.fix}</span>
                  <span className="muted small tabular">saves {amount(t)}</span>
                </li>
              ))}
            </ol>
          </>
        )}

        <h3 className="section">Findings{counted.length ? ` (${counted.length})` : ''}</h3>
        {counted.length === 0 && <p className="muted">No waste found.</p>}
        {counted.map((f) => (
          <Finding key={f.id} f={f} onJump={onJump} />
        ))}

        {rejected.length > 0 && (
          <details className="audit-rejected">
            <summary>Rejected by the review ({rejected.length})</summary>
            {rejected.map((f) => (
              <div key={f.id} className="audit-rej">
                <div>{f.title}</div>
                {f.reason && <div className="muted small">{f.reason}</div>}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}

function Finding({ f, onJump }: { f: AuditFindingView; onJump: (itemId: string) => void }) {
  const tag = f.status === 'new' ? 'found by review' : f.status === 'confirmed' ? 'confirmed' : f.confidence === 'low' ? 'unconfirmed' : null;
  return (
    <details className="finding">
      <summary>
        <span className="cat" title={f.categoryName}>
          {f.category}
        </span>
        <span className="finding-title">{f.title}</span>
        <span className="finding-cost tabular">{f.tokens > 0 ? amount(f) : ''}</span>
      </summary>
      <div className="finding-body">
        <div className="muted small">
          {f.categoryName}
          {tag && ` · ${tag}`}
        </div>
        {f.reason && <p>{f.reason}</p>}
        {f.fix && (
          <p>
            <b>Fix:</b> {f.fix}
            {f.cause && <span className="muted"> (cause: {f.cause})</span>}
          </p>
        )}
        {!f.fix && f.cause && <p className="muted">Likely cause: {f.cause}</p>}
        <div className="finding-steps">
          {f.steps.slice(0, 12).map((s) => (
            <button
              key={s.n}
              className="step-ref"
              disabled={!s.itemId}
              title={s.itemId ? 'Show in the conversation' : 'Inside a subagent: not shown in the conversation'}
              onClick={() => s.itemId && onJump(s.itemId)}
            >
              <span className="mono">#{s.n}</span> <span className="ellipsis">{s.label.replace(/\/Users\/[^/\s]+/g, (m) => shortPath(m))}</span>
            </button>
          ))}
          {f.steps.length > 12 && <span className="muted small">and {f.steps.length - 12} more</span>}
        </div>
      </div>
    </details>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'amber' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value tabular ${tone ?? ''}`}>{value}</div>
      <div className="muted small">{sub}</div>
    </div>
  );
}

function Running() {
  return (
    <span className="working">
      <span className="spinner" /> Auditing… usually a minute or two. You can keep working.
    </span>
  );
}

/** Dollars when the session's cost is known (API sessions), otherwise tokens. */
const amount = (a: { costUsd: number | null; tokens: number }) => (a.costUsd !== null ? usd(a.costUsd) : `~${tok(a.tokens)} tokens`);
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const pct = (n: number) => (n === 0 ? '0%' : `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export const wasteLabel = (a: Pick<AuditView['wasted'], 'share'>) => `${pct(a.share)} waste`;
