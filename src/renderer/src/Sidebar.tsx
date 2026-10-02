import type { SessionListItem } from '../../shared/api';
import { timeAgo } from './format';

export type Page = 'today' | 'ideas' | 'goals' | 'feed' | 'connectors';

const PAGES: { id: Page; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5' },
  { id: 'ideas', label: 'Ideas', icon: 'M8 2.5a4 4 0 0 0-2.3 7.3V12h4.6V9.8A4 4 0 0 0 8 2.5zM6.5 14h3' },
  { id: 'goals', label: 'Goals', icon: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z' },
  { id: 'feed', label: 'Feed', icon: 'M3 4h10M3 8h10M3 12h6' },
  { id: 'connectors', label: 'Connectors', icon: 'M6 3v3M10 3v3M4.5 6h7v2.5a3.5 3.5 0 0 1-7 0zM8 12v2' },
];

interface Props {
  page: Page | null;
  sessions: SessionListItem[];
  selectedId: string | null;
  search: string;
  onSearch: (q: string) => void;
  onPage: (p: Page) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function Sidebar({ page, sessions, selectedId, search, onSearch, onPage, onSelect, onNew }: Props) {
  const needs = sessions.filter((s) => s.status === 'waiting');
  const running = sessions.filter((s) => s.status !== 'waiting' && (s.attached || s.live));
  const earlier = sessions.filter((s) => s.status !== 'waiting' && !s.attached && !s.live).slice(0, 80);

  return (
    <aside className="sidebar">
      <div className="drag-region" />
      <nav className="nav" aria-label="Pages">
        {PAGES.map((p) => (
          <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => onPage(p.id)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d={p.icon} />
            </svg>
            {p.label}
          </button>
        ))}
      </nav>
      <button className="new-btn" onClick={onNew}>
        New session <span className="kbd">⌘N</span>
      </button>
      <input
        className="search"
        id="session-search"
        placeholder="Search sessions and messages"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <div className="sessions">
        {search && <Group label="Matches" count={sessions.length} items={sessions} selectedId={selectedId} onSelect={onSelect} />}
        {!search && (
          <>
            {needs.length > 0 && <Group label="Needs you" count={needs.length} items={needs} selectedId={selectedId} onSelect={onSelect} />}
            {running.length > 0 && <Group label="Running" count={running.length} items={running} selectedId={selectedId} onSelect={onSelect} />}
            <Group label="Earlier" items={earlier} selectedId={selectedId} onSelect={onSelect} />
          </>
        )}
      </div>
      <div className="sidebar-foot">
        <span>
          {running.length + needs.length} live{needs.length ? ` · ${needs.length} need${needs.length > 1 ? '' : 's'} you` : ''}
        </span>
      </div>
    </aside>
  );
}

function Group({
  label,
  count,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  count?: number;
  items: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="group">
        <span>{label}</span>
        {count !== undefined && <span>{count}</span>}
      </div>
      {items.length === 0 && <div className="muted small group-empty">Nothing here.</div>}
      {items.map((s) => (
        <button key={s.id} className={`s-row ${selectedId === s.id ? 'selected' : ''}`} onClick={() => onSelect(s.id)}>
          <span className={`dot ${dotClass(s)}`} title={dotTitle(s)} />
          <span className="s-title">{s.title}</span>
          <span className="s-time">{s.status === 'busy' ? 'now' : timeAgo(s.lastTs, Date.now(), true)}</span>
          <span className="s-meta">
            <span className="proj">{s.project ?? '?'}</span>
            {s.live && !s.background && <span className="where" title="A plain claude in another terminal: view only">other terminal</span>}
            {s.status === 'waiting' && <span className="needs-label">needs you</span>}
            {s.transcriptGone && <span className="where">archived</span>}
          </span>
        </button>
      ))}
    </>
  );
}

const dotClass = (s: SessionListItem) =>
  s.status === 'waiting' ? 'needs' : s.status === 'busy' ? 'working' : s.background ? 'open' : s.live ? 'external' : 'idle';

const dotTitle = (s: SessionListItem) =>
  s.status === 'waiting'
    ? 'Waiting for you'
    : s.status === 'busy'
      ? 'Claude is working'
      : s.background
        ? 'Running · drive it here or in any attached terminal'
        : s.live
          ? 'Running in a plain terminal (view only)'
          : 'Not running';
