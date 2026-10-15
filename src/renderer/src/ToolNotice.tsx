import { useState } from 'react';
import type { SessionState } from '../../shared/api';
import { api } from './api';

/**
 * Shown when a chat doesn't have Companion's new-chat tool (it started before the tool existed, or
 * outside Companion), so asking for "a separate chat" would get "I can't do that".
 */
export function ToolNotice({ state, toolsEverywhere, onError }: { state: SessionState; toolsEverywhere: boolean; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<'restart' | 'install' | null>(null);
  const [installed, setInstalled] = useState(false);
  if (state.facts.newChatTool !== false) return null;
  const mirror = state.mode === 'mirror';

  const restart = async () => {
    setBusy('restart');
    const r = await api.restartWithTools(state.sessionId);
    setBusy(null);
    if (!r.ok) onError(r.error);
  };
  const install = async () => {
    setBusy('install');
    const r = await api.installToolsEverywhere();
    setBusy(null);
    if (r.ok) setInstalled(true);
    else onError(r.error);
  };

  return (
    <div className="tool-notice" role="note">
      <div>
        <b>This chat can't open new chats yet.</b>{' '}
        {mirror
          ? "It's a plain claude running in another terminal, without Companion's tools."
          : 'It started before Companion could give it that ability.'}
      </div>
      <div className="tool-notice-actions">
        {!mirror && (
          <button className="btn small primary" disabled={!!busy} onClick={() => void restart()}>
            {busy === 'restart' ? 'Restarting…' : 'Restart this chat with it'}
          </button>
        )}
        {!toolsEverywhere && !installed && (
          <button className="btn small" disabled={!!busy} onClick={() => void install()} title="Runs claude mcp add --scope user companion">
            {busy === 'install' ? 'Turning on…' : 'Turn on for all Claude sessions'}
          </button>
        )}
        {installed && <span className="muted small">On for all sessions. {mirror ? 'Restart that claude to pick it up.' : ''}</span>}
      </div>
      {!mirror && <div className="muted small">Restarting keeps the conversation: it continues as a copy that has the tool.</div>}
    </div>
  );
}
