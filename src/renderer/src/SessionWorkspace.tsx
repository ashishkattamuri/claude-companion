import { useState } from 'react';
import { api } from './api';
import { Composer, shortModel } from './Composer';
import { Conversation } from './Conversation';
import { DetailsRail } from './DetailsRail';
import { shortPath } from './format';
import { useSession } from './store';
import { TerminalView } from './TerminalView';

type View = 'conversation' | 'split' | 'terminal';

const STATUS: Record<string, { label: string; tone: string }> = {
  waiting: { label: 'Needs you', tone: 'amber' },
  busy: { label: 'Working', tone: 'green' },
  idle: { label: 'Ready', tone: 'green' },
  starting: { label: 'Starting', tone: 'muted' },
  stopped: { label: 'Not running', tone: 'muted' },
  exited: { label: 'Not running', tone: 'muted' },
};

export function SessionWorkspace({ sessionId, draft, onError }: { sessionId: string; draft?: string; onError: (m: string) => void }) {
  const view = useSession(sessionId);
  const [mode, setMode] = useState<View>('conversation');
  const [rail, setRail] = useState(true);
  if (!view) return <div className="loading">Loading session…</div>;
  const { state, items } = view;
  const status = state.mode === 'mirror' ? { label: 'View only · plain terminal', tone: 'muted' } : STATUS[state.status]!;
  const running = state.mode === 'attached' || state.mode === 'background';

  return (
    <div className={`workspace ${rail ? '' : 'no-rail'}`}>
      <section className="main">
        <header className="head">
          <div className="head-text">
            <div className="head-title">
              <h1>{state.title}</h1>
              <span className={`status-pill ${status.tone}`}>● {status.label}</span>
            </div>
            <div className="crumbs">
              <span className="mono">{shortPath(state.cwd)}</span>
              {state.facts.model && <span>{shortModel(state.facts.model)}</span>}
              {state.elsewhere && <span>{state.elsewhere}</span>}
              {state.jobId && (
                <span className="mono" title="Run this in any terminal to drive the same session there">
                  claude attach {state.jobId}
                </span>
              )}
            </div>
          </div>
          <div className="head-actions">
            <div className="seg" role="group" aria-label="View">
              {(['conversation', 'split', 'terminal'] as View[]).map((v) => (
                <button key={v} aria-pressed={mode === v} onClick={() => setMode(v)}>
                  {v[0]!.toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={() => setRail(!rail)} aria-pressed={rail}>
              Details
            </button>
            {running && (
              <>
                <button
                  className="icon-btn"
                  onClick={() => void api.openInTerminal(sessionId).then((r) => !r.ok && onError(r.error))}
                  title="Open this live session in Terminal or iTerm as well"
                >
                  Open in Terminal
                </button>
                <button className="icon-btn" onClick={() => void api.stop(sessionId)} title="Stop the session (claude stop). You can continue it later.">
                  End
                </button>
              </>
            )}
          </div>
        </header>

        <div className={`panes ${mode}`}>
          {mode !== 'terminal' && (
            <div className="convo-pane">
              <Conversation items={items} state={state} sentFromApp={view.sentFromApp} onAnswer={(key) => api.answer(sessionId, key)} />
              <Composer
                state={state}
                draft={draft}
                onSend={async (text) => {
                  const r = await api.send(sessionId, text);
                  return r.ok ? null : r.error;
                }}
                onInterrupt={() => api.interrupt(sessionId)}
                onCycleMode={() => api.cyclePermissionMode(sessionId)}
              />
            </div>
          )}
          {mode !== 'conversation' && (
            <TerminalView sessionId={sessionId} interactive={state.mode === 'attached'} visible />
          )}
        </div>
      </section>
      {rail && <DetailsRail state={state} items={items} />}
    </div>
  );
}
