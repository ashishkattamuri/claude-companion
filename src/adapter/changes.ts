import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import type { ReviewHunk } from '../shared/api.js';

/**
 * What a session changed in each file, from its transcript. Claude Code records the file's content
 * before every Edit and Write (`originalFile`) and the edit itself, so each file's net change over
 * the session is: its content before the first edit, against its content after the last one.
 */
export interface FileChange {
  abs: string;
  isNew: boolean;
  /** Content before the session's first edit ('' for a new file); null when it wasn't recorded. */
  before: string | null;
  /** Content after the session's last edit; null when it can't be rebuilt (then `hunks` are the edits). */
  after: string | null;
  hunks: ReviewHunk[];
  added: number;
  removed: number;
  oldLineCount: number;
  stepIds: string[];
  /** What Claude said just before each of those steps (null when it said nothing), at no extra cost. */
  stepNotes: (string | null)[];
  /** The messages that asked for these edits, and what Claude said while making them: the "why". */
  requests: string[];
  remarks: string[];
  hash: string;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const HARNESS = /^(<command-|<local-command|<system-reminder>|<bash-|<task-notification>|Caveat:|\[Request interrupted)/;
const CONTEXT_LINES = 3;

interface Pending {
  name: string;
  itemId: string;
  note: string | null;
  path: string | null;
}

type Op = { hunks: ReviewHunk[]; old: string | null; neu: string | null; all: boolean };

interface Acc {
  abs: string;
  isNew: boolean;
  before: string | null;
  after: string | null;
  /** Each edit's own hunks, for when the content can't be rebuilt. */
  edits: ReviewHunk[];
  /** Each edit in order, to undo them from the file on disk when the content before wasn't recorded. */
  ops: Op[];
  stepIds: string[];
  stepNotes: (string | null)[];
  requests: string[];
  remarks: string[];
}

/**
 * Reads a transcript's JSONL lines and returns each changed file's net change, in first-changed order.
 * `readFile` gives a file's current content: when Claude Code didn't record a file's content before
 * an edit (it doesn't for files Claude hadn't read in full), it's rebuilt by undoing the edits from there.
 */
export function collectChanges(lines: string[], readFile?: (abs: string) => string | null): FileChange[] {
  const pending = new Map<string, Pending>();
  const files = new Map<string, Acc>();
  let request = '';
  let remarks: string[] = [];

  for (const line of lines) {
    let rec: Record<string, any>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || rec.isSidechain) continue;
    const content = rec.message?.content;

    if (rec.type === 'assistant' && Array.isArray(content)) {
      content.forEach((block: any, i: number) => {
        // Same ids as the conversation view, so a step can be shown there.
        const itemId = content.length > 1 ? `${rec.uuid}:${i}` : rec.uuid;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) remarks = [...remarks, block.text.trim()].slice(-3);
        else if (block?.type === 'tool_use' && EDIT_TOOLS.has(block.name))
          pending.set(block.id, { name: block.name, itemId, note: remarks.at(-1) ?? null, path: typeof block.input?.file_path === 'string' ? block.input.file_path : null });
      });
      continue;
    }
    if (rec.type !== 'user') continue;
    if (rec.isCompactSummary) continue;

    if (typeof content === 'string' || (Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result'))) {
      const text = typeof content === 'string' ? content : content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      if (!rec.isMeta && text.trim() && !HARNESS.test(text.trim())) {
        request = text.trim();
        remarks = [];
      }
      continue;
    }

    for (const block of content as any[]) {
      if (block?.type !== 'tool_result') continue;
      const call = pending.get(block.tool_use_id);
      if (!call) continue;
      pending.delete(block.tool_use_id);
      const r = rec.toolUseResult;
      if (block.is_error || !r || typeof r !== 'object') continue;
      const abs = typeof r.filePath === 'string' ? r.filePath : call.path;
      if (!abs) continue;
      apply(files, abs, call, r);
      const acc = files.get(abs)!;
      if (request && !acc.requests.includes(request)) acc.requests = [...acc.requests, request].slice(-2);
      for (const m of remarks) if (!acc.remarks.includes(m)) acc.remarks = [...acc.remarks, m].slice(-4);
    }
  }
  return [...files.values()]
    .map((acc) => finish(acc.before === null && readFile ? rebuild(acc, readFile(acc.abs)) : acc))
    .filter((f) => f.added + f.removed > 0);
}

function apply(files: Map<string, Acc>, abs: string, call: Pending, r: Record<string, any>): void {
  const original: string | null = typeof r.originalFile === 'string' ? r.originalFile : null;
  const created = call.name === 'Write' && (r.type === 'create' || (original === null && typeof r.content === 'string'));
  let acc = files.get(abs);
  if (!acc) {
    acc = { abs, isNew: created, before: created ? '' : original, after: created ? '' : original, edits: [], ops: [], stepIds: [], stepNotes: [], requests: [], remarks: [] };
    files.set(abs, acc);
  }
  acc.stepIds.push(call.itemId);
  acc.stepNotes.push(call.note);
  const hunks = toHunks(r.structuredPatch);
  acc.edits.push(...hunks);
  const replace = typeof r.oldString === 'string' && typeof r.newString === 'string';
  acc.ops.push({ hunks, old: replace ? r.oldString : null, neu: replace ? r.newString : null, all: !!r.replaceAll });

  // Edit from the content this edit started from: what Claude Code recorded, else what we rebuilt.
  const base = original ?? acc.after;
  let next: string | null = null;
  if (call.name === 'Write' && typeof r.content === 'string') next = r.content;
  else if (base !== null && typeof r.oldString === 'string' && typeof r.newString === 'string' && base.includes(r.oldString))
    next = r.replaceAll ? base.split(r.oldString).join(r.newString) : base.replace(r.oldString, () => r.newString);
  else if (base !== null && hunks.length) next = applyHunks(base, hunks);
  acc.after = next;
}

/** Undoes the session's edits, newest first, from the file's current content. */
function rebuild(acc: Acc, current: string | null): Acc {
  if (current === null) return acc;
  let text: string | null = current;
  for (const op of [...acc.ops].reverse()) {
    if (text === null) break;
    const undone: string | null = op.hunks.length ? applyHunks(text, invert(op.hunks)) : null;
    if (undone !== null) text = undone;
    else if (op.neu !== null && op.old !== null && text.includes(op.neu))
      text = op.all ? text.split(op.neu).join(op.old) : text.replace(op.neu, () => op.old!);
    else text = null;
  }
  return text === null ? acc : { ...acc, before: text, after: current };
}

function invert(hunks: ReviewHunk[]): ReviewHunk[] {
  return hunks.map((h) => ({
    oldStart: h.newStart,
    oldLines: h.newLines,
    newStart: h.oldStart,
    newLines: h.oldLines,
    lines: h.lines.map((l) => (l.startsWith('+') ? `-${l.slice(1)}` : l.startsWith('-') ? `+${l.slice(1)}` : l)),
  }));
}

function finish(acc: Acc): FileChange {
  let hunks: ReviewHunk[];
  let oldLineCount = 0;
  if (acc.before !== null && acc.after !== null) {
    hunks = structuredPatch('a', 'b', acc.before, acc.after, '', '', { context: CONTEXT_LINES }).hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    }));
    oldLineCount = lineCount(acc.before);
  } else {
    hunks = acc.edits;
  }
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  const partial = acc.before === null || acc.after === null;
  const hash = createHash('sha256')
    .update(`${acc.abs}\0${JSON.stringify(hunks)}`)
    .digest('hex')
    .slice(0, 32);
  return {
    abs: acc.abs,
    isNew: acc.isNew,
    before: partial ? null : acc.before,
    after: partial ? null : acc.after,
    hunks,
    added,
    removed,
    oldLineCount,
    stepIds: acc.stepIds,
    stepNotes: acc.stepNotes,
    requests: acc.requests,
    remarks: acc.remarks,
    hash,
  };
}

function toHunks(raw: unknown): ReviewHunk[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h: any) => Array.isArray(h?.lines))
    .map((h: any) => ({
      oldStart: Number(h.oldStart) || 0,
      oldLines: Number(h.oldLines) || 0,
      newStart: Number(h.newStart) || 0,
      newLines: Number(h.newLines) || 0,
      lines: h.lines.map(String),
    }));
}

/** Applies unified-diff hunks to text; null when they don't fit it. */
export function applyHunks(text: string, hunks: ReviewHunk[]): string | null {
  const lines = text.split('\n');
  for (const h of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    const body = h.lines.filter((l) => !l.startsWith('\\'));
    const old = body.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
    const neu = body.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
    const at = Math.max(0, h.oldStart - (old.length ? 1 : 0));
    if (old.some((l, i) => lines[at + i] !== l)) return null;
    lines.splice(at, old.length, ...neu);
  }
  return lines.join('\n');
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/** The diff as plain unified text, for the model that explains it. */
export function diffText(hunks: ReviewHunk[], maxChars = 6000): string {
  let out = '';
  for (const h of hunks) {
    const part = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`;
    if (out.length + part.length > maxChars) return `${out}… (diff truncated)\n`;
    out += part;
  }
  return out;
}
