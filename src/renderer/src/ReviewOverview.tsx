import { useState } from 'react';
import type { ReviewBehavior, ReviewFile, ReviewView } from '../../shared/api';
import { api } from './api';
import { clip, firstSentence, Stat, type ReviewProps } from './ReviewPanel';
import { combined, verifyLabel } from './ReviewVerify';

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;
const RISK_LABEL = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' } as const;

/**
 * The changes at a glance: what you asked for against what was implemented, then the changes grouped
 * by behavior with their risk, files and evidence. The grouping and risks are a model's reading of the
 * diff and are labelled as such; test evidence and your acknowledgements are recorded facts.
 */
export function ReviewOverviewPane({
  sessionId,
  view,
  onJump,
  onDraft,
  onRetry,
  onShowFile,
}: ReviewProps & { view: ReviewView; onShowFile: (path: string, hunk?: number) => void }) {
  const { overview, files, requests } = view;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const reqText = new Map(requests.map((r) => [r.id, r.text]));
  const behaviors = [...(overview?.behaviors ?? [])].sort((a, b) => (a.risk ? RISK_ORDER[a.risk] : 3) - (b.risk ? RISK_ORDER[b.risk] : 3));
  const top = behaviors.find((b) => b.risk === 'high') ?? behaviors.find((b) => b.risk === 'medium') ?? null;
  const tests = combined(files.map((f) => f.verification));
  const inferredBy = overview?.model ? `Inferred by ${overview.model} from the diff and your requests` : 'From the file’s own explanation';

  return (
    <div className="review-pane overview">
      <div className="ov-glance" role="list">
        <Glance label="Changed" value={`${files.length} ${files.length === 1 ? 'file' : 'files'}`} sub={<Stat added={files.reduce((n, f) => n + f.added, 0)} removed={files.reduce((n, f) => n + f.removed, 0)} />} />
        <Glance
          label="Tests"
          value={verifyLabel(tests).label}
          tone={verifyLabel(tests).tone}
          sub={view.tests.length ? `${view.tests.length} ${view.tests.length === 1 ? 'run' : 'runs'} recorded` : 'none ran'}
        />
        <Glance
          label="Highest risk"
          value={top?.risk ? RISK_LABEL[top.risk] : overview ? 'None flagged' : view.overviewing ? 'Judging…' : 'Not judged'}
          tone={top?.risk === 'high' ? 'red' : top?.risk === 'medium' ? 'amber' : 'muted'}
          sub={top ? top.title : overview?.model ? 'inferred' : undefined}
        />
        <Glance
          label="Reviewed"
          value={`${files.filter((f) => f.review.state === 'reviewed').length} of ${files.length}`}
          sub={files.some((f) => f.review.state === 'changed') ? `${files.filter((f) => f.review.state === 'changed').length} changed since` : 'files you marked'}
        />
      </div>

      {view.overviewStale && !view.overviewing && (
        <p className="ov-banner">
          This overview was written before the latest changes.{' '}
          <button className="link" onClick={() => void api.refreshOverview(sessionId)}>
            Update it
          </button>
        </p>
      )}
      {view.overviewing && <p className="ov-banner muted">{overview ? 'Updating the overview…' : 'Grouping the changes by behavior…'}</p>}
      {view.overviewError && !view.overviewing && (
        <p className="ov-banner warn">
          Couldn't write the overview: {view.overviewError}{' '}
          <button className="link" onClick={() => void api.refreshOverview(sessionId)}>
            Try again
          </button>
        </p>
      )}
      {view.error && !view.explaining && (
        <p className="ov-banner warn">
          Couldn't write the explanations: {view.error}{' '}
          <button className="link" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}

      <section className="ov-intent" aria-label="What you asked and what was implemented">
        <div className="ov-col">
          <h3>You asked</h3>
          {requests.length === 0 ? (
            <p className="muted">No request was recorded for these edits.</p>
          ) : (
            <ol className="ov-asks">
              {requests.map((r) => (
                <li key={r.id}>
                  <span className="ov-ask">{clip(r.text.replace(/\s+/g, ' '), 260)}</span>
                  <button className="link small" onClick={() => onJump(r.id)}>
                    Show in chat
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="ov-arrow" aria-hidden="true">
          →
        </div>
        <div className="ov-col">
          <h3>What was implemented</h3>
          {overview?.implemented ? (
            <>
              <p>{overview.implemented}</p>
              <p className="ov-src small">{inferredBy}</p>
            </>
          ) : (
            <p className="muted">{view.overviewing || view.explaining ? 'Reading the changes…' : 'Not summarised yet.'}</p>
          )}
          {overview && overview.deviations.length > 0 && (
            <div className="ov-dev">
              <h4>Possible differences from the request · inferred</h4>
              <ul>
                {overview.deviations.map((d, i) => (
                  <li key={i}>
                    {d.text}
                    {d.requestIds[0] && (
                      <>
                        {' '}
                        <button className="link small" onClick={() => onJump(d.requestIds[0]!)}>
                          The request
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section aria-label="Changes by behavior">
        <h3 className="ov-h">Changes by behavior</h3>
        {behaviors.length === 0 && <p className="muted">{view.overviewing ? 'Grouping…' : 'No grouping yet. Explore shows every file.'}</p>}
        <div className="ov-cards">
          {behaviors.map((b, i) => (
            <BehaviorCard
              key={b.id}
              b={b}
              files={b.files.map((p) => byPath.get(p)).filter((f): f is ReviewFile => !!f)}
              requestText={(id) => reqText.get(id) ?? null}
              understood={view.understood[b.id] ?? null}
              inferred={!!overview?.model}
              openByDefault={i === 0}
              onUnderstood={(on) => void api.markUnderstood(sessionId, b.id, on)}
              onShowFile={onShowFile}
              onJump={onJump}
              onDraft={onDraft}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Glance({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="ov-tile" role="listitem">
      <span className="ov-tile-label">{label}</span>
      <span className={`ov-tile-value ${tone ?? ''}`}>{value}</span>
      {sub && <span className="ov-tile-sub small muted">{sub}</span>}
    </div>
  );
}

function BehaviorCard({
  b,
  files,
  requestText,
  understood,
  inferred,
  openByDefault,
  onUnderstood,
  onShowFile,
  onJump,
  onDraft,
}: {
  b: ReviewBehavior;
  files: ReviewFile[];
  requestText: (id: string) => string | null;
  understood: { at: string; changed: boolean } | null;
  inferred: boolean;
  openByDefault: boolean;
  onUnderstood: (on: boolean) => void;
  onShowFile: (path: string) => void;
  onJump: (id: string) => void;
  onDraft: (text: string) => void;
}) {
  const [open, setOpen] = useState(openByDefault);
  const state = combined(files.map((f) => f.verification));
  const v = verifyLabel(state);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const id = `beh-${b.id}`;
  return (
    <article className={`ov-card ${open ? 'open' : ''}`} aria-labelledby={`${id}-t`}>
      <button className="ov-card-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="ov-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="ov-card-title" id={`${id}-t`}>
          {b.title}
        </span>
        {b.risk && (
          <span className={`risk ${b.risk}`} title={b.riskReason ?? undefined}>
            <span aria-hidden="true">{b.risk === 'high' ? '▲' : b.risk === 'medium' ? '◆' : '●'}</span> {RISK_LABEL[b.risk]}
          </span>
        )}
        <span className={`vchip ${v.tone}`} title={v.title}>
          {v.label}
        </span>
        <span className="ov-card-meta small muted tabular">
          {files.length} {files.length === 1 ? 'file' : 'files'} · <Stat added={added} removed={removed} />
        </span>
        {understood && !understood.changed && <span className="ov-ok" title="You marked this understood">✓</span>}
      </button>
      {open && (
        <div className="ov-card-body" id={id}>
          <p>{b.summary}</p>
          {b.why && (
            <p className="ov-why">
              <span className="ov-k">Why</span> {b.why}
            </p>
          )}
          {b.risk && b.riskReason && (
            <p className={`ov-risk ${b.risk}`}>
              <span className="ov-k">Risk</span> {b.riskReason}
            </p>
          )}
          {inferred && <p className="ov-src small">Grouping and risk inferred by a model from the diff; check them against the code.</p>}
          <ul className="ov-files">
            {files.map((f) => (
              <li key={f.hash}>
                <button className="link mono" onClick={() => onShowFile(f.path)}>
                  {f.path}
                </button>{' '}
                <span className="small tabular">
                  <Stat added={f.added} removed={f.removed} />
                </span>
                {f.explanation && <span className="muted small"> · {firstSentence(f.explanation)}</span>}
                {f.review.state === 'changed' && <span className="rn-again">look again</span>}
              </li>
            ))}
          </ul>
          {b.requestIds.length > 0 && (
            <p className="small">
              <span className="ov-k">Asked in</span>{' '}
              {b.requestIds.map((rid, i) => (
                <span key={rid}>
                  {i > 0 && ' · '}
                  <button className="link" onClick={() => onJump(rid)} title={requestText(rid) ?? undefined}>
                    “{clip(requestText(rid) ?? 'your message', 60)}”
                  </button>
                </span>
              ))}
            </p>
          )}
          <div className="ov-check" role="group" aria-label="Verify and understand">
            <label className="ov-check-row">
              <input type="checkbox" checked={!!understood && !understood.changed} onChange={(e) => onUnderstood(e.target.checked)} />
              <span>
                I understand this change <span className="muted small">· your acknowledgement, not test evidence</span>
                {understood?.changed && <span className="rn-again">changed since you marked it</span>}
              </span>
            </label>
            <div className="ov-check-row">
              <span className={`vdot ${v.tone}`} aria-hidden="true" />
              <span>
                Test evidence: <b>{v.label}</b> <span className="muted small">· {v.title}</span>
              </span>
            </div>
          </div>
          <div className="ov-actions">
            <button className="btn small" onClick={() => onShowFile(files[0]!.path)}>
              Show in diff
            </button>
            <button
              className="btn small"
              onClick={() => onDraft(`About “${b.title}” (${files.map((f) => f.path).join(', ')}): `)}
              title="Ask Claude in this chat, with a message you can edit first"
            >
              Ask in chat
            </button>
            {state !== 'passed' && (
              <button
                className="btn small"
                onClick={() =>
                  onDraft(
                    `Please add or update tests for “${b.title}” (${files.map((f) => f.path).join(', ')}) and run them. Show me the test changes before editing anything else.`,
                  )
                }
                title="Draft a request for tests; nothing is sent until you send it"
              >
                Draft a test request
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
