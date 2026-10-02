import { memo, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationItem, ScreenPrompt, SessionState } from '../../shared/api';
import { describeTool, summarizeSteps, toTurns, type Turn } from './turns';

type Tool = Extract<ConversationItem, { kind: 'tool' }>;

interface Props {
  items: ConversationItem[];
  state: SessionState;
  sentFromApp: Set<string>;
  onAnswer: (key: string) => void;
}

export function Conversation({ items, state, sentFromApp, onAnswer }: Props) {
  const turns = toTurns(items);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const live = state.status === 'busy' || state.status === 'waiting' || state.status === 'starting';

  // Follow new output while you're at the bottom; leave the scroll alone if you've scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      className="convo"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="thread">
        {turns.length === 0 && state.status !== 'starting' && (
          <div className="empty-thread">
            {state.mode === 'history' ? 'This session has no messages yet.' : 'Send a message to get started.'}
          </div>
        )}
        {turns.map((t, i) => (
          <TurnView
            key={t.id}
            turn={t}
            cwd={state.cwd}
            last={i === turns.length - 1}
            live={live}
            waiting={state.status === 'waiting'}
            fromApp={t.user ? sentFromApp.has(t.user.id) : false}
          />
        ))}
        {state.queued.map((q, i) => (
          <div className="u-msg queued" key={`q${i}`}>
            {q}
            <span className="via">queued · sends when Claude is ready</span>
          </div>
        ))}
        {state.prompt && <PromptCard prompt={state.prompt} pendingTool={lastPendingTool(items)} cwd={state.cwd} onAnswer={onAnswer} />}
        {state.status === 'waiting' && !state.prompt && state.mode === 'mirror' && (
          <div className="notice warn">Claude is waiting for an answer in the other terminal.</div>
        )}
        {state.status === 'busy' && (
          <div className="working">
            <span className="spinner" /> Claude is working…
          </div>
        )}
        {state.status === 'starting' && (
          <div className="working">
            <span className="spinner" /> Starting Claude Code…
          </div>
        )}
      </div>
    </div>
  );
}

const TurnView = memo(function TurnView({
  turn,
  cwd,
  last,
  live,
  waiting,
  fromApp,
}: {
  turn: Turn;
  cwd: string | null;
  last: boolean;
  live: boolean;
  waiting: boolean;
  fromApp: boolean;
}) {
  return (
    <>
      {turn.user && (
        <div className="u-msg">
          <div className="u-text">{turn.user.text}</div>
          {turn.user.images > 0 && <div className="via">{turn.user.images} image(s) attached</div>}
          <span className="via">
            {time(turn.user.ts)} · {fromApp ? 'from Companion' : 'typed in the terminal'}
          </span>
        </div>
      )}
      {turn.steps.length > 0 && <Steps steps={turn.steps} cwd={cwd} openByDefault={last && live} waiting={last && waiting} />}
      {turn.answer.map((item) => (
        <AnswerItem key={item.id} item={item} cwd={cwd} />
      ))}
    </>
  );
});

function Steps({ steps, cwd, openByDefault, waiting }: { steps: ConversationItem[]; cwd: string | null; openByDefault: boolean; waiting: boolean }) {
  const [open, setOpen] = useState(openByDefault);
  useEffect(() => {
    if (openByDefault) setOpen(true);
  }, [openByDefault]);
  const tools = steps.filter((s): s is Tool => s.kind === 'tool');
  let added = 0;
  let removed = 0;
  for (const t of tools) {
    const d = describeTool(t, cwd);
    added += d.added;
    removed += d.removed;
  }
  const n = tools.length || steps.length;
  return (
    <details className="steps" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <b>
          {n} step{n === 1 ? '' : 's'}
        </b>
        {tools.length > 0 && <span> · {summarizeSteps(steps)}</span>}
        <span className="grow" />
        {added > 0 && <span className="stat-add">+{added}</span>}
        {removed > 0 && <span className="stat-del">−{removed}</span>}
      </summary>
      {open && (
        <div className="step-list">
          {steps.map((s, i) => (
            <StepItem key={s.id} item={s} cwd={cwd} waiting={waiting && i === steps.length - 1} />
          ))}
        </div>
      )}
    </details>
  );
}

function StepItem({ item, cwd, waiting }: { item: ConversationItem; cwd: string | null; waiting: boolean }) {
  if (item.kind === 'assistant') return <div className="narr">{item.text}</div>;
  if (item.kind === 'thinking') return <Thinking text={item.text} />;
  if (item.kind === 'notice') return <div className={`notice ${item.tone}`}>{item.text}</div>;
  if (item.kind === 'tool') return <ToolRow tool={item} cwd={cwd} waiting={waiting} />;
  return null;
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide thinking' : 'Show thinking'}
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  );
}

function ToolRow({ tool, cwd, waiting }: { tool: Tool; cwd: string | null; waiting: boolean }) {
  const d = describeTool(tool, cwd);
  const isEdit = ['Edit', 'MultiEdit', 'Write'].includes(tool.name);
  const [open, setOpen] = useState(false);
  const failed = tool.result?.isError;
  const icon = !tool.result ? (waiting ? <span className="wait-dot" /> : <span className="spinner small" />) : failed ? <span className="bad">✕</span> : <span className="ok">✓</span>;
  return (
    <div className="tool">
      <button className="step" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-icon">{icon}</span>
        <span className="step-main">
          <span className="verb">{d.verb}</span> {d.target && <span className="target">{d.target}</span>}
        </span>
        <span className="res">
          {d.added > 0 && <span className="stat-add">+{d.added}</span>} {d.removed > 0 && <span className="stat-del">−{d.removed}</span>}
          {!tool.result && waiting && <span className="waiting-label">needs you</span>}
          {failed && <span className="bad">failed</span>}
        </span>
      </button>
      {open && (isEdit ? <Diff tool={tool} /> : <ToolDetail tool={tool} />)}
    </div>
  );
}

function Diff({ tool }: { tool: Tool }) {
  const patch = tool.result?.patch;
  if (patch?.length) {
    return (
      <div className="diff">
        {patch.map((h, i) => (
          <div key={i}>
            <div className="h">
              @@ −{h.oldStart} +{h.newStart} @@
            </div>
            {h.lines.map((l, j) => (
              <div key={j} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                {l}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  const before = typeof tool.input.old_string === 'string' ? tool.input.old_string : '';
  const after = typeof tool.input.new_string === 'string' ? tool.input.new_string : typeof tool.input.content === 'string' ? tool.input.content : '';
  return (
    <div className="diff">
      {before.split('\n').filter(Boolean).map((l, i) => (
        <div key={`d${i}`} className="del">
          -{l}
        </div>
      ))}
      {after.split('\n').slice(0, 200).map((l, i) => (
        <div key={`a${i}`} className="add">
          +{l}
        </div>
      ))}
    </div>
  );
}

function ToolDetail({ tool }: { tool: Tool }) {
  const input =
    tool.name === 'Bash' ? `$ ${String(tool.input.command ?? '')}` : JSON.stringify(tool.input, null, 2).slice(0, 4000);
  return (
    <div className="tool-detail">
      <pre className="cmd">{input}</pre>
      {tool.result && (
        <pre className={`output ${tool.result.isError ? 'error' : ''}`}>
          {tool.result.text || '(no output)'}
          {tool.result.truncated ? '\n… output truncated' : ''}
        </pre>
      )}
    </div>
  );
}

function AnswerItem({ item, cwd }: { item: ConversationItem; cwd: string | null }) {
  if (item.kind === 'assistant')
    return (
      <div className="a-text">
        <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
      </div>
    );
  if (item.kind === 'notice') return <div className={`notice ${item.tone}`}>{item.text}</div>;
  if (item.kind === 'tool') return <ToolRow tool={item} cwd={cwd} waiting={false} />;
  return null;
}

/** The dialog on screen, offered here too. Whichever side answers first wins. */
function PromptCard({ prompt, pendingTool, cwd, onAnswer }: { prompt: ScreenPrompt; pendingTool: Tool | null; cwd: string | null; onAnswer: (k: string) => void }) {
  if (prompt.kind === 'trust') {
    return (
      <div className="approval">
        <header>
          <b>Trust this folder?</b>
          <span className="muted">{cwd?.replace(/^\/Users\/[^/]+/, '~')}</span>
        </header>
        <div className="why">Claude Code asks once per folder before it reads, edits or runs files there.</div>
        <div className="actions">
          <button className="btn primary" onClick={() => onAnswer('yes')}>
            Yes, I trust this folder
          </button>
          <button className="btn quiet" onClick={() => onAnswer('no')}>
            No, exit
          </button>
        </div>
      </div>
    );
  }
  const d = pendingTool ? describeTool(pendingTool, cwd) : null;
  const command = pendingTool?.name === 'Bash' ? String(pendingTool.input.command ?? '') : null;
  return (
    <div className="approval">
      <header>
        <b>{prompt.kind === 'permission' ? `Claude wants to ${pendingTool ? verbFor(pendingTool.name) : 'continue'}` : prompt.question}</b>
        {prompt.header && <span className="muted">{prompt.header}</span>}
      </header>
      {command && <pre className="cmd">$ {command}</pre>}
      {!command && pendingTool && ['Edit', 'MultiEdit', 'Write'].includes(pendingTool.name) && (
        <>
          <div className="why mono">{d?.target}</div>
          <Diff tool={pendingTool} />
        </>
      )}
      {!command && pendingTool && !['Edit', 'MultiEdit', 'Write'].includes(pendingTool.name) && d && (
        <div className="why">
          {d.verb} <span className="mono">{d.target}</span>
        </div>
      )}
      {prompt.kind === 'permission' && pendingTool?.name === 'Bash' && typeof pendingTool.input.description === 'string' && (
        <div className="why">{pendingTool.input.description}</div>
      )}
      <div className="actions">
        {prompt.options.map((o, i) => (
          <button key={o.key} className={`btn ${i === 0 ? 'primary' : i === prompt.options.length - 1 ? 'quiet' : ''}`} onClick={() => onAnswer(o.key)}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="sync-hint">↔ The same prompt is open in the terminal. Answer in either place.</div>
    </div>
  );
}

function verbFor(tool: string): string {
  return tool === 'Bash' ? 'run a command' : tool === 'Write' ? 'create a file' : ['Edit', 'MultiEdit'].includes(tool) ? 'edit a file' : tool === 'WebFetch' ? 'fetch a page' : `use ${tool}`;
}

function lastPendingTool(items: ConversationItem[]): Tool | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'tool') return it.result ? null : it;
    if (it.kind === 'user') return null;
  }
  return null;
}

const time = (ts: string) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
