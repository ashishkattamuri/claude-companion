import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewSessionRequest, RecapView, SessionListItem } from '../../shared/api';
import { api } from './api';
import { NewSessionSheet } from './NewSessionSheet';
import { SessionWorkspace } from './SessionWorkspace';
import { Sidebar, type Page } from './Sidebar';
import { sessions as store } from './store';
import { TodayView } from './TodayView';

type Selection = { kind: 'page'; page: Page } | { kind: 'session'; id: string; draft?: string };

const SOON: Record<Exclude<Page, 'today'>, { title: string; text: string }> = {
  ideas: { title: 'Ideas', text: 'Follow-ups and directions from your conversations, ready to run in one click.' },
  goals: { title: 'Goals', text: 'Long-running goals checked on a schedule that report back only when something changes.' },
  feed: { title: 'Feed', text: 'News related to what you are working on.' },
  connectors: { title: 'Connectors', text: 'GitHub, Linear, Slack and calendar via MCP, enabled when first needed.' },
};

export function App() {
  const [selection, setSelection] = useState<Selection>({ kind: 'page', page: 'today' });
  const [list, setList] = useState<SessionListItem[]>([]);
  const [search, setSearch] = useState('');
  const [recap, setRecap] = useState<RecapView | null>(null);
  const [sheet, setSheet] = useState<{ cwd?: string; prompt?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const openId = useRef<string | null>(null);

  const reload = useCallback(() => {
    void api.listSessions({ search: search.trim() || undefined }).then(setList);
    void api.getRecap().then(setRecap);
  }, [search]);

  useEffect(() => {
    reload();
    return api.onChanged(reload);
  }, [reload]);

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
      setSheet(null);
      const r = await api.newSession(req);
      if (!r.ok) return setToast(r.error);
      setSelection({ kind: 'session', id: r.value });
      reload();
    },
    [reload],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'n') {
        e.preventDefault();
        setSheet({});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        onNew={() => setSheet({})}
      />
      <main className="content">
        {selection.kind === 'session' && (
          <SessionWorkspace key={selection.id} sessionId={selection.id} draft={selection.draft} onError={setToast} />
        )}
        {selection.kind === 'page' && selection.page === 'today' && (
          <TodayView
            data={recap}
            onStart={(project, sessionId, text) => setSheet({ cwd: cwdFor(project, sessionId), prompt: text })}
            onContinue={(id, text) => setSelection({ kind: 'session', id, draft: text })}
            onRegenerate={() => void api.regenerateRecap()}
          />
        )}
        {selection.kind === 'page' && selection.page !== 'today' && (
          <div className="page">
            <div className="empty">
              <h2>{SOON[selection.page].title}</h2>
              <p className="muted">{SOON[selection.page].text}</p>
              <span className="chip static">Coming soon</span>
            </div>
          </div>
        )}
      </main>
      {sheet && <NewSessionSheet initial={sheet} onStart={(req) => void startSession(req)} onCancel={() => setSheet(null)} />}
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
