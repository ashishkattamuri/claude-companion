import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewSessionRequest, RecapView, SessionListItem } from '../../shared/api';
import { api } from './api';
import { ConnectorsPage, type ConnectorsTab } from './ConnectorsPage';
import { NewSessionPage } from './NewSessionPage';
import { SessionWorkspace, type View } from './SessionWorkspace';
import { Sidebar, type Page } from './Sidebar';
import { sessions as store } from './store';
import { TodayView } from './TodayView';

type Selection =
  | { kind: 'page'; page: Page }
  | { kind: 'session'; id: string; draft?: string; view?: View }
  | { kind: 'new'; cwd?: string; prompt?: string; back: Selection };

const SOON: Record<Exclude<Page, 'today' | 'connectors'>, { title: string; text: string }> = {
  ideas: { title: 'Ideas', text: 'Follow-ups and directions from your conversations, ready to run in one click.' },
  goals: { title: 'Goals', text: 'Long-running goals checked on a schedule that report back only when something changes.' },
  feed: { title: 'Feed', text: 'News related to what you are working on.' },
};

export function App() {
  const [selection, setSelection] = useState<Selection>({ kind: 'new', back: { kind: 'page', page: 'today' } });
  const [list, setList] = useState<SessionListItem[]>([]);
  const [search, setSearch] = useState('');
  const [recap, setRecap] = useState<RecapView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [connectorsAt, setConnectorsAt] = useState<{ tab: ConnectorsTab; search?: string } | undefined>(undefined);
  const openId = useRef<string | null>(null);

  const reload = useCallback(() => {
    void api.listSessions({ search: search.trim() || undefined }).then(setList);
    void api.getRecap().then(setRecap);
  }, [search]);

  useEffect(() => {
    reload();
    return api.onChanged(reload);
  }, [reload]);

  // Claude opened a new chat (or a hand-off started): show it, with its opening message ready.
  useEffect(
    () =>
      api.onNavigate((id, draft) => {
        setSelection({ kind: 'session', id, draft });
        reload();
      }),
    [reload],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Open the selected session's live view; let the previous one go.
  useEffect(() => {
    const id = selection.kind === 'session' ? selection.id : null;
    if (openId.current && openId.current !== id) store.close(openId.current);
    openId.current = id;
    if (id) void store.open(id).then((err) => err && setToast(err));
  }, [selection]);

  const startSession = useCallback(
    async (req: NewSessionRequest) => {
      const r = await api.newSession(req);
      if (!r.ok) return setToast(r.error);
      setSelection({ kind: 'session', id: r.value });
      reload();
    },
    [reload],
  );

  const openNew = useCallback((initial: { cwd?: string; prompt?: string } = {}) => {
    setSelection((cur) => ({ kind: 'new', ...initial, back: cur.kind === 'new' ? cur.back : cur }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'n') {
        e.preventDefault();
        openNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNew]);

  const cwdFor = (project: string, sessionId: string) =>
    list.find((s) => s.id === sessionId)?.cwd ?? list.find((s) => s.project === project)?.cwd ?? undefined;

  return (
    <div className="app">
      <Sidebar
        page={selection.kind === 'page' ? selection.page : null}
        sessions={list}
        selectedId={selection.kind === 'session' ? selection.id : null}
        search={search}
        onSearch={setSearch}
        onPage={(page) => setSelection({ kind: 'page', page })}
        onSelect={(id) => setSelection({ kind: 'session', id })}
        onNew={() => openNew()}
        newActive={selection.kind === 'new'}
        onHide={(ids, hidden) => void api.setHidden(ids, hidden).then(reload)}
        onDelete={async (ids) => {
          const r = await api.deleteSessions(ids);
          if (!r.ok) setToast(r.error);
          // Some may be gone even when others were refused; leave the open one if it was deleted.
          const open = selection.kind === 'session' && ids.includes(selection.id) ? selection.id : null;
          if (open && !(await api.listSessions({})).some((s) => s.id === open)) setSelection({ kind: 'page', page: 'today' });
          reload();
          return r.ok && r.value;
        }}
        onAudit={(id) => {
          setSelection({ kind: 'session', id, view: 'audit' });
          void api.runAudit(id).then((r) => {
            if (!r.ok) setToast(r.error);
            reload();
          });
        }}
      />
      <main className="content">
        {selection.kind === 'session' && (
          <SessionWorkspace
            key={`${selection.id}:${selection.view ?? ''}`}
            sessionId={selection.id}
            draft={selection.draft}
            initialView={selection.view}
            onError={setToast}
            onNavigate={(id) => setSelection({ kind: 'session', id })}
          />
        )}
        {selection.kind === 'new' && (
          <NewSessionPage
            key={`${selection.cwd ?? ''}:${selection.prompt ?? ''}`}
            initial={selection}
            sessions={list}
            onStart={(req) => void startSession(req)}
            onCancel={() => setSelection(selection.back)}
          />
        )}
        {selection.kind === 'page' && selection.page === 'today' && (
          <TodayView
            data={recap}
            onStart={(project, sessionId, text) => openNew({ cwd: cwdFor(project, sessionId), prompt: text })}
            onContinue={(id, text) => setSelection({ kind: 'session', id, draft: text })}
            onRegenerate={() => void api.regenerateRecap()}
            onConnectors={(at) => {
              setConnectorsAt(at);
              setSelection({ kind: 'page', page: 'connectors' });
            }}
          />
        )}
        {selection.kind === 'page' && selection.page === 'connectors' && <ConnectorsPage initial={connectorsAt} onError={setToast} />}
        {selection.kind === 'page' && selection.page !== 'today' && selection.page !== 'connectors' && (
          <div className="page">
            <div className="empty">
              <h2>{SOON[selection.page].title}</h2>
              <p className="muted">{SOON[selection.page].text}</p>
              <span className="chip static">Coming soon</span>
            </div>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
