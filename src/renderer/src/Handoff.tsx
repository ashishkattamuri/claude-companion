import { useEffect, useState } from 'react';
import type { HandoffDraft, HandoffRecord, ReturnPackage } from '../../shared/api';
import { composeMessage, SECTIONS, type Section } from '../../shared/handoffMessage';
import { api } from './api';
import { timeAgo } from './format';

const words = (s: string | null) => (s ? s.trim().split(/\s+/).length : 0);

/**
 * A hand-off before it starts: everything the new chat will be given, editable. Nothing in it is
 * hidden: what you see here is exactly the background the new chat gets.
 */
export function HandoffSheet({ sessionId, onDone, onCancel, onError }: { sessionId: string; onDone: () => void; onCancel: () => void; onError: (m: string) => void }) {
  const [draft, setDraft] = useState<HandoffDraft | null>(null);
  const [recent, setRecent] = useState(true);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = (kind: HandoffDraft['kind']) =>
    void api.previewHandoff(sessionId, kind).then((r) => {
      if (!r.ok) return onError(r.error);
      setDraft(r.value);
      setPins(new Set(r.value.pins.map((p) => p.path)));
    });
  useEffect(() => load('handoff'), [sessionId]);
  if (!draft) return null;
  const set = (patch: Partial<HandoffDraft>) => setDraft({ ...draft, ...patch });
  const start = async () => {
    setBusy(true);
    const r = await api.handOff(sessionId, { ...draft, recent: recent ? draft.recent : null, pins: draft.pins.filter((p) => pins.has(p.path)) });
    setBusy(false);
    if (!r.ok) return onError(r.error);
    onDone();
  };

  return (
    <div className="sheet-bg" onMouseDown={onCancel}>
      <form
        className="sheet handoff-sheet"
        aria-label="Preview the hand-off"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && e.metaKey) void start();
        }}
      >
        <h2>Open a new chat from this one</h2>
        <div className="seg" role="radiogroup" aria-label="Kind">
          {(
            [
              ['handoff', 'Continue this work'],
              ['branch', 'Separate topic'],
            ] as [HandoffDraft['kind'], string][]
          ).map(([k, label]) => (
            <button type="button" key={k} role="radio" aria-checked={draft.kind === k} aria-pressed={draft.kind === k} onClick={() => load(k)}>
              {label}
            </button>
          ))}
        </div>
        <label className="field">
          Title
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="What the new chat is for" />
        </label>
        <label className="field">
          Goal: the opening message
          <textarea rows={3} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="What should the new chat do first?" autoFocus />
        </label>
        <label className="field">
          Decisions, constraints and open questions: the notes it starts from
          <textarea
            rows={8}
            className="mono-area"
            value={draft.notes ?? ''}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="No notes yet. Write what the new chat should know."
          />
        </label>
        {draft.recent && (
          <label className="check">
            <input type="checkbox" checked={recent} onChange={(e) => setRecent(e.target.checked)} /> Include the last exchanges word for word ({words(draft.recent)} words the notes
            don't cover yet)
          </label>
        )}
        {draft.pins.length > 0 && (
          <fieldset className="field">
            <legend>Pinned files it's told to read</legend>
            {draft.pins.map((p) => (
              <label key={p.path} className="check mono">
                <input
                  type="checkbox"
                  checked={pins.has(p.path)}
                  onChange={(e) => {
                    const next = new Set(pins);
                    if (e.target.checked) next.add(p.path);
                    else next.delete(p.path);
                    setPins(next);
                  }}
                />{' '}
                {p.label}
              </label>
            ))}
          </fieldset>
        )}
        <p className="muted small">
          Supplied now: the goal, these notes{recent && draft.recent ? ', the last exchanges' : ''}
          {pins.size ? ` and ${pins.size} pinned ${pins.size === 1 ? 'file' : 'files'}` : ''}. Anything else from this chat, the new one can look up later, word for word,
          when it needs it.
        </p>
        <div className="sheet-actions">
          <button type="button" className="btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !draft.prompt.trim()}>
            {busy ? 'Opening…' : 'Open the new chat'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** What a child chat was given when it was opened: the same record from the parent and the child. */
export function HandoffDetails({ rec }: { rec: HandoffRecord }) {
  const [full, setFull] = useState(false);
  const p = rec.parts;
  return (
    <div className="handoff-details">
      {rec.prompt && (
        <p className="small">
          <span className="ov-k">Goal</span> {rec.prompt}
        </p>
      )}
      {p ? (
        <>
          <ul className="handoff-given small">
            <li>{p.notes ? `Notes: ${words(p.notes)} words` : 'No notes'}</li>
            <li>{p.recent ? `Last exchanges, word for word: ${words(p.recent)} words` : 'No recent exchanges'}</li>
            <li>{rec.pinLabels.length ? `Pinned: ${rec.pinLabels.join(', ')}` : 'No pinned files'}</li>
          </ul>
          <p className="muted small">
            {p.previewed ? 'Edited in the preview before it opened.' : 'Given automatically when it opened.'} The rest of “{rec.parentTitle}” isn't in its context; it can look it up
            when it needs a detail.
          </p>
          <button className="link small" onClick={() => setFull(!full)}>
            {full ? 'Hide' : 'Show exactly what was supplied'}
          </button>
          {full && rec.context && <pre className="notes-preview">{rec.context}</pre>}
        </>
      ) : (
        <p className="muted small">Opened before Companion recorded hand-offs, so what it was given isn't known.</p>
      )}
    </div>
  );
}

export function returnLabel(r: { version: number; status: 'draft' | 'sent'; outdated: boolean } | null): string | null {
  if (!r) return null;
  if (r.status === 'sent') return r.outdated ? `Returned v${r.version} · changed since` : `Returned v${r.version}`;
  return `Return v${r.version} pending`;
}

const SECTION_LABEL: Record<Section, string> = {
  outcome: 'Outcome',
  remaining: 'Still to do',
  changes: 'Changes',
  decisions: 'What it said as it worked',
  verification: 'Verification',
  concerns: 'Open concerns',
  suggestion: 'Suggested next step',
};

const STATUS: Record<ReturnPackage['childStatus'], string> = {
  working: 'Still working: this is a snapshot',
  waiting: 'Waiting on you',
  idle: 'Finished its turn',
  ended: 'Not running',
  interrupted: 'Last turn interrupted',
};

/**
 * A return package, for you to choose and edit what goes back to the parent. Preparing or viewing it
 * sends nothing; Send delivers it once, through the parent's normal input.
 */
export function ReturnSheet({ childId, onClose, onError, onSent }: { childId: string; onClose: () => void; onError: (m: string) => void; onSent: (parentId: string) => void }) {
  const [pkg, setPkg] = useState<ReturnPackage | null>(null);
  const [keep, setKeep] = useState<Set<Section>>(new Set(SECTIONS));
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const prepare = () =>
    void api.prepareReturn(childId).then((r) => {
      if (!r.ok) return onError(r.error);
      setPkg(r.value);
      setText(r.value.message);
      setEdited(false);
      setKeep(new Set(SECTIONS));
    });
  useEffect(prepare, [childId]);
  if (!pkg) return null;
  const sent = pkg.status === 'sent';
  const toggle = (s: Section, on: boolean) => {
    const next = new Set(keep);
    if (on) next.add(s);
    else next.delete(s);
    setKeep(next);
    if (!edited) setText(composeMessage(pkg, SECTIONS.filter((x) => next.has(x))));
  };
  const send = async () => {
    setBusy(true);
    const r = await api.sendReturn(pkg.id, text);
    setBusy(false);
    if (!r.ok) return onError(r.error);
    onSent(pkg.parentId);
  };
  const fresh = pkg.verification.filter((v) => !v.stale);

  return (
    <div className="sheet-bg" onMouseDown={onClose}>
      <div className="sheet return-sheet" role="dialog" aria-label="Return to the original chat" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>
          Return to “{pkg.parentTitle}” <span className="muted small">v{pkg.version}</span>
        </h2>
        <p className="small">
          <span className={`vchip ${pkg.childStatus === 'idle' || pkg.childStatus === 'ended' ? '' : 'amber'}`}>{STATUS[pkg.childStatus]}</span>{' '}
          {sent ? <span className="vchip green">Sent {timeAgo(pkg.sentAt!)}</span> : <span className="muted">Nothing is sent until you press Send.</span>}
        </p>
        {pkg.outdated && (
          <p className="ov-banner warn">
            This chat did more since v{pkg.version} was prepared.{' '}
            <button className="link" onClick={prepare}>
              Prepare v{pkg.version + 1}
            </button>
          </p>
        )}
        <div className="return-sections">
          {SECTIONS.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={keep.has(s)} disabled={sent} onChange={(e) => toggle(s, e.target.checked)} /> {SECTION_LABEL[s]}
              <span className="muted small">
                {' '}
                ·{' '}
                {s === 'outcome'
                  ? pkg.outcome
                    ? 'its last reply, a claim'
                    : 'no reply yet'
                  : s === 'remaining'
                    ? `${pkg.remaining.length} open`
                    : s === 'changes'
                      ? `${pkg.changes.length} ${pkg.changes.length === 1 ? 'file' : 'files'}${pkg.changes.length ? (pkg.workspace.same ? ', already in the original chat’s folder' : ', in another folder, not merged') : ''}`
                      : s === 'decisions'
                        ? `${pkg.decisions.length} remarks at its edits`
                        : s === 'verification'
                          ? fresh.length
                            ? `${fresh.length} after the last edit`
                            : 'not verified'
                          : s === 'concerns'
                            ? `${pkg.concerns.length}`
                            : ''}
              </span>
            </label>
          ))}
        </div>
        <label className="field">
          Message to the original chat {edited && !sent && (
            <button
              type="button"
              className="link small"
              onClick={() => {
                setText(composeMessage(pkg, SECTIONS.filter((x) => keep.has(x))));
                setEdited(false);
              }}
            >
              Reset to the selections
            </button>
          )}
          <textarea
            rows={12}
            className="mono-area"
            value={text}
            readOnly={sent}
            onChange={(e) => {
              setText(e.target.value);
              setEdited(true);
            }}
          />
        </label>
        <div className="sheet-actions">
          <button className="btn quiet" onClick={onClose}>
            {sent ? 'Close' : 'Cancel'}
          </button>
          {!sent && (
            <button className="btn primary" onClick={() => void send()} disabled={busy || !text.trim() || pkg.outdated}>
              {busy ? 'Sending…' : 'Send to the original chat'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
