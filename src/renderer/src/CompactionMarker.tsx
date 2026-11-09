import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationItem } from '../../shared/api';

type Notice = Extract<ConversationItem, { kind: 'notice' }>;

const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const secs = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)}s`);

/**
 * Where the chat was compacted: how much it shrank, who started it, and the summary Claude works
 * from instead of everything before this point.
 */
export function CompactionMarker({ notice }: { notice: Notice }) {
  const [open, setOpen] = useState(false);
  const c = notice.compaction!;
  const sizes = c.before !== null && c.after !== null;
  const facts = [
    c.trigger === 'auto' ? 'automatically, as the context filled up' : c.trigger === 'manual' ? 'by you' : null,
    c.durationMs !== null ? `took ${secs(c.durationMs)}` : null,
    c.droppedTotal !== null && c.droppedTotal > (sizes ? c.before! - c.after! : 0) ? `${k(c.droppedTotal)} dropped in all` : null,
  ].filter(Boolean);
  return (
    <div className="compaction" id={`item-${notice.id}`}>
      <div className="compaction-head">
        <span className="compaction-title">
          {sizes ? (
            <>
              Compacted <b className="tabular">{k(c.before!)}</b> → <b className="tabular">{k(c.after!)}</b> tokens
            </>
          ) : (
            notice.text
          )}
        </span>
        {facts.length > 0 && <span className="muted">{facts.join(' · ')}</span>}
        {c.summary ? (
          <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide the summary' : 'What Claude kept'}
          </button>
        ) : (
          <span className="muted">Writing the summary…</span>
        )}
      </div>
      {open && c.summary && (
        <div className="compaction-summary">
          <p className="muted small">Claude works from this summary instead of the conversation above.</p>
          <Markdown remarkPlugins={[remarkGfm]}>{c.summary}</Markdown>
        </div>
      )}
    </div>
  );
}
