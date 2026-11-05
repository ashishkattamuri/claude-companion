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
import { api } from './api';
import { diffRows } from '../../shared/reviewRows';

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

function useViewed(sessionId: string) {
  const key = `review-viewed:${sessionId}`;
  const [viewed, setViewed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (hash: string) =>
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  return { viewed, toggle };
}

export function ReviewPanel({
  sessionId,
  view,
  onRetry,
  onJump,
}: {
  sessionId: string;
  view: ReviewView | null;
  onRetry: () => void;
  /** Shows a step in the conversation. */
  onJump: (itemId: string) => void;
}) {
  const { viewed, toggle } = useViewed(sessionId);
  const cards = useRef(new Map<string, HTMLElement>());
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
  const seen = files.filter((f) => viewed.has(f.hash)).length;
  const go = (hash: string) => cards.current.get(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="review-view">
      <nav className="review-nav" aria-label="Changed files">
        <div className="review-total">
          <b>{files.length} {files.length === 1 ? 'file' : 'files'}</b>{' '}
          <span className="tabular">
            <Stat added={added} removed={removed} />
          </span>
          <div className="muted small">
            {seen} of {files.length} viewed
          </div>
        </div>
        <ul>
          {files.map((f) => {
            const { dir, name } = split(f.path);
            return (
              <li key={f.hash}>
                <button className={viewed.has(f.hash) ? 'seen' : ''} onClick={() => go(f.hash)} title={f.path}>
                  <span className="rn-path">
                    <span className="rn-name">{name}</span>
                    {f.isNew && <span className="rn-new">new</span>}
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
      </nav>
      <div className="review-files">
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
            viewed={viewed.has(f.hash)}
            onViewed={() => toggle(f.hash)}
            onOpen={() => void api.openChangedFile(sessionId, f.abs)}
            onJump={onJump}
            refEl={(el) => (el ? cards.current.set(f.hash, el) : cards.current.delete(f.hash))}
          />
        ))}
      </div>
    </div>
  );
}

const FileCard = memo(function FileCard({
  file: f,
  explaining,
  viewed,
  onViewed,
  onOpen,
  onJump,
  refEl,
}: {
  file: ReviewFile;
  explaining: boolean;
  viewed: boolean;
  onViewed: () => void;
  onOpen: () => void;
  onJump: (itemId: string) => void;
  refEl: (el: HTMLElement | null) => void;
}) {
  const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [unfold, setUnfold] = useState(false);
  const folded = lines > FOLD_LINES && !unfold;
  return (
    <section className={`review-file ${viewed ? 'viewed' : ''}`} ref={refEl} aria-label={f.path}>
      <header className="rf-head">
        <span className="rf-path mono" title={f.abs}>
          {f.path}
        </span>
        {f.isNew && <span className="rn-new">new</span>}
        <span className="tabular small">
          <Stat added={f.added} removed={f.removed} />
        </span>
        <span className="rf-actions">
          {f.disk !== 'missing' && (
            <button className="btn small" onClick={onOpen}>
              Open
            </button>
          )}
          <label className="rf-viewed small">
            <input type="checkbox" checked={viewed} onChange={onViewed} /> Viewed
          </label>
        </span>
      </header>
      {!viewed && (
        <>
          {f.explanation ? (
            <p className="rf-explain">{f.explanation}</p>
          ) : explaining ? (
            <p className="rf-explain muted">Explaining this change…</p>
          ) : null}
          <Steps file={f} onJump={onJump} />
          {f.disk === 'changed' && <p className="rf-notice">Changed on disk since this session edited it. The diff shows the session's changes only.</p>}
          {f.disk === 'missing' && <p className="rf-notice">This file no longer exists on disk.</p>}
          {f.partial && <p className="rf-notice">The file's earlier content wasn't recorded, so these are the session's edits one by one.</p>}
          {folded ? (
            <button className="rf-unfold" onClick={() => setUnfold(true)}>
              Show the diff ({lines.toLocaleString()} lines)
            </button>
          ) : (
            <Diff file={f} />
          )}
        </>
      )}
    </section>
  );
});

function Diff({ file: f }: { file: ReviewFile }) {
  const lang = LANG[f.path.split('.').pop()?.toLowerCase() ?? ''];
  const rows = useMemo(() => diffRows(f), [f]);
  return (
    <div className="rf-diff-wrap">
    <table className="rf-diff">
      <tbody>
        {rows.map((r, i) =>
          r.kind === 'gap' ? (
            <tr key={i} className="gap">
              <td colSpan={4}>⋯ {r.count === null ? 'unchanged lines' : `${r.count} unchanged ${r.count === 1 ? 'line' : 'lines'}`}</td>
            </tr>
          ) : (
            <tr key={i} className={r.kind}>
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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Stat({ added, removed }: { added: number; removed: number }) {
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

function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
}
