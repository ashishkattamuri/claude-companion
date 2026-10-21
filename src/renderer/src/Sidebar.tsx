import { useEffect, useState } from 'react';
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
  onHide: (id: string, hidden: boolean) => void;
  onDelete: (id: string) => void;
}

type Menu = { s: SessionListItem; x: number; y: number };

export function Sidebar({ page, sessions: all, selectedId, search, onSearch, onPage, onSelect, onNew, onHide, onDelete }: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const hiddenCount = all.filter((s) => s.hidden).length;
  const sessions = showHidden ? all : all.filter((s) => !s.hidden);
  const needs = sessions.filter((s) => s.status === 'waiting');
  const running = sessions.filter((s) => s.status !== 'waiting' && (s.attached || s.live));
  const earlier = sessions.filter((s) => s.status !== 'waiting' && !s.attached && !s.live).slice(0, 80);
  const group = { selectedId, onSelect, onMenu: setMenu };

  useEffect(() => {
    if (!hiddenCount) setShowHidden(false);
  }, [hiddenCount]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

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
        {search && <Group label="Matches" count={sessions.length} items={sessions} {...group} />}
        {!search && (
          <>
            {needs.length > 0 && <Group label="Needs you" count={needs.length} items={needs} {...group} />}
            {running.length > 0 && <Group label="Running" count={running.length} items={running} {...group} />}
            <Group label="Earlier" items={earlier} {...group} />
          </>
        )}
      </div>
      <div className="sidebar-foot">
        <span>
          {running.length + needs.length} live{needs.length ? ` · ${needs.length} need${needs.length > 1 ? '' : 's'} you` : ''}
        </span>
        {hiddenCount > 0 && (
          <button className="link-btn" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
          </button>
        )}
      </div>
      {menu && (
        <div className="row-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 90) }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onHide(menu.s.id, !menu.s.hidden);
            }}
          >
            {menu.s.hidden ? 'Show in sidebar' : 'Hide'}
          </button>
          <button
            role="menuitem"
            className="danger"
            disabled={!!menu.s.live && !menu.s.background}
            title={menu.s.live && !menu.s.background ? 'Running in another terminal: quit it there first' : undefined}
            onClick={() => {
              setMenu(null);
              onDelete(menu.s.id);
            }}
          >
            Delete…
          </button>
        </div>
      )}
    </aside>
  );
}

function Group({
  label,
  count,
  items,
  selectedId,
  onSelect,
  onMenu,
}: {
  label: string;
  count?: number;
  items: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMenu: (m: Menu) => void;
}) {
  return (
    <>
      <div className="group">
        <span>{label}</span>
        {count !== undefined && <span>{count}</span>}
      </div>
      {items.length === 0 && <div className="muted small group-empty">Nothing here.</div>}
      {nest(items).map(({ s, depth }) => (
        <div key={s.id} className="s-row-wrap">
          <button
            className={`s-row ${selectedId === s.id ? 'selected' : ''} ${depth ? 'child' : ''} ${s.hidden ? 'hidden-row' : ''}`}
            style={depth ? { paddingLeft: 8 + 16 * Math.min(depth, 3) } : undefined}
            onClick={() => onSelect(s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu({ s, x: e.clientX, y: e.clientY });
            }}
          >
            <span className={`dot ${dotClass(s)}`} title={dotTitle(s)} />
            <span className="s-title">
              {depth > 0 && <span className="branch-mark" aria-hidden="true">↳ </span>}
              {s.title}
            </span>
            <span className="s-time">{s.status === 'busy' ? 'now' : timeAgo(s.lastTs, Date.now(), true)}</span>
            <span className="s-meta">
              <span className="proj">{s.project ?? '?'}</span>
              {s.live && !s.background && <span className="where" title="A plain claude in another terminal: view only">other terminal</span>}
              {s.status === 'waiting' && <span className="needs-label">needs you</span>}
              {s.transcriptGone && <span className="where">archived</span>}
              {s.hidden && <span className="where">hidden</span>}
            </span>
          </button>
          <button
            className="s-more"
            aria-label="More actions"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu({ s, x: r.left, y: r.bottom + 2 });
            }}
          >
            ⋯
          </button>
        </div>
      ))}
    </>
  );
}

/** Puts chats opened from another chat right under it, indented, when both are in the same list. */
function nest(items: SessionListItem[]): { s: SessionListItem; depth: number }[] {
  const ids = new Set(items.map((s) => s.id));
  const kids = new Map<string, SessionListItem[]>();
  for (const s of items) if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const out: { s: SessionListItem; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (s: SessionListItem, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ s, depth });
    for (const k of kids.get(s.id) ?? []) walk(k, depth + 1);
  };
  for (const s of items) if (!s.parentId || !ids.has(s.parentId)) walk(s, 0);
  for (const s of items) walk(s, 0);
  return out;
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
