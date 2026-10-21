import type { GitHubItem, RecapView } from '../../shared/api';
import { api } from './api';
import { greeting } from './format';

interface Props {
  data: RecapView | null;
  /** Start a new session on an action item. */
  onStart: (project: string, sessionId: string, text: string) => void;
  /** Open the session an item came from, with the item ready to send. */
  onContinue: (sessionId: string, text: string) => void;
  onRegenerate: () => void;
  /** Opens Connectors at a tab, e.g. the GitHub plugin or your GitHub server. */
  onConnectors: (at: { tab: 'discover' | 'servers'; search?: string }) => void;
}

export function TodayView({ data, onStart, onContinue, onRegenerate, onConnectors }: Props) {
  const status = data?.status;
  const running = status?.state === 'running';
  const row = data?.recap;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{greeting()}</h1>
          <div className="muted">{today}</div>
        </div>
        <button className="btn" onClick={onRegenerate} disabled={running}>
          {running ? 'Working…' : row ? 'Rewrite recap' : 'Write recap'}
        </button>
      </header>

      {running && (
        <div className="banner info">
          <span className="spinner" /> Preparing your recap: {status.step}
          {status.total ? ` (${status.done}/${status.total})` : ''}
        </div>
      )}
      {(status?.state === 'error' || status?.state === 'paused') && <div className="banner error">{status.error}</div>}

      {data?.githubOffer && (
        <div className="banner info offer">
          <div className="grow">
            <strong>Add GitHub to your recap?</strong>
            <div className="muted small">
              PRs waiting on your review, failing CI and new issues, read through
              {data.githubOffer.existing ? <> your <span className="mono">{data.githubOffer.existing}</span> MCP server</> : ' the GitHub plugin'}.
            </div>
          </div>
          <button
            className="btn primary small"
            onClick={() => onConnectors(data.githubOffer!.existing ? { tab: 'servers' } : { tab: 'discover', search: 'github' })}
          >
            {data.githubOffer.existing ? 'Use it' : 'Find the GitHub plugin'}
          </button>
          <button className="btn quiet small" onClick={() => void api.dismissGithubOffer()}>
            Not now
          </button>
        </div>
      )}

      {!row && !running && (
        <div className="empty">
          <h2>No recap yet</h2>
          <p className="muted">The recap covers your last working day in Claude Code. Nothing from the past week has been recapped yet.</p>
        </div>
      )}

      {row && (
        <>
          {row.prunedAt && (
            <div className="banner info">
              <span className="grow">Deleted chats were taken out of this recap. The summary may still mention them.</span>
              <button className="btn small" onClick={onRegenerate} disabled={running}>
                Rewrite recap
              </button>
            </div>
          )}
          <p className="headline">{row.recap.headline}</p>
          <div className="muted small">
            Covering {new Date(row.windowStart).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} ·{' '}
            {row.sessionIds.length} session{row.sessionIds.length === 1 ? '' : 's'} · written{' '}
            {new Date(row.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </div>

          <h3 className="section">Action items</h3>
          {row.recap.action_items.length === 0 && <p className="muted">Nothing pending.</p>}
          <div className="actions-list">
            {row.recap.action_items.map((a, i) => (
              <article className="action-item" key={i}>
                <span className={`priority ${a.priority}`}>{a.priority}</span>
                <div className="action-body">
                  <p className="action-text">{a.text}</p>
                  <p className="muted small">
                    {a.why} · <span className="mono">{a.project}</span>
                  </p>
                </div>
                <div className="action-buttons">
                  <button className="btn primary" onClick={() => onStart(a.project, a.session_id, a.text)}>
                    Start session
                  </button>
                  {a.session_id && (
                    <button className="btn quiet" onClick={() => onContinue(a.session_id, a.text)}>
                      Continue its session
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>

          {data?.source && <GitHubSection source={data.source} />}

          {row.recap.blockers.length > 0 && (
            <>
              <h3 className="section">Blocked</h3>
              <ul className="blockers">
                {row.recap.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </>
          )}

          <h3 className="section">By project</h3>
          <div className="projects">
            {row.recap.projects.map((p) => (
              <div className="project" key={p.project}>
                <div className="project-name mono">{p.project}</div>
                <p>{p.summary}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const GROUPS = [
  ['awaitingReview', 'Waiting on your review'],
  ['failingCi', 'Your PRs with failing checks'],
  ['newIssues', 'New issues'],
  ['merged', 'Merged'],
] as const;

/** Straight from GitHub, so it's exact whatever the recap says. */
function GitHubSection({ source }: { source: NonNullable<RecapView['source']> }) {
  const gh = source.github;
  return (
    <>
      <h3 className="section">GitHub</h3>
      {source.githubError && <p className="error-text small">Couldn't read GitHub for this recap: {source.githubError}</p>}
      {gh && GROUPS.every(([k]) => gh[k].length === 0) && <p className="muted">Nothing new on GitHub.</p>}
      {gh && (
        <div className="gh-groups">
          {GROUPS.filter(([k]) => gh[k].length > 0).map(([k, label]) => (
            <div key={k}>
              <div className="gh-label">
                {label} <span className="muted">{gh[k].length}</span>
              </div>
              <ul className="gh-list">
                {gh[k].map((i: GitHubItem) => (
                  <li key={i.url}>
                    <a href={i.url} target="_blank" rel="noreferrer">
                      <span className="mono muted">
                        {i.repo}#{i.number}
                      </span>{' '}
                      {i.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
