import type { OpenRequest, RecapView as Recap } from '../../shared/api';
import { greeting } from './format';

interface Props {
  data: Recap | null;
  onOpen: (req: OpenRequest) => void;
  onRegenerate: () => void;
}

export function RecapView({ data, onOpen, onRegenerate }: Props) {
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

      {!row && !running && (
        <div className="empty">
          <h2>No recap yet</h2>
          <p className="muted">
            The recap covers your last working day in Claude Code. There was no activity in the past week, or it hasn't
            been written yet.
          </p>
        </div>
      )}

      {row && (
        <>
          <p className="headline">{row.recap.headline}</p>
          <div className="muted small">
            Covering{' '}
            {new Date(row.windowStart).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} ·{' '}
            {row.sessionIds.length} session{row.sessionIds.length === 1 ? '' : 's'} · written{' '}
            {new Date(row.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </div>

          <h3 className="section">Action items</h3>
          {row.recap.action_items.length === 0 && <p className="muted">Nothing pending.</p>}
          <div className="cards">
            {row.recap.action_items.map((a, i) => (
              <article className="card action" key={i}>
                <div className="row gap">
                  <span className={`priority ${a.priority}`}>{a.priority}</span>
                  <span className="chip">{a.project}</span>
                </div>
                <p className="action-text">{a.text}</p>
                <p className="muted small">{a.why}</p>
                <div className="row gap">
                  <button
                    className="btn primary"
                    onClick={() => onOpen({ kind: 'action', mode: 'new', sessionId: a.session_id, project: a.project, text: a.text })}
                  >
                    Start session
                  </button>
                  {a.session_id && (
                    <button
                      className="btn ghost"
                      onClick={() =>
                        onOpen({ kind: 'action', mode: 'continue', sessionId: a.session_id, project: a.project, text: a.text })
                      }
                    >
                      Continue where I left off
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>

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
                <div className="project-name">{p.project}</div>
                <p>{p.summary}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
