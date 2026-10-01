import { useEffect, useState } from 'react';
import type { OpenRequest, ProjectRow, SessionItem } from '../../shared/api';
import { api } from './api';
import { shortPath, timeAgo } from './format';

interface Props {
  version: number;
  onOpen: (req: OpenRequest) => void;
  onFocusTerm: (termId: string) => void;
  onNewSession: (cwd?: string) => void;
}

export function SessionsView({ version, onOpen, onFocusTerm, onNewSession }: Props) {
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [items, setItems] = useState<SessionItem[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void api.listSessions({ search, projectId }).then(setItems);
  }, [search, projectId, version]);
  useEffect(() => {
    void api.listProjects().then(setProjects);
  }, [version]);

  const selected = items.find((s) => s.id === selectedId) ?? items[0] ?? null;
  const open = (s: SessionItem) => (s.termId ? onFocusTerm(s.termId) : onOpen({ kind: 'resume', sessionId: s.id }));

  return (
    <div className="split">
      <section className="list-pane">
        <div className="toolbar">
          <input
            className="input grow"
            placeholder="Search everything you and Claude wrote…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={() => onNewSession()}>
            New session
          </button>
        </div>
        <div className="list">
          {items.length === 0 && <p className="muted pad">No sessions{search ? ` matching "${search}"` : ''}.</p>}
          {items.map((s) => (
            <button
              key={s.id}
              className={`list-row ${selected?.id === s.id ? 'selected' : ''} ${s.transcriptGone ? 'faded' : ''}`}
              onClick={() => setSelectedId(s.id)}
              onDoubleClick={() => open(s)}
            >
              <StatusDot s={s} />
              <span className="row-title">{s.title}</span>
              <span className="chip">{s.project ?? '?'}</span>
              <span className="muted small row-time">{s.termId ? 'open' : s.live ? 'live' : timeAgo(s.lastTs)}</span>
            </button>
          ))}
        </div>
      </section>

      <aside className="detail-pane">
        {selected ? <Detail s={selected} onOpen={() => open(selected)} onNewHere={() => onNewSession(selected.cwd ?? undefined)} /> : null}
      </aside>
    </div>
  );
}

function StatusDot({ s }: { s: SessionItem }) {
  if (s.termId) return <span className="dot open" title="Open in Companion" />;
  if (s.live) return <span className={`dot ${s.live.status === 'busy' ? 'busy' : 'idle'}`} title={`Running (pid ${s.live.pid})`} />;
  return <span className="dot none" />;
}

function Detail({ s, onOpen, onNewHere }: { s: SessionItem; onOpen: () => void; onNewHere: () => void }) {
  const blocked = s.termId
    ? null
    : s.live
      ? `Running in another terminal (pid ${s.live.pid}).`
      : s.transcriptGone
        ? 'Claude Code deleted this transcript; it can no longer be resumed.'
        : null;
  return (
    <div className="detail">
      <h2>{s.title}</h2>
      <div className="muted mono small">{shortPath(s.cwd)}</div>
      {s.gitBranch && <div className="branch">⎇ {s.gitBranch}</div>}
      <div className="stats">
        <span>{s.prompts} prompts</span>
        <span>{s.messages} messages</span>
        {s.costUsd != null && <span>${s.costUsd.toFixed(2)}</span>}
        {s.lastTs && <span>{new Date(s.lastTs).toLocaleString()}</span>}
      </div>
      <div className="row gap">
        <button className="btn primary" onClick={onOpen} disabled={!!blocked}>
          {s.termId ? 'Go to tab' : 'Resume'}
        </button>
        <button className="btn ghost" onClick={onNewHere} disabled={!s.cwd}>
          New session here
        </button>
      </div>
      {blocked && <p className="muted small">{blocked}</p>}
      {s.summary && (
        <>
          <h3 className="section">Summary</h3>
          <p>{s.summary}</p>
        </>
      )}
      {s.lastPrompt && (
        <>
          <h3 className="section">Last prompt</h3>
          <p className="quote">{s.lastPrompt}</p>
        </>
      )}
    </div>
  );
}
