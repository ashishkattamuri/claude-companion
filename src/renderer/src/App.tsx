import { useCallback, useEffect, useState } from 'react';
import type { OpenRequest, RecapView as Recap, TermInfo } from '../../shared/api';
import { api } from './api';
import { NewSessionDialog } from './NewSessionDialog';
import { RecapView } from './RecapView';
import { SessionsView } from './SessionsView';
import { TerminalPane } from './TerminalPane';

type Page = 'today' | 'sessions' | 'ideas' | 'goals' | 'feed' | 'connectors';
type View = { kind: 'page'; page: Page } | { kind: 'term'; id: string };

const PAGES: { id: Page; label: string; soon?: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'ideas', label: 'Ideas', soon: 'Follow-ups and directions from your conversations, ready to run in one click.' },
  { id: 'goals', label: 'Goals', soon: 'Long-running goals checked on a schedule that report back only when something changes.' },
  { id: 'feed', label: 'Feed', soon: 'News related to what you are working on.' },
  { id: 'connectors', label: 'Connectors', soon: 'GitHub, Linear, Slack and calendar via MCP, enabled when first needed.' },
];

export function App() {
  const [view, setView] = useState<View>({ kind: 'page', page: 'today' });
  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [version, setVersion] = useState(0);
  const [newSession, setNewSession] = useState<{ cwd?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
    void api.getRecap().then(setRecap);
    void api.listTerminals().then(setTerms);
  }, []);

  useEffect(() => {
    reload();
    const offChanged = api.onChanged(reload);
    const offExit = api.onTerminalExit(() => void api.listTerminals().then(setTerms));
    return () => {
      offChanged();
      offExit();
    };
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const open = useCallback(async (req: OpenRequest) => {
    const r = await api.openSession(req);
    if (!r.ok) return setToast(r.error);
    setTerms(await api.listTerminals());
    setView({ kind: 'term', id: r.term.id });
  }, []);

  const closeTerm = useCallback(
    async (id: string) => {
      await api.closeTerminal(id);
      const remaining = await api.listTerminals();
      setTerms(remaining);
      setView((v) => (v.kind === 'term' && v.id === id ? (remaining.at(-1) ? { kind: 'term', id: remaining.at(-1)!.id } : { kind: 'page', page: 'sessions' }) : v));
    },
    [],
  );

  // ⌘N new session, ⌘W close the current tab, ⌘1–6 pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        setNewSession({});
      } else if (e.key === 'w' && view.kind === 'term') {
        e.preventDefault();
        void closeTerm(view.id);
      } else if (/^[1-6]$/.test(e.key)) {
        e.preventDefault();
        setView({ kind: 'page', page: PAGES[Number(e.key) - 1]!.id });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [view, closeTerm]);

  const status = recap?.status;
  const page = view.kind === 'page' ? PAGES.find((p) => p.id === view.page)! : null;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="drag-region">
          <span className="brand">Companion</span>
        </div>
        {PAGES.map((p, i) => (
          <button
            key={p.id}
            className={`nav-item ${view.kind === 'page' && view.page === p.id ? 'active' : ''} ${p.soon ? 'soon' : ''}`}
            onClick={() => setView({ kind: 'page', page: p.id })}
            title={`⌘${i + 1}`}
          >
            {p.label}
            {p.soon && <span className="soon-tag">soon</span>}
          </button>
        ))}

        <div className="nav-heading">Open sessions</div>
        {terms.length === 0 && <div className="muted small nav-empty">None yet</div>}
        {terms.map((t) => (
          <div key={t.id} className={`nav-item term ${view.kind === 'term' && view.id === t.id ? 'active' : ''}`}>
            <button className="term-link" onClick={() => setView({ kind: 'term', id: t.id })} title={t.title}>
              <span className={`dot ${t.exited ? 'none' : 'open'}`} />
              <span className="ellipsis">{t.title}</span>
            </button>
            <button className="icon-btn" onClick={() => void closeTerm(t.id)} title={t.exited ? 'Close' : 'End session'}>
              ×
            </button>
          </div>
        ))}
        <button className="nav-item new" onClick={() => setNewSession({})}>
          + New session <span className="kbd">⌘N</span>
        </button>

        <div className="sidebar-footer muted small">
          {status?.state === 'running' ? (
            <>
              <span className="spinner" /> {status.step}
              {status.total ? ` ${status.done}/${status.total}` : ''}
            </>
          ) : status?.state === 'paused' ? (
            'Summaries paused (usage limit)'
          ) : status?.state === 'error' ? (
            <span className="error-text">Summaries failed; see Today</span>
          ) : (
            'Up to date'
          )}
        </div>
      </nav>

      <main className="main">
        {page?.id === 'today' && <RecapView data={recap} onOpen={open} onRegenerate={() => void api.regenerateRecap()} />}
        {page?.id === 'sessions' && (
          <SessionsView
            version={version}
            onOpen={open}
            onFocusTerm={(id) => setView({ kind: 'term', id })}
            onNewSession={(cwd) => setNewSession({ cwd })}
          />
        )}
        {page?.soon && (
          <div className="page">
            <div className="empty">
              <h2>{page.label}</h2>
              <p className="muted">{page.soon}</p>
              <span className="chip">Coming soon</span>
            </div>
          </div>
        )}
        {terms.map((t) => (
          <TerminalPane key={t.id} term={t} active={view.kind === 'term' && view.id === t.id} onClose={() => void closeTerm(t.id)} />
        ))}
      </main>

      {newSession && (
        <NewSessionDialog
          initialCwd={newSession.cwd}
          onCancel={() => setNewSession(null)}
          onStart={(cwd, prompt) => {
            setNewSession(null);
            void open({ kind: 'new', cwd, prompt });
          }}
        />
      )}
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
