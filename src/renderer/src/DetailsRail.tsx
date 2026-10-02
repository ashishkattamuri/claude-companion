import type { ConversationItem, SessionState } from '../../shared/api';
import { describeTool } from './turns';

type Tool = Extract<ConversationItem, { kind: 'tool' }>;

/** Context window size: 1M for the long-context models, otherwise 200k. */
const windowFor = (tokens: number) => (tokens > 200_000 ? 1_000_000 : 200_000);
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function DetailsRail({ state, items }: { state: SessionState; items: ConversationItem[] }) {
  const { facts } = state;
  const files = new Map<string, { added: number; removed: number }>();
  for (const it of items) {
    if (it.kind !== 'tool' || !['Edit', 'MultiEdit', 'Write'].includes(it.name) || it.result?.isError) continue;
    const d = describeTool(it as Tool, state.cwd);
    if (!d.file) continue;
    const f = files.get(d.file) ?? { added: 0, removed: 0 };
    files.set(d.file, { added: f.added + d.added, removed: f.removed + d.removed });
  }
  const turns = items.filter((i) => i.kind === 'user').length;
  const ctx = facts.contextTokens;
  const pct = ctx ? Math.min(100, Math.round((ctx / windowFor(ctx)) * 100)) : null;

  return (
    <aside className="rail" aria-label="Session details">
      <section>
        <h2>Context window</h2>
        {ctx ? (
          <>
            <div className="rail-big">
              <span className="big">{pct}%</span>
              <span className="muted small tabular">
                {k(ctx)} / {k(windowFor(ctx))} tokens
              </span>
            </div>
            <div className="meter">
              <span className={pct! > 80 ? 'hot' : ''} style={{ width: `${pct}%` }} />
            </div>
            <p className="muted small">As of Claude's last reply.</p>
          </>
        ) : (
          <p className="muted small">Shows after Claude's first reply.</p>
        )}
      </section>

      {facts.todos && facts.todos.length > 0 && (
        <section>
          <h2>Plan</h2>
          {facts.todos.map((t, i) => (
            <div key={i} className={`todo ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}`}>
              <span className="box">{t.status === 'completed' ? '✓' : ''}</span>
              {t.content}
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Files changed</h2>
        {files.size === 0 && <p className="muted small">None yet.</p>}
        {[...files].map(([f, s]) => (
          <div key={f} className="file" title={f}>
            <span className="ellipsis">{f}</span>
            <span className="tabular">
              {s.added > 0 && <span className="stat-add">+{s.added}</span>} {s.removed > 0 && <span className="stat-del">−{s.removed}</span>}
            </span>
          </div>
        ))}
      </section>

      <section>
        <h2>This session</h2>
        <div className="kv">
          <span>Messages from you</span>
          <span className="tabular">{turns}</span>
          {facts.costUsd != null && (
            <>
              <span>Cost so far</span>
              <span className="tabular">${facts.costUsd.toFixed(2)}</span>
            </>
          )}
          <span>Folder</span>
          <span className="mono ellipsis" title={state.cwd ?? ''}>
            {state.cwd?.split('/').pop()}
          </span>
        </div>
      </section>

      <div className="later">Context tools (compact, pin files, hand off to a fresh session) come in the next phase.</div>
    </aside>
  );
}
