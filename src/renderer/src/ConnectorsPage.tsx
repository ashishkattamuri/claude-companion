import { useCallback, useEffect, useState } from 'react';
import type { ConnectorsView, ServerView } from '../../shared/api';
import { api } from './api';

/** A fine-grained token with only the read permissions the recap needs. */
const TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Claude%20Companion&description=Read-only%20GitHub%20access%20for%20Claude%20Companion' +
  '&pull_requests=read&issues=read&statuses=read&contents=read';

interface Props {
  onError: (message: string) => void;
}

export function ConnectorsPage({ onError }: Props) {
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => void api.listConnectors().then(setView), []);
  useEffect(() => {
    reload();
    return api.onChanged(reload);
  }, [reload]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
      reload();
    }
  };

  const remove = (name: string) =>
    run(`remove:${name}`, async () => {
      const r = await api.removeConnector(name);
      if (!r.ok) onError(r.error);
    });

  if (!view) return <div className="page" />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Connectors</h1>
          <div className="muted">
            MCP servers from Claude Code. Companion only reads from the ones you turn on, and never changes anything on them.
          </div>
        </div>
      </header>

      <div className="connectors">
        {view.connectors.map((c) => (
          <article className="connector" key={c.kind}>
            <div className="connector-head">
              <h2>{c.label}</h2>
              <StatusPill server={c.server} available={c.available} />
            </div>
            <p className="muted">{c.uses}</p>
            {c.available && c.kind === 'github' && (
              <GitHubBody server={c.server} busy={busy} run={run} onRemove={remove} onError={onError} />
            )}
          </article>
        ))}
      </div>

      <h3 className="section">Other servers in Claude Code</h3>
      {view.others.length === 0 && <p className="muted">None.</p>}
      <div className="server-list">
        {view.others.map((s) => (
          <div className="server-row" key={s.name}>
            <div className="grow">
              <div className="row gap">
                <span className="mono">{s.name}</span>
                {s.status && <span className={`status-pill ${s.status === 'connected' ? 'green' : 'red'}`}>{s.status === 'connected' ? 'Works' : 'Error'}</span>}
              </div>
              <div className="muted small ellipsis" title={s.detail ?? s.target}>
                {s.transport} · {s.detail ?? s.target}
              </div>
            </div>
            <button className="btn small" disabled={!!busy} onClick={() => void run(`check:${s.name}`, () => api.checkConnector(s.name))}>
              {busy === `check:${s.name}` ? 'Checking…' : 'Check'}
            </button>
          </div>
        ))}
      </div>
      <p className="muted small">
        Servers added for a single project, and connectors that come with your claude.ai account, work in your Claude Code chats but
        aren't listed here.
      </p>
    </div>
  );
}

function StatusPill({ server, available }: { server: ServerView | null; available: boolean }) {
  if (!available) return <span className="status-pill muted">Later</span>;
  if (!server) return <span className="status-pill muted">Not connected</span>;
  if (!server.enabled) return <span className="status-pill muted">Off</span>;
  if (server.status === 'error') return <span className="status-pill red">Error</span>;
  if (server.status === 'connected') return <span className="status-pill green">Connected</span>;
  return <span className="status-pill muted">Not checked</span>;
}

interface BodyProps {
  server: ServerView | null;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  onError: (message: string) => void;
}

function GitHubBody({ server, busy, run, onRemove, onError }: BodyProps) {
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);

  const connect = () =>
    run('connect', async () => {
      const r = await api.connectGitHub(token);
      if (!r.ok) return onError(r.error);
      setToken('');
      setReplacing(false);
    });

  const tokenForm = (
    <div className="token-form">
      <ol className="steps">
        <li>
          <a href={TOKEN_URL} target="_blank" rel="noreferrer">
            Create a token on GitHub
          </a>
          . Pick the account or organisation whose repositories you want, and give it read-only access to pull requests, issues,
          commit statuses and contents.
        </li>
        <li>
          Paste it here. Companion adds GitHub's read-only MCP server to Claude Code with it, so it also works in your Claude Code
          chats. The token is kept in Claude Code's settings, not in Companion.
        </li>
      </ol>
      <div className="row gap">
        <input
          className="input grow"
          type="password"
          placeholder="github_pat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && void connect()}
          aria-label="GitHub token"
        />
        <button className="btn primary" disabled={!token || !!busy} onClick={() => void connect()}>
          {busy === 'connect' ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  );

  if (!server) return tokenForm;

  const name = server.name;
  return (
    <>
      <div className="server-row">
        <div className="grow">
          <div className="mono">{name}</div>
          <div className={`small ${server.status === 'error' ? 'error-text' : 'muted'}`}>
            {server.enabled ? (server.detail ?? 'Not checked yet') : 'In Claude Code. Companion is not reading from it.'}
          </div>
        </div>
        <div className="row gap">
          {server.enabled ? (
            <>
              <button className="btn small" disabled={!!busy} onClick={() => void run('check', () => api.checkConnector(name))}>
                {busy === 'check' ? 'Checking…' : 'Check'}
              </button>
              <button className="btn small" disabled={!!busy} onClick={() => void run('off', () => api.setConnectorEnabled(name, false))}>
                Turn off
              </button>
            </>
          ) : (
            <button className="btn small primary" disabled={!!busy} onClick={() => void run('on', () => api.setConnectorEnabled(name, true))}>
              {busy === 'on' ? 'Connecting…' : 'Use in Companion'}
            </button>
          )}
          <button className="btn small quiet danger" disabled={!!busy} onClick={() => void onRemove(name)}>
            Remove from Claude Code…
          </button>
        </div>
      </div>
      {server.status === 'error' && !replacing && (
        <button className="link" onClick={() => setReplacing(true)}>
          Use a new token
        </button>
      )}
      {replacing && tokenForm}
    </>
  );
}
