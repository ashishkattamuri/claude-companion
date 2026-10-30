import { readFileSync } from 'node:fs';

/**
 * Looking things up in an earlier conversation, for a chat opened from it. The chat starts with
 * the earlier one's notes; this is for the details the notes left out (an exact error, the command
 * that worked, a number), word for word.
 *
 * Reads the transcript file, not the database: the database keeps only the first 512 characters of
 * tool output and 4,096 of text.
 */

export interface Entry {
  /** Step number, shown as `#n` in results; `around` takes it. */
  n: number;
  ts: string;
  turn: number;
  role: 'user' | 'assistant' | 'tool' | 'result';
  /** The tool called, or for a result the tool it answers. */
  tool: string | null;
  text: string;
  isError: boolean;
}

export interface EarlierChat {
  id: string;
  title: string;
  /** How it relates to the calling chat: "parent", "grandparent", … */
  relation: string;
  entries: Entry[];
}

export interface SearchOptions {
  query?: string;
  around?: number;
  page?: number;
}

/** Characters per page of results. */
export const PAGE_CHARS = 8000;
/** Characters of a matching step shown around the match. */
const HIT_CHARS = 1600;
/** Characters of each neighbouring step shown with a match. */
const NEIGHBOUR_CHARS = 300;
/** Steps before and after the one asked for with `around`. */
const AROUND_SPAN = 3;

/** User-role text injected by the harness rather than typed by the person. */
const HARNESS_PREFIXES = ['<command-', '<local-command', '<system-reminder>', '<bash-', '<task-notification>', 'Caveat:'];

export function readEntries(path: string): Entry[] {
  return entriesFromLines(readFileSync(path, 'utf8').split('\n'));
}

export function entriesFromLines(lines: string[]): Entry[] {
  const out: Entry[] = [];
  const toolNames = new Map<string, string>();
  let turn = 0;
  const push = (e: Omit<Entry, 'n' | 'turn'>) => out.push({ ...e, n: out.length + 1, turn });
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if ((rec?.type !== 'user' && rec?.type !== 'assistant') || rec.isSidechain || rec.isMeta || rec.isCompactSummary) continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : '';
    const content = rec.message?.content;
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const text = b.text.trim();
        if (rec.type === 'user') {
          if (HARNESS_PREFIXES.some((p) => text.startsWith(p))) continue;
          turn++;
          push({ ts, role: 'user', tool: null, text, isError: false });
        } else push({ ts, role: 'assistant', tool: null, text, isError: false });
      } else if (b?.type === 'tool_use' && rec.type === 'assistant') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        if (typeof b.id === 'string') toolNames.set(b.id, name);
        push({ ts, role: 'tool', tool: name, text: JSON.stringify(b.input ?? {}), isError: false });
      } else if (b?.type === 'tool_result') {
        push({ ts, role: 'result', tool: toolNames.get(b.tool_use_id) ?? null, text: resultText(b.content), isError: b.is_error === true });
      }
    }
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Searches the earlier chats (nearest first), reads the steps around one, or with neither a query
 * nor `around` outlines them. Returns one page of results as text for Claude.
 */
export function searchEarlier(chats: EarlierChat[], opts: SearchOptions): string {
  if (!chats.length) return 'There is no earlier conversation to search.';
  const several = chats.length > 1;
  let blocks: string[];
  let summary: string;
  if (opts.around !== undefined) {
    const chat = chats[0]!;
    blocks = aroundBlocks(chat, opts.around);
    summary = `Steps around #${opts.around} of ${describe(chat)}`;
  } else if (opts.query?.trim()) {
    const query = opts.query.trim();
    const match = matcher(query, chats);
    blocks = [];
    let hits = 0;
    for (const chat of chats) {
      const found = chat.entries.filter((e) => match(e.text));
      hits += found.length;
      for (const e of found) blocks.push(hitBlock(chat, e, match, several));
    }
    summary = `${hits} step${hits === 1 ? '' : 's'} matching "${query}" in ${chats.map(describe).join(', ')}`;
    if (!hits) return `${summary}. Try other words, or call with no query for an outline of the conversation.`;
    summary += `. Read any step in full with around: n${several ? ' and chat: <id>' : ''}`;
  } else {
    blocks = chats.flatMap(outlineBlocks);
    summary = `Outline of ${chats.map(describe).join(', ')}: each turn with its steps (#n), the user's message and the tools used. Read a part with around: n${several ? ' and chat: <id>' : ''}, or search with query`;
  }
  return paginate(summary, blocks, opts.page ?? 1);
}

const describe = (c: EarlierChat) => `the ${c.relation} chat "${c.title}" (chat: ${c.id})`;

/**
 * A query is tried as a regular expression (case-insensitive), or as plain text if it isn't one.
 * When a phrase finds nothing, steps holding all of its words match instead.
 */
function matcher(query: string, chats: EarlierChat[]): (text: string) => boolean {
  const slashed = query.match(/^\/(.+)\/([a-z]*)$/);
  let re: RegExp;
  try {
    re = slashed ? new RegExp(slashed[1]!, slashed[2]!.includes('i') ? slashed[2] : `${slashed[2]}i`) : new RegExp(query, 'i');
  } catch {
    re = new RegExp(escape(query), 'i');
  }
  const phrase = (t: string) => re.test(t);
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  if (slashed || words.length < 2 || chats.some((c) => c.entries.some((e) => phrase(e.text)))) return phrase;
  const res = words.map((w) => new RegExp(escape(w), 'i'));
  return (t) => res.every((r) => r.test(t));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function label(chat: EarlierChat, e: Entry, several: boolean): string {
  const who =
    e.role === 'user'
      ? 'user'
      : e.role === 'assistant'
        ? 'Claude'
        : e.role === 'tool'
          ? `tool call ${e.tool}`
          : `result${e.tool ? ` of ${e.tool}` : ''}${e.isError ? ' (error)' : ''}`;
  return `[${several ? `${chat.relation} ` : ''}#${e.n} · ${time(e.ts)} · ${who}]`;
}

const time = (ts: string) => (ts ? ts.slice(0, 16).replace('T', ' ') : 'unknown time');

/** A matching step with the steps on either side, abridged, for context. */
function hitBlock(chat: EarlierChat, e: Entry, match: (t: string) => boolean, several: boolean): string {
  const before = chat.entries[e.n - 2];
  const after = chat.entries[e.n];
  return [
    before && `${label(chat, before, several)} ${clip(before.text, NEIGHBOUR_CHARS)}`,
    `${label(chat, e, several)} ${snippet(e.text, match)}`,
    after && `${label(chat, after, several)} ${clip(after.text, NEIGHBOUR_CHARS)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The part of a long step around its first match, saying how much was left out. */
function snippet(text: string, match: (t: string) => boolean): string {
  if (text.length <= HIT_CHARS) return text;
  // Narrow down to where the first match ends: the shortest start of the text that still matches.
  let end = text.length;
  for (let step = 4096; step >= 16; step = Math.floor(step / 2)) {
    while (end - step > 0 && match(text.slice(0, end - step))) end -= step;
  }
  const start = Math.max(0, Math.min(end - HIT_CHARS / 2, text.length - HIT_CHARS));
  const stop = start + HIT_CHARS;
  return `${start ? `…(${start} chars before) ` : ''}${text.slice(start, stop)}${stop < text.length ? ` …(${text.length - stop} chars after)` : ''}`;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} …(${text.length - max} more chars)`);

/** The steps around one, in full: long steps are split, so paging reads all of them. */
function aroundBlocks(chat: EarlierChat, n: number): string[] {
  const at = chat.entries.findIndex((e) => e.n === n);
  if (at < 0) return [`There is no step #${n}; steps go from #1 to #${chat.entries.length}.`];
  const piece = PAGE_CHARS - 200;
  return chat.entries.slice(Math.max(0, at - AROUND_SPAN), at + AROUND_SPAN + 1).flatMap((e) => {
    const head = label(chat, e, false);
    if (e.text.length <= piece) return [`${head} ${e.text}`];
    const parts: string[] = [];
    for (let i = 0; i < e.text.length; i += piece) {
      parts.push(`${head} (chars ${i + 1}–${Math.min(e.text.length, i + piece)} of ${e.text.length}) ${e.text.slice(i, i + piece)}`);
    }
    return parts;
  });
}

function outlineBlocks(chat: EarlierChat): string[] {
  const turns = new Map<number, Entry[]>();
  for (const e of chat.entries) turns.set(e.turn, [...(turns.get(e.turn) ?? []), e]);
  const blocks = [`## The ${chat.relation} chat "${chat.title}" (chat: ${chat.id}), ${chat.entries.length} steps`];
  for (const [turn, es] of turns) {
    const prompt = es.find((e) => e.role === 'user');
    const tools = new Map<string, number>();
    for (const e of es) if (e.role === 'tool') tools.set(e.tool!, (tools.get(e.tool!) ?? 0) + 1);
    const used = [...tools].map(([t, k]) => (k > 1 ? `${t} ×${k}` : t)).join(', ');
    const range = es.length > 1 ? `#${es[0]!.n}–#${es.at(-1)!.n}` : `#${es[0]!.n}`;
    const first = prompt ? `"${clip(prompt.text.split('\n')[0]!, 160)}"` : '(before the first message)';
    blocks.push(`Turn ${turn} · ${range} · ${time(es[0]!.ts)} · ${first}${used ? ` · tools: ${used}` : ''}`);
  }
  return blocks;
}

/** Packs blocks into pages of about PAGE_CHARS and returns the one asked for. */
function paginate(summary: string, blocks: string[], page: number): string {
  const pages: string[][] = [[]];
  let size = 0;
  for (const b of blocks) {
    const block = b.length > PAGE_CHARS ? clip(b, PAGE_CHARS - 100) : b;
    if (size && size + block.length > PAGE_CHARS) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1)!.push(block);
    size += block.length + 2;
  }
  const p = Math.min(Math.max(1, Math.floor(page)), pages.length);
  const more = p < pages.length ? ` For more, call again with page: ${p + 1}.` : '';
  return `${summary}. Page ${p} of ${pages.length}.${more}\n\n${pages[p - 1]!.join('\n\n')}`;
}
