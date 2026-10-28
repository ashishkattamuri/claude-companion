import { useCallback, useState } from 'react';
import { api } from './api';
import { AuditPanel, useAudit, wasteLabel } from './AuditPanel';
import { Composer, shortModel } from './Composer';
import { Conversation } from './Conversation';
import { DetailsRail, useExtras } from './DetailsRail';
import { SidePanel, useSideChats, type SideAnchor, type SideView } from './SidePanel';
import { shortPath } from './format';
import { useSession } from './store';
import { TerminalView } from './TerminalView';

export type View = 'conversation' | 'split' | 'terminal' | 'audit';

const STATUS: Record<string, { label: string; tone: string }> = {
  waiting: { label: 'Needs you', tone: 'amber' },
  busy: { label: 'Working', tone: 'green' },
  idle: { label: 'Ready', tone: 'green' },
  starting: { label: 'Starting', tone: 'muted' },
  stopped: { label: 'Not running', tone: 'muted' },
  exited: { label: 'Not running', tone: 'muted' },
};

export function SessionWorkspace({
  sessionId,
  draft,
  initialView,
  onError,
  onNavigate,
}: {
  sessionId: string;
  draft?: string;
  initialView?: View;
  onError: (m: string) => void;
  onNavigate: (sessionId: string) => void;
}) {
  const view = useSession(sessionId);
  const extras = useExtras(sessionId);
  const audit = useAudit(sessionId);
  const [mode, setMode] = useState<View>(initialView ?? 'conversation');
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  const [rail, setRail] = useState(true);
  const sideChats = useSideChats(sessionId);
  const [side, setSide] = useState<SideView | null>(null);
  const askSide = useCallback((anchor: SideAnchor) => setSide({ anchor }), []);
  const openSide = useCallback((chatId: string) => setSide({ chatId }), []);
  if (!view) return <div className="loading">Loading session…</div>;
  const { state, items } = view;
  const status = state.mode === 'mirror' ? { label: 'View only · plain terminal', tone: 'muted' } : STATUS[state.status]!;
  const running = state.mode === 'attached' || state.mode === 'background';
  const runAudit = () =>
    void api.runAudit(sessionId).then((r) => {
      if (!r.ok) onError(r.error);
      audit.reload();
    });

  return (
    <div className={`workspace ${side ? 'side' : rail ? '' : 'no-rail'}`}>
      <section className="main">
        <header className="head">
          <div className="head-text">
            <div className="head-title">
              <h1>{state.title}</h1>
              <span className={`status-pill ${status.tone}`}>● {status.label}</span>
              {audit.state?.audit && (
                <button
                  className={`status-pill audit-pill ${audit.state.audit.wasted.share >= 0.15 ? '' : 'calm'}`}
                  onClick={() => setMode('audit')}
                  title="Open the audit"
                >
                  {wasteLabel(audit.state.audit.wasted)}
                </button>
              )}
            </div>
            <div className="crumbs">
              <span className="mono">{shortPath(state.cwd)}</span>
              {state.facts.model && <span>{shortModel(state.facts.model)}</span>}
              {state.elsewhere && <span>{state.elsewhere}</span>}
              {extras?.parent && (
                <button className="crumb-link" onClick={() => onNavigate(extras.parent!.id)}>
                  ↖ from {extras.parent.title}
                </button>
              )}
              {state.jobId && (
                <span className="mono" title="Run this in any terminal to drive the same session there">
                  claude attach {state.jobId}
                </span>
              )}
            </div>
          </div>
          <div className="head-actions">
            <div className="seg" role="group" aria-label="View">
              {(['conversation', 'split', 'terminal', 'audit'] as View[]).map((v) => (
                <button key={v} aria-pressed={mode === v} onClick={() => setMode(v)}>
                  {v[0]!.toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            <button
              className="icon-btn"
              onClick={() => setSide(side ? null : { list: true })}
              aria-pressed={!!side}
              title="Questions about this chat, asked on the side so they don't add to its context"
            >
              Side chats{sideChats.length ? ` · ${sideChats.length}` : ''}
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                setSide(null);
                setRail(side ? true : !rail);
              }}
              aria-pressed={rail && !side}
            >
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

        {mode === 'audit' && (
          <AuditPanel
            state={audit.state}
            onRun={runAudit}
            onJump={(id) => {
              setMode('conversation');
              setFocus({ id, at: Date.now() });
            }}
          />
        )}
        <div className={`panes ${mode}`} hidden={mode === 'audit'}>
          {mode !== 'terminal' && mode !== 'audit' && (
            <div className="convo-pane">
              <Conversation
                items={items}
                state={state}
                sentFromApp={view.sentFromApp}
                focus={focus}
                onAnswer={(key) => api.answer(sessionId, key)}
                onShowTerminal={() => setMode('split')}
                sideChats={sideChats}
                onAskSide={askSide}
                onOpenSide={openSide}
              />
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
          {(mode === 'split' || mode === 'terminal') && (
            <TerminalView sessionId={sessionId} interactive={state.mode === 'attached'} visible />
          )}
        </div>
      </section>
      {side && <SidePanel sessionId={sessionId} chats={sideChats} view={side} onView={setSide} onClose={() => setSide(null)} onError={onError} />}
      {rail && !side && <DetailsRail state={state} items={items} extras={extras} onNavigate={onNavigate} onError={onError} />}
    </div>
  );
}
