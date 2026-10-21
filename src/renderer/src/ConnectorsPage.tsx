import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogPlugin, PluginAction, PluginCatalog, PluginConfig, ServerView } from '../../shared/api';
import { api } from './api';

export type ConnectorsTab = 'discover' | 'installed' | 'marketplaces' | 'servers';

interface Props {
  /** Where to open, e.g. from Today's GitHub offer. */
  initial?: { tab: ConnectorsTab; search?: string };
  onError: (message: string) => void;
}

const PAGE = 60;

/**
 * Claude Code's `/plugin`, as a page: browse and search every marketplace's plugins, install and
 * manage them, configure their options, and manage marketplaces and MCP servers. Every change goes
 * through `claude plugin` / `claude mcp`, so it applies to all Claude Code sessions.
 */
export function ConnectorsPage({ initial, onError }: Props) {
  const [tab, setTab] = useState<ConnectorsTab>(initial?.tab ?? 'discover');
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [search, setSearch] = useState(initial?.search ?? '');
  const [category, setCategory] = useState('');
  const [marketplace, setMarketplace] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    void api.listPlugins().then((r) => {
      if (r.ok) {
        setCatalog(r.value);
        setLoadError(null);
      } else setLoadError(r.error);
    });
    void api.listServers().then(setServers);
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (initial) {
      setTab(initial.tab);
      setSearch(initial.search ?? '');
    }
  }, [initial]);
  useEffect(() => setShown(PAGE), [search, category, marketplace, tab]);

  /** Runs a change, reports a failure, and refreshes. */
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>) => {
      setBusy(key);
      try {
        const r = await fn();
        if (!r.ok) onError(r.error);
        return r.ok ? r.value : null;
      } finally {
        setBusy(null);
        reload();
      }
    },
    [onError, reload],
  );
  const act = (action: PluginAction, id: string) => run(`${action}:${id}`, () => api.pluginAction(action, id));

  const plugins = catalog?.plugins ?? [];
  const installed = plugins.filter((p) => p.installed);
  const categories = useMemo(() => [...new Set(plugins.map((p) => p.category).filter((c): c is string => !!c))].sort(), [plugins]);
  const marketplaceNames = useMemo(() => [...new Set(plugins.map((p) => p.marketplace))].sort(), [plugins]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return (tab === 'installed' ? installed : plugins)
      .filter((p) => !category || p.category === category)
      .filter((p) => !marketplace || p.marketplace === marketplace)
      .filter((p) => words.every((w) => `${p.name} ${p.description} ${p.author ?? ''} ${p.category ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => rank(b, q) - rank(a, q) || (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name));
  }, [plugins, installed, tab, search, category, marketplace]);

  const open = plugins.find((p) => p.id === openId) ?? null;
  const builtIn = marketplaceNames.filter((m) => !catalog?.marketplaces.some((k) => k.name === m));

  return (
    <div className="page connectors-page">
      <header className="page-header">
        <div>
          <h1>Connectors</h1>
          <div className="muted">Claude Code's plugins and MCP servers. Changes apply to every Claude Code session you start next.</div>
        </div>
      </header>

      <div className="tabs-row">
        <div className="seg" role="tablist">
          {(
            [
              ['discover', `Discover${catalog ? ` (${plugins.length})` : ''}`],
              ['installed', `Installed (${installed.length})`],
              ['marketplaces', `Marketplaces (${(catalog?.marketplaces.length ?? 0) + builtIn.length})`],
              ['servers', `MCP servers (${servers.length})`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-pressed={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn small quiet" onClick={reload}>
          Refresh
        </button>
      </div>

      {loadError && <div className="banner error">Couldn't read Claude Code's plugins: {loadError}</div>}

      {(tab === 'discover' || tab === 'installed') && (
        <>
          <div className="plugin-filters">
            <input className="input grow" placeholder="Search plugins" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search plugins" autoFocus />
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select className="input" value={marketplace} onChange={(e) => setMarketplace(e.target.value)} aria-label="Marketplace">
              <option value="">All marketplaces</option>
              {marketplaceNames.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          {!catalog && !loadError && <p className="muted">Loading plugins…</p>}
          {catalog && (
            <p className="muted small">
              {filtered.length === 0 ? 'No plugins match.' : `${filtered.length} plugin${filtered.length === 1 ? '' : 's'}`}
            </p>
          )}
          <div className="plugin-grid">
            {filtered.slice(0, shown).map((p) => (
              <PluginCard key={p.id} plugin={p} busy={busy} onOpen={() => setOpenId(p.id)} onInstall={() => void act('install', p.id)} />
            ))}
          </div>
          {filtered.length > shown && (
            <button className="btn show-more" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({filtered.length - shown} left)
            </button>
          )}
        </>
      )}

      {tab === 'marketplaces' && catalog && (
        <Marketplaces catalog={catalog} builtIn={builtIn} busy={busy} run={run} />
      )}

      {tab === 'servers' && <Servers servers={servers} busy={busy} run={run} />}

      {open && (
        <PluginSheet
          plugin={open}
          servers={servers.filter((s) => s.plugin === open.id)}
          busy={busy}
          onAction={(a) => void act(a, open.id)}
          run={run}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

/** Name matches first, then the most installed. */
const rank = (p: CatalogPlugin, q: string) => (!q ? 0 : p.name.toLowerCase() === q ? 3 : p.name.toLowerCase().startsWith(q) ? 2 : p.name.toLowerCase().includes(q) ? 1 : 0);

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

type Run = <T>(key: string, fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>) => Promise<T | null>;

function PluginCard({ plugin: p, busy, onOpen, onInstall }: { plugin: CatalogPlugin; busy: string | null; onOpen: () => void; onInstall: () => void }) {
  return (
    <article className="plugin-card" onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()} aria-label={p.name}>
      <div className="plugin-card-head">
        <span className="plugin-icon" aria-hidden>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="grow">
          <div className="plugin-name ellipsis">{p.name}</div>
          <div className="muted small ellipsis">{p.author ?? p.marketplace}</div>
        </div>
        {p.installed && <span className={`status-pill ${p.installed.enabled ? 'green' : 'muted'}`}>{p.installed.enabled ? 'Installed' : 'Disabled'}</span>}
      </div>
      <p className="plugin-desc">{p.description || 'No description.'}</p>
      <div className="plugin-card-foot">
        <span className="muted small">
          {[p.category, p.installCount ? `${count(p.installCount)} installs` : null].filter(Boolean).join(' · ')}
        </span>
        {!p.installed && (
          <button
            className="btn small"
            disabled={!!busy}
            onClick={(e) => {
              e.stopPropagation();
              onInstall();
            }}
          >
            {busy === `install:${p.id}` ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </article>
  );
}

interface SheetProps {
  plugin: CatalogPlugin;
  servers: ServerView[];
  busy: string | null;
  onAction: (a: PluginAction) => void;
  run: Run;
  onClose: () => void;
}

function PluginSheet({ plugin: p, servers, busy, onAction, run, onClose }: SheetProps) {
  const [details, setDetails] = useState<string | null>(null);
  const [config, setConfig] = useState<PluginConfig | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const installedKey = p.installed ? `${p.installed.version}:${p.installed.enabled}` : null;

  useEffect(() => {
    setDetails(null);
    setConfig(null);
    if (!p.installed) return;
    void api.pluginDetails(p.id).then((r) => setDetails(r.ok ? r.value : null));
    void api.pluginConfig(p.id).then((r) => {
      if (!r.ok) return;
      setConfig(r.value);
      setValues(r.value.inputs);
    });
  }, [p.id, installedKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changed = config ? Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== config.inputs[k])) : {};
  const save = async () => {
    const saved = await run('config', () => api.savePluginConfig(p.id, changed));
    if (saved) {
      const r = await api.pluginConfig(p.id);
      if (r.ok) {
        setConfig(r.value);
        setValues(r.value.inputs);
      }
    }
  };
  const doing = (a: PluginAction) => busy === `${a}:${p.id}`;

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet plugin-sheet" role="dialog" aria-label={p.name} onClick={(e) => e.stopPropagation()}>
        <div className="plugin-card-head">
          <span className="plugin-icon large" aria-hidden>
            {p.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="grow">
            <h2>{p.name}</h2>
            <div className="muted small mono">{p.id}</div>
          </div>
          {p.installed && <span className={`status-pill ${p.installed.enabled ? 'green' : 'muted'}`}>{p.installed.enabled ? 'Installed' : 'Disabled'}</span>}
        </div>
        <p>{p.description || 'No description.'}</p>
        <div className="muted small">
          {[p.author && `by ${p.author}`, p.category, p.version && `v${p.version}`, p.installCount && `${count(p.installCount)} installs`]
            .filter(Boolean)
            .join(' · ')}
          {p.homepage && (
            <>
              {' · '}
              <a href={p.homepage} target="_blank" rel="noreferrer">
                Homepage
              </a>
            </>
          )}
        </div>

        <div className="row gap wrap">
          {!p.installed && (
            <button className="btn primary" disabled={!!busy} onClick={() => onAction('install')}>
              {doing('install') ? 'Installing…' : 'Install'}
            </button>
          )}
          {p.installed && (
            <>
              <button className="btn" disabled={!!busy} onClick={() => onAction(p.installed!.enabled ? 'disable' : 'enable')}>
                {p.installed.enabled ? (doing('disable') ? 'Disabling…' : 'Disable') : doing('enable') ? 'Enabling…' : 'Enable'}
              </button>
              <button className="btn" disabled={!!busy} onClick={() => onAction('update')}>
                {doing('update') ? 'Updating…' : 'Update'}
              </button>
              <button className="btn quiet danger" disabled={!!busy} onClick={() => onAction('uninstall')}>
                {doing('uninstall') ? 'Uninstalling…' : 'Uninstall…'}
              </button>
            </>
          )}
        </div>

        {p.installed && (
          <>
            <h3 className="section">Options</h3>
            {!config && <p className="muted small">Loading…</p>}
            {config && Object.keys(config.schema).length === 0 && <p className="muted small">This plugin has no options.</p>}
            {config && Object.keys(config.schema).length > 0 && (
              <div className="plugin-options">
                {Object.entries(config.schema).map(([key, o]) => (
                  <label className="field" key={key}>
                    <span>
                      {o.title ?? key}
                      {config.unconfigured.includes(key) && <span className="muted"> · not set</span>}
                    </span>
                    {config.choices[key] ? (
                      <select className="input" value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
                        {config.choices[key]!.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input"
                        type={o.sensitive ? 'password' : 'text'}
                        value={values[key] ?? ''}
                        placeholder={o.default != null && o.default !== '' ? String(o.default) : ''}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      />
                    )}
                    {o.description && <span className="muted small">{o.description}</span>}
                  </label>
                ))}
                <div>
                  <button className="btn primary small" disabled={!!busy || Object.keys(changed).length === 0} onClick={() => void save()}>
                    {busy === 'config' ? 'Saving…' : 'Save options'}
                  </button>
                </div>
              </div>
            )}

            {servers.length > 0 && (
              <>
                <h3 className="section">MCP servers</h3>
                <div className="server-list">
                  {servers.map((s) => (
                    <ServerRow key={s.name} server={s} busy={busy} run={run} />
                  ))}
                </div>
              </>
            )}

            <h3 className="section">What it adds</h3>
            {details ? <pre className="plugin-details">{details}</pre> : <p className="muted small">Loading…</p>}
          </>
        )}
        <div className="sheet-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Marketplaces({ catalog, builtIn, busy, run }: { catalog: PluginCatalog; builtIn: string[]; busy: string | null; run: Run }) {
  const [source, setSource] = useState('');
  const counts = (name: string) => catalog.plugins.filter((p) => p.marketplace === name).length;
  const add = async () => {
    if ((await run('market:add', () => api.marketplaceAction('add', source.trim()))) !== null) setSource('');
  };
  return (
    <>
      <div className="server-list">
        {builtIn.map((m) => (
          <div className="server-row" key={m}>
            <div className="grow">
              <div className="mono">{m}</div>
              <div className="muted small">Built into Claude Code · {counts(m)} plugins</div>
            </div>
          </div>
        ))}
        {catalog.marketplaces.map((m) => (
          <div className="server-row" key={m.name}>
            <div className="grow">
              <div className="mono">{m.name}</div>
              <div className="muted small ellipsis">
                {m.repo ?? m.url ?? m.path ?? m.source} · {counts(m.name)} plugins
              </div>
            </div>
            <button className="btn small" disabled={!!busy} onClick={() => void run(`market:update:${m.name}`, () => api.marketplaceAction('update', m.name))}>
              {busy === `market:update:${m.name}` ? 'Updating…' : 'Update'}
            </button>
            <button className="btn small quiet danger" disabled={!!busy} onClick={() => void run(`market:remove:${m.name}`, () => api.marketplaceAction('remove', m.name))}>
              Remove…
            </button>
          </div>
        ))}
      </div>
      <h3 className="section">Add a marketplace</h3>
      <div className="row gap">
        <input
          className="input grow"
          placeholder="owner/repo, a git or https URL, or a folder"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && source.trim() && void add()}
          aria-label="Marketplace source"
        />
        <button className="btn primary" disabled={!source.trim() || !!busy} onClick={() => void add()}>
          {busy === 'market:add' ? 'Adding…' : 'Add'}
        </button>
      </div>
    </>
  );
}

function Servers({ servers, busy, run }: { servers: ServerView[]; busy: string | null; run: Run }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [header, setHeader] = useState('');
  const add = async () => {
    const t = target.trim();
    const [hKey, ...hRest] = header.split(':');
    const headers = header.trim() && hRest.length ? { [hKey!.trim()]: hRest.join(':').trim() } : undefined;
    const config = /^https?:\/\//.test(t)
      ? { type: 'http' as const, url: t, ...(headers ? { headers } : {}) }
      : { type: 'stdio' as const, command: t.split(/\s+/)[0]!, args: t.split(/\s+/).slice(1) };
    if ((await run('server:add', () => api.addServer(name.trim(), config))) !== null) {
      setName('');
      setTarget('');
      setHeader('');
    }
  };
  return (
    <>
      {servers.length === 0 && <p className="muted">No MCP servers yet.</p>}
      <div className="server-list">
        {servers.map((s) => (
          <ServerRow key={s.name} server={s} busy={busy} run={run} />
        ))}
      </div>
      <h3 className="section">Add an MCP server</h3>
      <div className="add-server">
        <input className="input" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Server name" />
        <input className="input grow" placeholder="https://… or a command to run" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Server URL or command" />
        <input className="input" placeholder="Header (optional), e.g. Authorization: Bearer …" value={header} onChange={(e) => setHeader(e.target.value)} aria-label="Header" />
        <button className="btn primary" disabled={!name.trim() || !target.trim() || !!busy} onClick={() => void add()}>
          {busy === 'server:add' ? 'Adding…' : 'Add'}
        </button>
      </div>
      <p className="muted small">
        Added for every Claude Code session (user scope). Servers added for a single project, and connectors that come with your claude.ai
        account, work in your Claude Code chats but aren't listed here.
      </p>
    </>
  );
}

function ServerRow({ server: s, busy, run }: { server: ServerView; busy: string | null; run: Run }) {
  const ok = <T,>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }));
  return (
    <div className="server-row">
      <div className="grow">
        <div className="row gap">
          <span className="mono">{s.name}</span>
          {s.status && <span className={`status-pill ${s.status === 'connected' ? 'green' : 'red'}`}>{s.status === 'connected' ? 'Works' : 'Error'}</span>}
          {s.kind === 'github' && s.enabled && <span className="status-pill muted">In your recap</span>}
        </div>
        <div className={`small ellipsis ${s.status === 'error' ? 'error-text' : 'muted'}`} title={s.detail ?? s.target}>
          {s.transport} · {s.detail ?? s.target}
        </div>
        {s.needs.length > 0 && <div className="small error-text">Needs {s.needs.join(', ')} set in Claude Code's environment</div>}
      </div>
      <button className="btn small" disabled={!!busy} onClick={() => void run(`check:${s.name}`, () => ok(api.checkConnector(s.name)))}>
        {busy === `check:${s.name}` ? 'Checking…' : 'Check'}
      </button>
      {s.kind === 'github' && (
        <button
          className={`btn small ${s.enabled ? '' : 'primary'}`}
          disabled={!!busy}
          onClick={() => void run(`recap:${s.name}`, () => ok(api.setConnectorEnabled(s.name, !s.enabled)))}
        >
          {s.enabled ? 'Leave out of recap' : busy === `recap:${s.name}` ? 'Connecting…' : 'Use in morning recap'}
        </button>
      )}
      {!s.plugin && (
        <button className="btn small quiet danger" disabled={!!busy} onClick={() => void run(`remove:${s.name}`, () => api.removeConnector(s.name))}>
          Remove…
        </button>
      )}
    </div>
  );
}
