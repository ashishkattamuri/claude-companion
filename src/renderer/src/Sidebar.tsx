import { useEffect, useState, type MouseEvent } from 'react';
import type { SessionListItem } from '../../shared/api';
import { shortPath, timeAgo } from './format';

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
  onHide: (ids: string[], hidden: boolean) => void;
  /** Resolves true once the chats are gone (false if cancelled or refused). */
  onDelete: (ids: string[]) => Promise<boolean>;
}

type Row = { s: SessionListItem; depth: number };
type Menu = { ids: string[]; x: number; y: number };

const FOLDER_KEY = 'sidebar.folder';

export function Sidebar({ page, sessions: all, selectedId, search, onSearch, onPage, onSelect, onNew, onHide, onDelete }: Props) {
  const [showHidden, setShowHidden] = useState(false);
  /** Only this folder's chats; empty for all folders. Kept across restarts. */
  const [folder, setFolder] = useState(() => localStorage.getItem(FOLDER_KEY) ?? '');
  const [menu, setMenu] = useState<Menu | null>(null);
  /** Chats picked with ⌘-click or shift-click, to hide or delete together. */
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const byId = new Map(all.map((s) => [s.id, s]));
  const folders = folderOptions(showHidden ? all : all.filter((s) => !s.hidden), folder);
  const scoped = folder ? all.filter((s) => inFolder(s, folder, byId)) : all;
  const hiddenCount = scoped.filter((s) => s.hidden).length;
  const sessions = showHidden ? scoped : scoped.filter((s) => !s.hidden);
  const needs = sessions.filter((s) => s.status === 'waiting');
  const running = sessions.filter((s) => s.status !== 'waiting' && (s.attached || s.live));
  const earlier = sessions.filter((s) => s.status !== 'waiting' && !s.attached && !s.live).slice(0, 80);
  const groups: { label: string; count?: number; rows: Row[] }[] = search
    ? [{ label: 'Matches', count: sessions.length, rows: nest(sessions) }]
    : [
        ...(needs.length ? [{ label: 'Needs you', count: needs.length, rows: nest(needs) }] : []),
        ...(running.length ? [{ label: 'Running', count: running.length, rows: nest(running) }] : []),
        { label: 'Earlier', rows: nest(earlier) },
      ];
  const order = groups.flatMap((g) => g.rows.map((r) => r.s.id));
  const shown = new Set(order);
  const chosen = picked.filter((id) => shown.has(id));
  const allHidden = (ids: string[]) => ids.every((id) => byId.get(id)?.hidden);
  /** A plain claude in another terminal can't be stopped from here. */
  const blocked = (ids: string[]) => ids.some((id) => byId.get(id)?.live && !byId.get(id)?.background);

  useEffect(() => {
    if (!hiddenCount) setShowHidden(false);
  }, [hiddenCount]);

  useEffect(() => {
    if (folder) localStorage.setItem(FOLDER_KEY, folder);
    else localStorage.removeItem(FOLDER_KEY);
  }, [folder]);

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

  useEffect(() => {
    if (!chosen.length) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPicked([]);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chosen.length]);

  const click = (e: MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey) {
      setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
      setAnchor(id);
    } else if (e.shiftKey) {
      const to = order.indexOf(id);
      const from = order.indexOf(anchor ?? selectedId ?? id);
      const range = from < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
      setPicked((p) => [...new Set([...p, ...range])]);
    } else {
      setPicked([]);
      setAnchor(id);
      onSelect(id);
    }
  };
  // Opened on a picked chat, the menu acts on all of them; otherwise on that row alone.
  const openMenu = (id: string, x: number, y: number) => setMenu({ ids: chosen.includes(id) ? chosen : [id], x, y });
  const hide = (ids: string[]) => {
    onHide(ids, !allHidden(ids));
    setPicked([]);
  };
  const remove = (ids: string[]) => void onDelete(ids).then((done) => done && setPicked([]));
  const several = (ids: string[]) => (ids.length > 1 ? ` ${ids.length} chats` : '');

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
      <select
        className="folder-filter"
        aria-label="Show chats from"
        title={folder ? shortPath(folder) : undefined}
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
      >
        <option value="">All folders</option>
        {folders.map((f) => (
          <option key={f.path} value={f.path}>
            {f.label} ({f.count})
          </option>
        ))}
      </select>
      <div className="sessions">
        {groups.map((g) => (
          <Group key={g.label} {...g} selectedId={selectedId} picked={chosen} onClick={click} onMenu={openMenu} />
        ))}
      </div>
      {chosen.length > 0 ? (
        <div className="sidebar-foot picked-bar">
          <span>{chosen.length} selected</span>
          <span className="picked-actions">
            <button className="link-btn" onClick={() => hide(chosen)}>
              {allHidden(chosen) ? 'Show' : 'Hide'}
            </button>
            <button
              className="link-btn danger"
              disabled={blocked(chosen)}
              title={blocked(chosen) ? 'Some run in another terminal: quit them there first' : undefined}
              onClick={() => remove(chosen)}
            >
              Delete…
            </button>
            <button className="link-btn" aria-label="Clear selection" onClick={() => setPicked([])}>
              ✕
            </button>
          </span>
        </div>
      ) : (
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
      )}
      {menu && (
        <div
          className="row-menu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 90) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              hide(menu.ids);
            }}
          >
            {allHidden(menu.ids) ? 'Show in sidebar' : 'Hide'}
            {several(menu.ids)}
          </button>
          <button
            role="menuitem"
            className="danger"
            disabled={blocked(menu.ids)}
            title={blocked(menu.ids) ? 'Running in another terminal: quit it there first' : undefined}
            onClick={() => {
              setMenu(null);
              remove(menu.ids);
            }}
          >
            Delete{several(menu.ids)}…
          </button>
        </div>
      )}
    </aside>
  );
}

function Group({
  label,
  count,
  rows,
  selectedId,
  picked,
  onClick,
  onMenu,
}: {
  label: string;
  count?: number;
  rows: Row[];
  selectedId: string | null;
  picked: string[];
  onClick: (e: MouseEvent, id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
}) {
  return (
    <>
      <div className="group">
        <span>{label}</span>
        {count !== undefined && <span>{count}</span>}
      </div>
      {rows.length === 0 && <div className="muted small group-empty">Nothing here.</div>}
      {rows.map(({ s, depth }) => (
        <div key={s.id} className="s-row-wrap">
          <button
            className={`s-row ${selectedId === s.id ? 'selected' : ''} ${picked.includes(s.id) ? 'picked' : ''} ${depth ? 'child' : ''} ${s.hidden ? 'hidden-row' : ''}`}
            style={depth ? { paddingLeft: 8 + 16 * Math.min(depth, 3) } : undefined}
            onClick={(e) => onClick(e, s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(s.id, e.clientX, e.clientY);
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
              onMenu(s.id, r.left, r.bottom + 2);
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
function nest(items: SessionListItem[]): Row[] {
  const ids = new Set(items.map((s) => s.id));
  const kids = new Map<string, SessionListItem[]>();
  for (const s of items) if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const out: Row[] = [];
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

/** The folder a chat belongs to. A worktree (`<repo>/.claude/worktrees/<name>`) belongs to its repo. */
const folderOf = (cwd: string | null) => cwd?.replace(/[/\\]\.claude[/\\]worktrees[/\\].*$/, '') ?? null;

/** In the folder, or opened from a chat that is, so child chats stay with their parent. */
function inFolder(s: SessionListItem, folder: string, byId: Map<string, SessionListItem>): boolean {
  const seen = new Set<string>();
  for (let c: SessionListItem | undefined = s; c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
    if (folderOf(c.cwd) === folder) return true;
    seen.add(c.id);
  }
  return false;
}

/** Folders that have chats, with how many. The picked one stays listed even when it has none. */
function folderOptions(items: SessionListItem[], picked: string) {
  const counts = new Map<string, number>();
  for (const s of items) {
    const f = folderOf(s.cwd);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  if (picked && !counts.has(picked)) counts.set(picked, 0);
  const options = [...counts].map(([path, count]) => ({ path, count, name: path.split(/[/\\]/).pop() || path }));
  // Two folders with the same name (~/work/api, ~/oss/api) are told apart by their path.
  return options
    .map((o) => ({ ...o, label: options.some((p) => p !== o && p.name === o.name) ? shortPath(o.path) : o.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
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
