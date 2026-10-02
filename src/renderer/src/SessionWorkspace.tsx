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

export function SessionWorkspace({ sessionId, draft }: { sessionId: string; draft?: string }) {
  const view = useSession(sessionId);
  const [mode, setMode] = useState<View>('conversation');
  const [rail, setRail] = useState(true);
  if (!view) return <div className="loading">Loading session…</div>;
  const { state, items } = view;
  const status = state.mode === 'mirror' ? { label: 'In another terminal', tone: 'green' } : STATUS[state.status]!;
  const owned = state.mode === 'owned';

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
            {owned && (
              <button className="icon-btn" onClick={() => void api.stop(sessionId)} title="End the claude process. You can continue the session later.">
                End
              </button>
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
            <TerminalView sessionId={sessionId} interactive={owned && state.status !== 'stopped'} visible />
          )}
        </div>
      </section>
      {rail && <DetailsRail state={state} items={items} />}
    </div>
  );
}
