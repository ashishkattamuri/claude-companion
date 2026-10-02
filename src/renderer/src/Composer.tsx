import { useEffect, useRef, useState } from 'react';
import type { SessionState } from '../../shared/api';

interface Props {
  state: SessionState;
  draft?: string;
  onSend: (text: string) => Promise<string | null>;
  onInterrupt: () => void;
  onCycleMode: () => void;
}

const MODE_LABEL: Record<string, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass permissions',
  auto: 'Auto mode',
  dontAsk: "Don't ask",
  manual: 'Ask before edits',
};

export function shortModel(model: string | null): string {
  if (!model) return 'Model';
  const m = model.match(/claude-(opus|sonnet|haiku|fable)-([\d-]+)/);
  if (!m) return model;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]!.replace(/-\d{8}$/, '').replace('-', '.')}`;
}

export function Composer({ state, draft, onSend, onInterrupt, onCycleMode }: Props) {
  const [text, setText] = useState(draft ?? '');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const mirror = state.mode === 'mirror';
  const owned = state.mode === 'owned';
  const busy = state.status === 'busy';

  useEffect(() => {
    if (draft) setText(draft);
    box.current?.focus();
  }, [draft, state.sessionId]);

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = async () => {
    if (!text.trim() || mirror) return;
    const err = await onSend(text);
    if (err) setError(err);
    else {
      setText('');
      setError(null);
    }
  };

  const placeholder = mirror
    ? `Running in another terminal${state.elsewhere ? ` (${state.elsewhere})` : ''}. Quit it there to continue here.`
    : state.mode === 'history'
      ? 'Continue this session…'
      : state.status === 'waiting'
        ? 'Answer above, or type a message to send after…'
        : busy
          ? 'Type to queue a message for when Claude is done…'
          : 'Message Claude…';

  return (
    <div className="composer">
      {error && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
      <div className={`composer-box ${mirror ? 'disabled' : ''}`}>
        <textarea
          ref={box}
          id={`composer-${state.sessionId}`}
          rows={2}
          value={text}
          disabled={mirror}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape' && busy) {
              e.preventDefault();
              onInterrupt();
            }
          }}
        />
        <div className="bar">
          <button className="chip" onClick={() => setText((t) => `${t}@`)} disabled={mirror} title="Mention a file">
            @ file
          </button>
          <button className="chip" onClick={() => setText((t) => (t ? t : '/'))} disabled={mirror} title="Slash command">
            / command
          </button>
          <span className="chip static" title="Model">
            {shortModel(state.facts.model)}
          </span>
          <button
            className="chip mode"
            onClick={onCycleMode}
            disabled={!owned || state.status === 'stopped'}
            title="Permission mode (Shift+Tab in the terminal)"
          >
            {MODE_LABEL[state.facts.permissionMode ?? 'default'] ?? state.facts.permissionMode}
          </button>
          <span className="spacer" />
          {busy && (
            <button className="stop" onClick={onInterrupt} title="Interrupt (Esc)">
              Stop
            </button>
          )}
          <button className="send" onClick={() => void submit()} disabled={mirror || !text.trim()}>
            {state.mode === 'history' ? 'Continue ↵' : 'Send ↵'}
          </button>
        </div>
      </div>
      <div className="hint">
        {mirror ? (
          <span>Read-only: this conversation updates live as the other terminal works.</span>
        ) : (
          <>
            <span>Messages are typed into the same session as the terminal.</span>
            <span>Esc interrupts · ⇧↵ new line</span>
          </>
        )}
      </div>
    </div>
  );
}
