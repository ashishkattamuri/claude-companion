import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewFile, ReviewView } from '../../shared/api';
import { diffRows } from '../../shared/reviewRows';
import { api } from './api';
import { ReviewOverviewPane } from './ReviewOverview';
import { ReviewVerifyPane, VerifyChip } from './ReviewVerify';

for (const [name, lang] of Object.entries({ bash, css, go, java, javascript, json, markdown, python, ruby, rust, sql, typescript, xml, yaml }))
  hljs.registerLanguage(name, lang);

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'css', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'java',
  sh: 'bash', zsh: 'bash', bash: 'bash', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'yaml',
};
/** Past this many lines a file's diff starts folded, so one huge file doesn't bury the rest. */
const FOLD_LINES = 400;

export type ReviewMode = 'overview' | 'explore' | 'verify';

/** The session's changes. Opening the review asks for missing explanations once; updates just reload. */
export function useReview(sessionId: string, open: boolean) {
  const [view, setView] = useState<ReviewView | null>(null);
  const load = useCallback((explain = false) => void api.getReview(sessionId, explain).then(setView), [sessionId]);
  useEffect(() => {
    if (!open) return;
    load(true);
    return api.onChanged(() => load());
  }, [open, load]);
  return { view, retry: () => load(true) };
}

/** What a hunk or file question is about: the code exactly as it is now, and where it came from. */
export interface ChangeAnchor {
  file: ReviewFile;
  /** A hunk index, or null for the whole file. */
  hunk: number | null;
}

export interface ReviewProps {
  sessionId: string;
  view: ReviewView | null;
  onRetry: () => void;
  /** Shows a step or message in the conversation. */
  onJump: (itemId: string) => void;
  /** Puts a message in the chat's composer, for you to edit and send. */
  onDraft: (text: string) => void;
  /** Asks about a hunk or file in a side chat, without interrupting the chat. */
  onAskChange?: (anchor: ChangeAnchor) => void;
}

/**
 * The session's changes in three modes: an overview grouped by behavior (what you asked, what was
 * implemented, where the risks are), the diff itself to explore, and what was verified.
 */
export function ReviewPanel(props: ReviewProps) {
  const { view } = props;
  const [mode, setMode] = useState<ReviewMode>('overview');
  const [target, setTarget] = useState<{ path: string; hunk?: number; at: number } | null>(null);
  if (!view) return <div className="review-view" />;
  const { files } = view;
  if (!files.length)
    return (
      <div className="review-view">
        <div className="empty">
          <h2>Nothing to review yet</h2>
          <p className="muted">Files Claude edits or writes in this session show here, with what changed in each and why.</p>
        </div>
      </div>
    );
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const reviewed = files.filter((f) => f.review.state === 'reviewed').length;
  const showFile = (path: string, hunk?: number) => {
    setTarget({ path, hunk, at: Date.now() });
    setMode('explore');
  };

  return (
    <div className="review-view">
      <div className="review-bar">
        <div className="seg" role="tablist" aria-label="Review mode">
          {(
            [
              ['overview', 'Overview'],
              ['explore', 'Explore'],
              ['verify', 'Verify'],
            ] as [ReviewMode, string][]
          ).map(([m, label]) => (
            <button key={m} role="tab" aria-selected={mode === m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <span className="review-stats small">
          <b>
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </b>{' '}
          <span className="tabular">
            <Stat added={added} removed={removed} />
          </span>
          <span className="muted">
            {' '}
            · {reviewed} of {files.length} reviewed
          </span>
        </span>
      </div>
      {mode === 'overview' && <ReviewOverviewPane {...props} view={view} onShowFile={showFile} />}
      {mode === 'explore' && <Explore {...props} view={view} target={target} />}
      {mode === 'verify' && <ReviewVerifyPane view={view} onJump={props.onJump} onShowFile={showFile} />}
    </div>
  );
}

/** The diff, file by file, with each file's explanation, the edits that made it, and your review marks. */
function Explore({ sessionId, view, onRetry, onJump, onAskChange, target }: ReviewProps & { view: ReviewView; target: { path: string; hunk?: number; at: number } | null }) {
  const cards = useRef(new Map<string, HTMLElement>());
  const { files } = view;
  const go = (path: string) => cards.current.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const behaviorsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of view.overview?.behaviors ?? []) for (const p of b.files) m.set(p, [...(m.get(p) ?? []), b.title]);
    return m;
  }, [view.overview]);

  useEffect(() => {
    if (!target) return;
    const card = cards.current.get(target.path);
    const el = target.hunk !== undefined ? (card?.querySelector(`[data-hunk="${target.hunk}"]`) as HTMLElement | null) : card;
    (el ?? card)?.scrollIntoView({ block: 'start' });
  }, [target]);

  // j / k: the next or previous file.
  const scroller = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
    if (e.key !== 'j' && e.key !== 'k') return;
    const top = scroller.current?.getBoundingClientRect().top ?? 0;
    const els = files.map((f) => cards.current.get(f.path)).filter((x): x is HTMLElement => !!x);
    const at = els.findIndex((el) => el.getBoundingClientRect().top > top + 4);
    const cur = at < 0 ? els.length - 1 : Math.max(0, at - 1);
    const next = e.key === 'j' ? Math.min(els.length - 1, at < 0 ? els.length - 1 : at) : Math.max(0, cur - (els[cur]!.getBoundingClientRect().top >= top - 4 ? 1 : 0));
    els[next]?.scrollIntoView({ block: 'start' });
    els[next]?.querySelector<HTMLElement>('.rf-head button, .rf-head input')?.focus({ preventScroll: true });
    e.preventDefault();
  };

  return (
    <div className="review-explore" onKeyDown={onKey}>
      <nav className="review-nav" aria-label="Changed files">
        <ul>
          {files.map((f) => {
            const { dir, name } = split(f.path);
            return (
              <li key={f.hash}>
                <button className={f.review.state} onClick={() => go(f.path)} title={f.path}>
                  <span className="rn-path">
                    <span className="rn-name">{name}</span>
                    {f.isNew && <span className="rn-new">new</span>}
                    {f.review.state === 'changed' && <span className="rn-again">look again</span>}
                    <span className="rn-stat tabular">
                      <Stat added={f.added} removed={f.removed} />
                    </span>
                  </span>
                  {dir && <span className="rn-dir">{dir}</span>}
                  {f.explanation && <span className="rn-gist">{firstSentence(f.explanation)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted small rn-keys">
          <kbd>j</kbd> <kbd>k</kbd> next and previous file
        </p>
      </nav>
      <div className="review-files" ref={scroller} tabIndex={-1}>
        {view.explaining && <p className="review-note muted small">Writing a short explanation of each file…</p>}
        {view.error && !view.explaining && (
          <p className="review-note warn small">
            Couldn't write the explanations: {view.error}{' '}
            <button className="link" onClick={onRetry}>
              Try again
            </button>
          </p>
        )}
        {files.map((f) => (
          <FileCard
            key={f.hash}
            file={f}
            explaining={view.explaining}
            behaviors={behaviorsOf.get(f.path) ?? []}
            onReviewed={(on) => void api.markReviewed(sessionId, f.abs, on)}
            onOpen={() => void api.openChangedFile(sessionId, f.abs)}
            onJump={onJump}
            onAsk={onAskChange ? (hunk) => onAskChange({ file: f, hunk }) : undefined}
            refEl={(el) => (el ? cards.current.set(f.path, el) : cards.current.delete(f.path))}
          />
        ))}
      </div>
    </div>
  );
}

const FileCard = memo(function FileCard({
  file: f,
  explaining,
  behaviors,
  onReviewed,
  onOpen,
  onJump,
  onAsk,
  refEl,
}: {
  file: ReviewFile;
  explaining: boolean;
  behaviors: string[];
  onReviewed: (reviewed: boolean) => void;
  onOpen: () => void;
  onJump: (itemId: string) => void;
  onAsk?: (hunk: number | null) => void;
  refEl: (el: HTMLElement | null) => void;
}) {
  const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [unfold, setUnfold] = useState(false);
  const folded = lines > FOLD_LINES && !unfold;
  const done = f.review.state === 'reviewed';
  return (
    <section className={`review-file ${done ? 'viewed' : ''} ${f.review.state === 'changed' ? 'again' : ''}`} ref={refEl} aria-label={f.path}>
      <header className="rf-head">
        <span className="rf-path mono" title={f.abs}>
          {f.path}
        </span>
        {f.isNew && <span className="rn-new">new</span>}
        <span className="tabular small">
          <Stat added={f.added} removed={f.removed} />
        </span>
        <VerifyChip v={f.verification} compact />
        <span className="rf-actions">
          {onAsk && (
            <button className="btn small" onClick={() => onAsk(null)} title="Ask about this file in a side chat; the chat keeps working">
              Ask about this file
            </button>
          )}
          {f.disk !== 'missing' && (
            <button className="btn small" onClick={onOpen}>
              Open
            </button>
          )}
          <label className="rf-viewed small" title="Your own review mark. Opening or scrolling never sets it.">
            <input type="checkbox" checked={done} onChange={(e) => onReviewed(e.target.checked)} /> Reviewed
          </label>
        </span>
      </header>
      {f.review.state === 'changed' && (
        <p className="rf-again">
          Changed since you reviewed it: {f.partial ? 'the whole file needs another look' : `${f.review.changedHunks.length} of ${f.hunks.length} ${f.hunks.length === 1 ? 'hunk needs' : 'hunks need'} another look`}.{' '}
          <button className="link" onClick={() => onReviewed(true)}>
            Mark reviewed again
          </button>
        </p>
      )}
      {!done && (
        <>
          {f.explanation ? (
            <p className="rf-explain">{f.explanation}</p>
          ) : explaining ? (
            <p className="rf-explain muted">Explaining this change…</p>
          ) : null}
          {behaviors.length > 0 && (
            <p className="rf-part small muted">
              Part of: {behaviors.map((b, i) => (
                <span key={b}>
                  {i > 0 && ' · '}
                  <b>{b}</b>
                </span>
              ))}
            </p>
          )}
          <Steps file={f} onJump={onJump} />
          {f.disk === 'changed' && <p className="rf-notice">Changed on disk since this session edited it. The diff shows the session's changes only.</p>}
          {f.disk === 'missing' && <p className="rf-notice">This file no longer exists on disk.</p>}
          {f.partial && <p className="rf-notice">The file's earlier content wasn't recorded, so these are the session's edits one by one.</p>}
          {folded ? (
            <button className="rf-unfold" onClick={() => setUnfold(true)}>
              Show the diff ({lines.toLocaleString()} lines)
            </button>
          ) : (
            <Diff file={f} onAsk={onAsk} />
          )}
        </>
      )}
    </section>
  );
});

function Diff({ file: f, onAsk }: { file: ReviewFile; onAsk?: (hunk: number) => void }) {
  const lang = LANG[f.path.split('.').pop()?.toLowerCase() ?? ''];
  const rows = useMemo(() => diffRows(f, { headers: f.hunks.length > 1 || !!onAsk }), [f, onAsk]);
  const again = new Set(f.review.state === 'changed' ? f.review.changedHunks : []);
  return (
    <div className="rf-diff-wrap">
      <table className="rf-diff">
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'gap' ? (
              <tr key={i} className="gap">
                <td colSpan={4}>⋯ {r.count === null ? 'unchanged lines' : `${r.count} unchanged ${r.count === 1 ? 'line' : 'lines'}`}</td>
              </tr>
            ) : r.kind === 'hunk' ? (
              <tr key={i} className={`hunk ${again.has(r.hunk) ? 'again' : ''}`} data-hunk={r.hunk}>
                <td colSpan={4}>
                  <span className="hunk-label">
                    {r.from === r.to ? `Line ${r.from}` : `Lines ${r.from}–${r.to}`}
                    {again.has(r.hunk) && <span className="rn-again">needs another look</span>}
                  </span>
                  {onAsk && (
                    <button className="link hunk-ask" onClick={() => onAsk(r.hunk)} title="Ask about this change in a side chat; the chat keeps working">
                      Ask about this change
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              <tr key={i} className={`${r.kind} ${again.has(r.hunk) ? 'again' : ''}`}>
                <td className="ln">{r.old ?? ''}</td>
                <td className="ln">{r.new ?? ''}</td>
                <td className="mark">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                <td className="code">
                  <Code text={r.text} lang={lang} />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The edits that made this change, each with what Claude said just before it, in its own words (free:
 * it's already in the transcript). A remark that covers several edits in a row is shown once.
 */
function Steps({ file: f, onJump }: { file: ReviewFile; onJump: (itemId: string) => void }) {
  if (!f.stepIds.length) return null;
  const many = f.stepIds.length > 1;
  return (
    <ol className="rf-steps">
      {f.stepIds.map((id, i) => {
        const note = f.stepNotes[i] ?? null;
        const repeat = i > 0 && note !== null && note === f.stepNotes[i - 1];
        return (
          <li key={id}>
            {many && <span className="rf-step-n tabular">{i + 1}</span>}
            <span className={`rf-step-note ${note && !repeat ? '' : 'muted'}`} title={note ?? undefined}>
              {repeat ? 'Same as above' : note ? `“${clip(firstSentence(note), 180)}”` : 'Edited without a remark'}
            </span>
            <button className="link" onClick={() => onJump(id)}>
              Show in chat
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {added > 0 && <span className="stat-add">+{added}</span>} {removed > 0 && <span className="stat-del">−{removed}</span>}
    </>
  );
}

function Code({ text, lang }: { text: string; lang: string | undefined }) {
  if (!lang || !text.trim()) return <span>{text}</span>;
  // highlight.js escapes the source; its output is only its own spans.
  return <span dangerouslySetInnerHTML={{ __html: hljs.highlight(text, { language: lang, ignoreIllegals: true }).value }} />;
}

function split(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
}
