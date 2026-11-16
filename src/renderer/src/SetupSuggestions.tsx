import { useCallback, useEffect, useState } from 'react';
import type { SetupSuggestion, SetupView } from '../../shared/api';
import { api } from './api';
import { timeAgo } from './format';

const KIND: Record<SetupSuggestion['evidence'][number]['kind'], string> = {
  correction: 'You corrected Claude',
  denied: 'You denied a permission',
  repeated: 'You said this again',
  reverted: 'An edit was undone',
  skill: 'Corrected right after a skill',
};

/**
 * Suggested edits to your CLAUDE.md files, skills and permission settings, from what keeps going
 * wrong in your sessions. Each is a small addition shown as a diff, written only when you press Apply.
 */
export function SetupSuggestionsPage({ onOpen, onError }: { onOpen: (sessionId: string, itemId: string) => void; onError: (m: string) => void }) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [view, setView] = useState<SetupView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => void api.getSetup(cwd).then(setView), [cwd]);
  useEffect(() => {
    load();
    return api.onChanged(load);
  }, [load]);
  if (!view) return <div className="page" />;
  const groups = new Map<string, SetupSuggestion[]>();
  for (const s of view.suggestions) groups.set(s.targetPath, [...(groups.get(s.targetPath) ?? []), s]);
  const run = async () => {
    setConfirm(false);
    const r = await api.runSetupReview(view.cwd!);
    if (!r.ok) onError(r.error);
  };

  return (
    <div className="page setup-page">
      <header className="setup-head">
        <div>
          <h1>Setup suggestions</h1>
          <p className="muted">Small additions to your CLAUDE.md files, skills and permissions, from what keeps going wrong in your sessions. Nothing changes until you apply it.</p>
        </div>
      </header>
      <div className="setup-bar">
        <label className="field setup-project">
          Project
          <select value={view.cwd ?? ''} onChange={(e) => setCwd(e.target.value)}>
            {view.projects.map((p) => (
              <option key={p.cwd} value={p.cwd} disabled={p.optedOut}>
                {p.name}
                {p.optedOut ? ' (opted out)' : ''}
              </option>
            ))}
          </select>
        </label>
        {view.cwd && !confirm && (
          <button className="btn primary" disabled={view.running} onClick={() => setConfirm(true)}>
            {view.running ? 'Reviewing…' : 'Review my setup'}
          </button>
        )}
      </div>
      {confirm && view.cwd && (
        <div className="setup-confirm" role="dialog" aria-label="Review my setup">
          <p>
            Reads the last {view.window.days} days of this project's sessions ({view.window.sessions}), its CLAUDE.md, your ~/.claude/CLAUDE.md, the skills involved and its
            settings, then makes one call to <b>{view.model}</b> to propose edits. Nothing is written.
          </p>
          <div className="row gap">
            <button className="btn primary" onClick={() => void run()}>
              Review
            </button>
            <button className="btn quiet" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {view.lastRun && !view.running && (
        <p className="muted small">
          Last reviewed {timeAgo(view.lastRun.at)}:{' '}
          {view.lastRun.error
            ? `failed (${view.lastRun.error})`
            : view.lastRun.evidence === 0
              ? 'nothing repeated enough to suggest a change.'
              : `${view.lastRun.evidence} signs of friction, ${view.lastRun.found} new ${view.lastRun.found === 1 ? 'suggestion' : 'suggestions'}.`}
        </p>
      )}
      {view.suggestions.length === 0 && !view.running && (
        <div className="empty small-empty">
          <p className="muted">No suggestions{view.lastRun ? ' open' : ' yet'}. Review your setup to look for corrections you keep repeating, permissions you keep denying and facts you re-explain.</p>
        </div>
      )}
      {[...groups].map(([path, list]) => (
        <section key={path} className="setup-group" aria-label={list[0]!.targetLabel}>
          <h2>
            {list[0]!.targetLabel} <span className="mono muted small">{path}</span>
          </h2>
          {list.map((s) => (
            <SuggestionCard key={s.id} s={s} onOpen={onOpen} onError={onError} />
          ))}
        </section>
      ))}
    </div>
  );
}

function SuggestionCard({ s, onOpen, onError }: { s: SetupSuggestion; onOpen: (sessionId: string, itemId: string) => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const [showAll, setShowAll] = useState(false);
  const act = async (p: Promise<{ ok: boolean; error?: string } | void>) => {
    const r = await p;
    if (r && !r.ok && r.error) onError(r.error);
  };
  const ev = showAll ? s.evidence : s.evidence.slice(0, 4);
  return (
    <article className={`setup-card ${s.status}`}>
      <p className="setup-why">{s.why}</p>
      <p className="small muted">
        Happened {s.impact.times} {s.impact.times === 1 ? 'time' : 'times'} in {s.impact.sessions} {s.impact.sessions === 1 ? 'session' : 'sessions'}, each costing a turn to
        put right.
      </p>
      {editing ? (
        <div className="setup-edit">
          <textarea rows={Math.min(8, text.split('\n').length + 1)} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row gap">
            <button
              className="btn small primary"
              onClick={() =>
                void api.editSuggestion(s.id, text).then((r) => {
                  if (!r.ok) return onError(r.error);
                  setEditing(false);
                })
              }
            >
              Save
            </button>
            <button className="btn small quiet" onClick={() => (setText(s.text), setEditing(false))}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <pre className="setup-diff" aria-label="The edit">
          {s.diff.split('\n').map((l, i) => (
            <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'at' : ''}>
              {l || ' '}
            </span>
          ))}
        </pre>
      )}
      <div className="setup-evidence">
        <span className="ov-k">Evidence</span>
        <ul>
          {ev.map((e) => (
            <li key={`${e.sessionId}:${e.itemId}`}>
              <span className="muted small">{KIND[e.kind]}</span>{' '}
              <button className="link" onClick={() => onOpen(e.sessionId, e.itemId)} title={`Open “${e.sessionTitle}” at this point`}>
                “{e.text.length > 120 ? `${e.text.slice(0, 119)}…` : e.text}”
              </button>{' '}
              <span className="muted small">
                {e.sessionTitle} · {timeAgo(e.ts)}
              </span>
            </li>
          ))}
        </ul>
        {s.evidence.length > 4 && (
          <button className="link small" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${s.evidence.length}`}
          </button>
        )}
      </div>
      {s.status === 'applied' && s.since && (
        <p className={`setup-since ${s.since.notWorking ? 'warn' : ''}`}>
          Applied {timeAgo(s.appliedAt!)}. Since applied: happened {s.since.after} {s.since.after === 1 ? 'time' : 'times'} (was {s.since.before} in the 14 days before).
          {s.since.notWorking && <b> Not working: the pattern is still happening.</b>}
        </p>
      )}
      <div className="setup-actions">
        {s.status === 'new' && (
          <>
            <button className="btn small primary" onClick={() => void act(api.applySuggestion(s.id))} title="Write it into the file, keeping a .bak copy">
              Apply
            </button>
            {!editing && (
              <button className="btn small" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            <button className="btn small quiet" onClick={() => void act(api.dismissSuggestion(s.id))} title="Hide it; it won't be suggested again">
              Dismiss
            </button>
          </>
        )}
        {s.status === 'applied' && (
          <button className="btn small" onClick={() => void act(api.undoSuggestion(s.id))} title="Take it back out of the file">
            Undo
          </button>
        )}
      </div>
    </article>
  );
}
