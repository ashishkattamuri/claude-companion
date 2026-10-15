import { useEffect, useState } from 'react';
import type { ConversationItem, SessionExtras, SessionState } from '../../shared/api';
import { api } from './api';
import { timeAgo } from './format';
import { describeTool } from './turns';

type Tool = Extract<ConversationItem, { kind: 'tool' }>;

/** Context window size: 1M for the long-context models, otherwise 200k. */
const windowFor = (tokens: number) => (tokens > 200_000 ? 1_000_000 : 200_000);
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** Suggest compacting or handing off from here. */
const FULL_PCT = 70;

/** A session's context tools and links. Refreshes whenever the main process reports a change. */
export function useExtras(sessionId: string): SessionExtras | null {
  const [extras, setExtras] = useState<SessionExtras | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void api.getExtras(sessionId).then((e) => live && setExtras(e));
    load();
    const off = api.onChanged(load);
    return () => {
      live = false;
      off();
    };
  }, [sessionId]);
  return extras;
}

interface Props {
  state: SessionState;
  items: ConversationItem[];
  extras: SessionExtras | null;
  onNavigate: (sessionId: string) => void;
  onError: (message: string) => void;
}

export function DetailsRail({ state, items, extras, onNavigate, onError }: Props) {
  const { facts, sessionId } = state;
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const canAct = state.mode !== 'mirror';

  const files = new Map<string, { added: number; removed: number; abs: string }>();
  for (const it of items) {
    if (it.kind !== 'tool' || !['Edit', 'MultiEdit', 'Write'].includes(it.name) || it.result?.isError) continue;
    const d = describeTool(it as Tool, state.cwd);
    if (!d.file) continue;
    const f = files.get(d.file) ?? { added: 0, removed: 0, abs: String(it.input.file_path ?? d.file) };
    files.set(d.file, { ...f, added: f.added + d.added, removed: f.removed + d.removed });
  }
  const pinned = new Set(extras?.pins.map((p) => p.path) ?? []);
  const turns = items.filter((i) => i.kind === 'user').length;
  const ctx = facts.contextTokens;
  const pct = ctx ? Math.min(100, Math.round((ctx / windowFor(ctx)) * 100)) : null;

  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) => {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    if (r && !r.ok && r.error) onError(r.error);
  };

  return (
    <aside className="rail" aria-label="Session details">
      {extras?.parent && (
        <button className="from-link" onClick={() => onNavigate(extras.parent!.id)}>
          ↖ {extras.parent.kind === 'handoff' ? 'Continued from' : 'Opened from'} <b>{extras.parent.title}</b>
        </button>
      )}

      <section>
        <h2>Context window</h2>
        {ctx ? (
          <>
            <div className="rail-big">
              <span className="big">{pct}%</span>
              <span className="muted small tabular">
                {k(ctx)} / {k(windowFor(ctx))} tokens
              </span>
            </div>
            <div className="meter">
              <span className={pct! >= FULL_PCT ? 'hot' : ''} style={{ width: `${pct}%` }} />
            </div>
            {pct! >= FULL_PCT && <p className="rail-warn">Getting full. Compact, or hand off to a fresh session.</p>}
          </>
        ) : (
          <p className="muted small">Shows after Claude's first reply.</p>
        )}
        {canAct && (
          <div className="ctx-tools">
            <input
              id={`compact-focus-${sessionId}`}
              className="rail-input"
              placeholder="Focus for compacting (optional)"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
            />
            <div className="rail-buttons">
              <button
                className="btn small"
                disabled={!!busy}
                onClick={() => void act('compact', () => api.compact(sessionId, focus)).then(() => setFocus(''))}
                title="Run /compact: summarise the conversation to free up context, keeping pinned files"
              >
                {busy === 'compact' ? 'Compacting…' : 'Compact'}
              </button>
              <button
                className="btn small"
                disabled={!!busy}
                onClick={() => void act('handoff', () => api.handOff(sessionId))}
                title="Open a fresh session that picks up from this one's notes"
              >
                {busy === 'handoff' ? 'Opening…' : 'Hand off to a fresh session'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Session notes</h2>
        {extras?.notes ? (
          <>
            <p className="muted small">
              Updated {timeAgo(extras.notes.updatedAt)}
              {extras.notesUpdating ? ' · updating…' : extras.notes.behind ? ' · a turn behind' : ''}
            </p>
            <button className="link" onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? 'Hide' : 'Show'}
            </button>{' '}
            · <button className="link" onClick={() => void api.openNotes(sessionId)}>Open file</button>{' '}
            {showNotes && <pre className="notes-preview">{extras.notes.preview}{extras.notes.preview.length >= 1200 ? '\n…' : ''}</pre>}
          </>
        ) : (
          <p className="muted small">
            {extras?.notesUpdating ? 'Writing the first notes…' : 'Written after Claude finishes a turn. New chats opened from here start from them.'}
          </p>
        )}
        {canAct && turns > 0 && (
          <>
            {extras?.notes ? '· ' : ''}
            <button className="link" disabled={extras?.notesUpdating} onClick={() => void api.refreshNotes(sessionId)}>
              Update now
            </button>
          </>
        )}
      </section>

      <section>
        <h2>Pinned files</h2>
        {extras?.pins.length === 0 && <p className="muted small">Pin the files this work depends on. They're kept through compacting and handed to new chats.</p>}
        {extras?.pins.map((p) => (
          <div key={p.path} className="file" title={p.path}>
            <span className="ellipsis">📌 {p.label}</span>
            <button className="icon-x" onClick={() => void api.unpinFile(sessionId, p.path)} aria-label={`Unpin ${p.label}`}>
              ×
            </button>
          </div>
        ))}
        <div className="rail-buttons">
          <button
            className="link"
            onClick={async () => {
              const f = await api.pickFile(sessionId);
              if (f) await api.pinFile(sessionId, f);
            }}
          >
            Pin a file…
          </button>
          {canAct && !!extras?.pins.length && (
            <button className="link" onClick={() => void act('reload', () => api.reloadPins(sessionId))}>
              Ask Claude to re-read them
            </button>
          )}
        </div>
      </section>

      <section>
        <h2>Files changed</h2>
        {files.size === 0 && <p className="muted small">None yet.</p>}
        {[...files].map(([f, s]) => (
          <div key={f} className="file" title={f}>
            <span className="ellipsis">{f}</span>
            <span className="tabular file-right">
              {s.added > 0 && <span className="stat-add">+{s.added}</span>} {s.removed > 0 && <span className="stat-del">−{s.removed}</span>}
              {!pinned.has(s.abs) && (
                <button className="icon-pin" onClick={() => void api.pinFile(sessionId, s.abs)} title="Pin this file" aria-label={`Pin ${f}`}>
                  📌
                </button>
              )}
            </span>
          </div>
        ))}
      </section>

      {extras && extras.children.length > 0 && (
        <section>
          <h2>Chats opened from here</h2>
          {extras.children.map((c) => (
            <button key={c.id} className="child-link" onClick={() => onNavigate(c.id)}>
              → {c.title}
            </button>
          ))}
        </section>
      )}

      {facts.todos && facts.todos.length > 0 && (
        <section>
          <h2>Plan</h2>
          {facts.todos.map((t, i) => (
            <div key={i} className={`todo ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}`}>
              <span className="box">{t.status === 'completed' ? '✓' : ''}</span>
              {t.content}
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>This session</h2>
        <div className="kv">
          <span>Messages from you</span>
          <span className="tabular">{turns}</span>
          {facts.costUsd != null && (
            <>
              <span>Cost so far</span>
              <span className="tabular">${facts.costUsd.toFixed(2)}</span>
            </>
          )}
          <span>Folder</span>
          <span className="mono ellipsis" title={state.cwd ?? ''}>
            {state.cwd?.split('/').pop()}
          </span>
        </div>
      </section>
    </aside>
  );
}
