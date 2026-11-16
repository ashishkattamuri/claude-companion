import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChangeRef, SideChat, SideUsage } from '../../shared/api';
import { api } from './api';

export type SideAnchor = SideChat['anchor'];

/** Which thread the panel shows: an existing one, a new one on a message, or the list. */
export type SideView = { chatId: string } | { anchor: SideAnchor; draft?: string } | { list: true };

/** A new thread on a change: the anchor shows the frozen diff instead of a message. */
export function changeAnchor(change: ChangeRef): SideAnchor {
  return { id: null, role: 'assistant', text: `${change.path}${change.from ? ` lines ${change.from}–${change.to}` : ''}`, change };
}

/** A session's side chats. Refreshes as answers stream in. */
export function useSideChats(sessionId: string): SideChat[] {
  const [chats, setChats] = useState<SideChat[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void api.listSideChats(sessionId).then((c) => live && setChats(c));
    load();
    const off = api.onSideChanged((id) => id === sessionId && load());
    // The code a thread asked about may change while Claude works: recheck whether answers are stale.
    const offChanged = api.onChanged(load);
    return () => {
      live = false;
      off();
      offChanged();
    };
  }, [sessionId]);
  return chats;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function usageLine(u: SideUsage): string {
  const parts = [`${k(u.cached)} from cache`, `${k(u.fresh + u.cacheWrite)} new`, `${k(u.output)} out`];
  if (u.costUsd) parts.push(`$${u.costUsd.toFixed(u.costUsd < 0.1 ? 3 : 2)}`);
  return parts.join(' · ');
}

const snippet = (text: string, n = 90) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n)}…` : line;
};

interface Props {
  sessionId: string;
  chats: SideChat[];
  view: SideView;
  onView: (v: SideView) => void;
  onClose: () => void;
  onError: (message: string) => void;
  /** Shows a step in the conversation. */
  onJump?: (itemId: string) => void;
  /** Puts a message in the chat's composer, for you to edit and send. */
  onDraft?: (text: string) => void;
}

/**
 * A Slack-style thread beside the conversation. The question goes to a fork of the chat, so it
 * knows the whole conversation, but the thread shows only the message it replies to.
 */
export function SidePanel({ sessionId, chats, view, onView, onClose, onError, onJump, onDraft }: Props) {
  const chat = 'chatId' in view ? (chats.find((c) => c.id === view.chatId) ?? null) : null;
  const anchor = chat?.anchor ?? ('anchor' in view ? view.anchor : null);
  const [text, setText] = useState('');
  useEffect(() => {
    if ('anchor' in view && view.draft) setText(view.draft);
  }, [view]);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, [view]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  if ('list' in view || !anchor) {
    return (
      <aside className="side-panel" aria-label="Side chats">
        <header className="side-head">
          <b>Side chats</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close side chats">
            ✕
          </button>
        </header>
        <div className="side-body">
          {chats.length === 0 && (
            <p className="muted small">
              Ask about any message without adding to this chat: hover a message and click its reply arrow (<b>Ask on the side</b>).
            </p>
          )}
          {chats.map((c) => (
            <button key={c.id} className="side-item" onClick={() => onView({ chatId: c.id })}>
              <span className="side-item-q">{snippet(c.messages[0]?.text ?? '')}</span>
              <span className="muted small">
                {c.anchor.change ? <span className="mono">{snippet(c.anchor.text, 50)}</span> : <>on “{snippet(c.anchor.text, 50)}”</>}
                {c.stale && <span className="rn-again">code changed</span>} · {c.messages.filter((m) => m.role === 'assistant').length} repl
                {c.messages.filter((m) => m.role === 'assistant').length === 1 ? 'y' : 'ies'}
                {c.running ? ' · answering…' : ''}
              </span>
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const running = !!chat?.running;
  const send = async () => {
    if (!text.trim() || running || sending) return;
    setSending(true);
    const r = await api.askSide(sessionId, chat ? { chatId: chat.id, text } : { anchor, text });
    setSending(false);
    if (!r.ok) return onError(r.error);
    setText('');
    if (!chat) onView({ chatId: r.value });
  };

  return (
    <aside className="side-panel" aria-label="Side chat">
      <header className="side-head">
        <button className="link" onClick={() => onView({ list: true })} title="All side chats for this chat">
          ‹ Side chats
        </button>
        <span className="grow" />
        {chat && (
          <button
            className="icon-btn"
            onClick={() => {
              void api.deleteSideChat(chat.id);
              onView({ list: true });
            }}
            title="Delete this thread"
          >
            Delete
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Close side chat">
          ✕
        </button>
      </header>
      <div className="side-body" ref={scroller}>
        {anchor.change ? (
          <ChangeAnchorView change={anchor.change} onJump={onJump} />
        ) : (
          <div className="side-anchor">
            <div className="side-label">Replying to {anchor.role === 'user' ? 'your message' : 'Claude'}</div>
            <Anchor text={anchor.text} />
          </div>
        )}
        <div className="side-note muted small">
          Claude answers with the whole chat in mind{anchor.change ? ', read-only, keeping what the chat recorded apart from what it infers' : ''}. Nothing here is added to the
          chat, and the chat keeps working.
        </div>
        {chat?.stale && (
          <div className="side-stale" role="status">
            <span>
              <b>Code changed since this answer.</b> The diff above is the code as it was when you asked.
            </span>
            <button
              className="btn small"
              onClick={async () => {
                const latest = await api.latestChange(sessionId, chat.id);
                if (!latest) return onError('That change is no longer in this chat’s edits.');
                onView({ anchor: changeAnchor(latest), draft: chat.messages.find((m) => m.role === 'user')?.text ?? '' });
              }}
            >
              Ask again on the latest code
            </button>
          </div>
        )}
        {chat?.messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="side-q">
              {m.text}
            </div>
          ) : (
            <div key={i} className="side-a">
              {m.text && (
                <div className="a-text">
                  <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
                </div>
              )}
              {m.error && <div className="notice warn">{m.error}</div>}
              {m.usage && <div className="side-usage">{usageLine(m.usage)}</div>}
              {onDraft && m.text && !m.error && (
                <button
                  className="link small side-send"
                  title="Put this in the chat's message box for you to edit and send; nothing is sent until you do"
                  onClick={() => onDraft(sendBack(anchor, chat?.messages[i - 1]?.text ?? '', m.text))}
                >
                  Send to chat…
                </button>
              )}
            </div>
          ),
        )}
        {running && (
          <div className="side-a">
            {chat?.partial && (
              <div className="a-text">
                <Markdown remarkPlugins={[remarkGfm]}>{chat.partial}</Markdown>
              </div>
            )}
            <div className="working">
              <span className="spinner" /> {chat?.activity ?? 'Answering'}…
            </div>
          </div>
        )}
      </div>
      <div className="side-composer">
        <textarea
          ref={box}
          rows={2}
          value={text}
          placeholder={chat ? 'Reply in thread…' : anchor.change ? 'Ask about this change, e.g. which callers could break?' : 'Ask about this message…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape' && running && chat) {
              e.preventDefault();
              api.stopSide(chat.id);
            }
          }}
        />
        <div className="bar">
          <span className="hint-text">Side question · not added to the chat</span>
          <span className="spacer" />
          {running && chat ? (
            <button className="stop" onClick={() => api.stopSide(chat.id)}>
              Stop
            </button>
          ) : (
            <button className="send" onClick={() => void send()} disabled={!text.trim() || sending}>
              Ask ↵
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** What goes back to the chat when you choose to: the question, the answer, and what it was about. Editable before sending. */
function sendBack(anchor: SideAnchor, question: string, answer: string): string {
  const about = anchor.change ? anchor.text : `${anchor.role === 'user' ? 'my message' : 'your reply'} “${snippet(anchor.text, 80)}”`;
  return `From a side question about ${about}: “${question}”\n\nThe answer was:\n${answer}\n\n`;
}

/** The diff a thread asked about, exactly as it was then, with the edit that made it. */
function ChangeAnchorView({ change: c, onJump }: { change: ChangeRef; onJump?: (id: string) => void }) {
  const last = c.stepIds[c.stepIds.length - 1];
  return (
    <div className="side-anchor change">
      <div className="side-label">
        Asking about <span className="mono">{c.path}</span>
        {c.from ? ` lines ${c.from}–${c.to}` : ' (whole file)'} · as of {new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
      <pre className="side-diff">
        {c.diff.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'at' : ''}>
            {l || ' '}
          </span>
        ))}
      </pre>
      {(c.note || (onJump && last)) && (
        <div className="side-src small">
          {c.note && <span className="muted">Claude, before the edit: “{snippet(c.note, 140)}” </span>}
          {onJump && last && (
            <button className="link" onClick={() => onJump(last)}>
              Show the edit in chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The replied-to message, folded when it's long. */
function Anchor({ text }: { text: string }) {
  const long = text.length > 600;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`a-text side-anchor-text ${long && !open ? 'folded' : ''}`}>
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}
