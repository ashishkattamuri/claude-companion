import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewView, SinceView } from '../../shared/api';
import { api } from './api';
import { timeAgo } from './format';
import { clip, firstSentence, Stat } from './ReviewPanel';

/**
 * What changed since your checkpoint. The view is frozen at the transcript position it first loaded
 * at, so new activity doesn't shift what you're reading; it's counted as incoming until you show it.
 */
export function useSince(sessionId: string) {
  const [view, setView] = useState<SinceView | null>(null);
  const upto = useRef<number | null>(null);
  const load = useCallback(
    () =>
      void api.getSince(sessionId, upto.current).then((v) => {
        upto.current = v.upto;
        setView(v);
      }),
    [sessionId],
  );
  useEffect(() => {
    upto.current = null;
    load();
    return api.onChanged(load);
  }, [load]);
  return {
    view,
    /** Moves the frozen point to the latest activity (the checkpoint stays where it is). */
    showIncoming: () => {
      upto.current = null;
      load();
    },
    /** You've caught up to what's shown: the checkpoint moves there. */
    markSeen: () => {
      if (upto.current !== null) void api.markSeen(sessionId, upto.current);
    },
  };
}

export function sinceCount(v: SinceView | null): number {
  return v && v.baseline === 'ok' ? v.files.length : 0;
}

const CHANGE: Record<SinceView['files'][number]['change'], string> = { new: 'New change', changed: 'Changed again', reverted: 'Change undone' };

export function ReviewSincePane({
  since,
  review,
  onShowIncoming,
  onMarkSeen,
  onJump,
  onShowFile,
}: {
  since: SinceView | null;
  review: ReviewView;
  onShowIncoming: () => void;
  onMarkSeen: () => void;
  onJump: (id: string) => void;
  onShowFile: (path: string, hunk?: number) => void;
}) {
  if (!since) return <div className="review-pane since" />;
  const path = (abs: string) => since.paths[abs] ?? abs;
  const reviewOf = new Map(review.files.map((f) => [f.abs, f]));
  const incoming = since.incoming.edits + since.incoming.tests + since.incoming.requests;
  const nothing = since.files.length === 0 && since.requests.length === 0 && since.tests.length === 0 && since.failures.length === 0;
  const external = review.files.filter((f) => f.disk !== 'same');

  return (
    <div className="review-pane since">
      <div className="since-head">
        <div>
          <h3>
            {since.baseline === 'ok'
              ? `Since you last looked, ${timeAgo(since.checkpointAt!)}`
              : since.baseline === 'lost'
                ? 'Your last checkpoint is no longer in the transcript'
                : 'Your first look at this session'}
          </h3>
          <p className="muted small">
            {since.baseline === 'none'
              ? 'Everything the session did is new to you. Mark it as seen to set a baseline; next time this shows only what changed after it.'
              : since.baseline === 'lost'
                ? 'The transcript was rewritten, so everything is shown as new. Mark it as seen to set a new baseline.'
                : 'Seen and reviewed are kept apart: marking this as seen moves your checkpoint, and never marks code reviewed.'}
          </p>
        </div>
        <button className="btn" onClick={onMarkSeen} disabled={nothing && since.baseline === 'ok'} title="Move your checkpoint to what's shown here">
          Mark all as seen
        </button>
      </div>

      {incoming > 0 && (
        <p className="ov-banner" role="status">
          While you were reading: {[n(since.incoming.edits, 'edit'), n(since.incoming.tests, 'test run'), n(since.incoming.requests, 'message')].filter(Boolean).join(', ')}.{' '}
          <button className="link" onClick={onShowIncoming}>
            Show them
          </button>
        </p>
      )}
      {nothing && since.baseline === 'ok' && <p className="muted">Nothing new since then.</p>}

      {since.files.length > 0 && (
        <section className="vsec" aria-labelledby="s-files">
          <h3 id="s-files">Files</h3>
          <ul className="since-files">
            {since.files.map((f) => {
              const r = reviewOf.get(f.abs);
              const again = r?.review.state === 'changed';
              return (
                <li key={f.abs}>
                  <div className="since-file-head">
                    <button className="link mono" onClick={() => onShowFile(path(f.abs), f.newHunks[0])}>
                      {path(f.abs)}
                    </button>
                    <span className={`vchip ${f.change === 'changed' ? 'amber' : f.change === 'reverted' ? '' : 'green'}`}>{CHANGE[f.change]}</span>
                    {f.change !== 'reverted' && (
                      <span className="small tabular">
                        <Stat added={f.added} removed={f.removed} />
                      </span>
                    )}
                    {again && <span className="rn-again">needs another look</span>}
                    {r?.review.state === 'reviewed' && <span className="vchip green">Reviewed</span>}
                  </div>
                  <p className="small muted">
                    {f.change === 'reverted'
                      ? 'Edited back to how it was before the session.'
                      : f.partial
                        ? "The file's earlier content wasn't recorded, so all of it counts as new."
                        : f.change === 'changed'
                          ? `${f.newHunks.length} ${f.newHunks.length === 1 ? 'hunk is' : 'hunks are'} new or different since you looked.`
                          : `${f.newHunks.length} ${f.newHunks.length === 1 ? 'hunk' : 'hunks'}.`}
                    {again && r && ` You reviewed it ${timeAgo(r.review.at!)}; ${r.review.changedHunks.length} of its hunks changed since.`}
                  </p>
                  {f.steps.length > 0 && (
                    <ol className="rf-steps since-steps">
                      {f.steps.map((s) => (
                        <li key={s.id}>
                          <span className={`rf-step-note ${s.note ? '' : 'muted'}`} title={s.note ?? undefined}>
                            {s.note ? `“${clip(firstSentence(s.note), 160)}”` : 'Edited without a remark'}
                          </span>
                          <span className="muted small">{timeAgo(s.ts)}</span>
                          <button className="link" onClick={() => onJump(s.id)}>
                            Show in chat
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {external.length > 0 && (
        <section className="vsec" aria-labelledby="s-ext">
          <h3 id="s-ext">Changed outside this session</h3>
          <ul className="since-plain">
            {external.map((f) => (
              <li key={f.abs}>
                <span className="mono">{f.path}</span>{' '}
                <span className="muted small">{f.disk === 'missing' ? 'deleted from disk' : 'differs on disk from what the session left; not counted as its change'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {since.requests.length > 0 && (
        <section className="vsec" aria-labelledby="s-asks">
          <h3 id="s-asks">Your messages since</h3>
          <ul className="since-plain">
            {since.requests.map((r) => (
              <li key={r.id}>
                <span>{clip(r.text.replace(/\s+/g, ' '), 200)}</span>{' '}
                <button className="link small" onClick={() => onJump(r.id)}>
                  Show in chat
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(since.tests.length > 0 || since.staleTests.length > 0) && (
        <section className="vsec" aria-labelledby="s-tests">
          <h3 id="s-tests">Tests and checks</h3>
          <ol className="vruns">
            {since.staleTests.map((t) => (
              <li key={`stale-${t.stepId}`}>
                <span className="vchip amber">Now stale</span>
                <span className="vrun-main">
                  <code className="vrun-cmd">{clip(t.command, 140)}</code>
                  <span className="vstale small">
                    Passed before you looked; edited since: {t.files.map(path).slice(0, 4).join(', ')}
                    {t.files.length > 4 ? ` and ${t.files.length - 4} more` : ''}
                  </span>
                </span>
                <button className="link" onClick={() => onJump(t.stepId)}>
                  Show in chat
                </button>
              </li>
            ))}
            {since.tests.map((t) => (
              <li key={t.stepId}>
                <span className={`vchip ${t.outcome === 'passed' ? 'green' : t.outcome === 'failed' ? 'red' : 'amber'}`}>
                  {t.outcome === 'passed' ? 'Passed' : t.outcome === 'failed' ? 'Failed' : 'Outcome unknown'}
                </span>
                <span className="vrun-main">
                  <code className="vrun-cmd">{clip(t.command, 140)}</code>
                  <span className="muted small">
                    {timeAgo(t.ts)}
                    {t.summary ? ` · ${t.summary}` : ''}
                    {t.kind === 'test' ? (t.scope ? ` · ran ${t.scope.join(', ')}` : ' · scope not recorded') : ''}
                  </span>
                  {t.editedAfter.length > 0 && <span className="vstale small">Edited after this run: {t.editedAfter.map(path).join(', ')}</span>}
                </span>
                <button className="link" onClick={() => onJump(t.stepId)}>
                  Show in chat
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {since.failures.length > 0 && (
        <section className="vsec" aria-labelledby="s-fails">
          <h3 id="s-fails">Failed attempts</h3>
          <ul className="vfails">
            {since.failures.map((f) => (
              <li key={f.stepId}>
                <span className={`vchip ${f.denied ? 'amber' : 'red'}`}>{f.denied ? 'Denied' : 'Error'}</span>
                <span className="vrun-main">
                  <span className="mono small">
                    {f.tool} {clip(f.target, 100)}
                  </span>
                  <span className="muted small">{clip(f.text.replace(/\s+/g, ' '), 160)}</span>
                </span>
                <button className="link" onClick={() => onJump(f.stepId)}>
                  Show in chat
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const n = (count: number, word: string) => (count ? `${count} ${word}${count === 1 ? '' : 's'}` : '');
