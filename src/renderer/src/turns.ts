import type { ConversationItem } from '../../shared/api.js';

type Tool = Extract<ConversationItem, { kind: 'tool' }>;
type User = Extract<ConversationItem, { kind: 'user' }>;

export interface Turn {
  id: string;
  user: User | null;
  /** Narration, thinking, tool calls and notices up to the last tool call: shown as "N steps". */
  steps: ConversationItem[];
  /** What Claude said after its last tool call: the answer, shown in full. */
  answer: ConversationItem[];
}

/** Splits a conversation at each message you sent. */
export function toTurns(items: ConversationItem[]): Turn[] {
  const turns: Turn[] = [];
  let body: ConversationItem[] = [];
  let user: User | null = null;
  const close = () => {
    if (!user && !body.length) return;
    const lastTool = body.map((i) => i.kind).lastIndexOf('tool');
    turns.push({
      id: user?.id ?? body[0]!.id,
      user,
      steps: lastTool >= 0 ? body.slice(0, lastTool + 1) : body.filter((i) => i.kind === 'thinking'),
      answer: lastTool >= 0 ? body.slice(lastTool + 1) : body.filter((i) => i.kind !== 'thinking'),
    });
  };
  for (const item of items) {
    if (item.kind === 'user') {
      close();
      user = item;
      body = [];
    } else {
      body.push(item);
    }
  }
  close();
  return turns;
}

export interface ToolView {
  verb: string;
  target: string;
  added: number;
  removed: number;
  /** For edits: the file a diff belongs to. */
  file: string | null;
}

const rel = (p: unknown, cwd: string | null) => {
  const s = String(p ?? '');
  return cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s.replace(/^\/Users\/[^/]+/, '~');
};

/** One readable line per tool call: "Edited src/cli.ts", "Ran npm test". */
export function describeTool(t: Tool, cwd: string | null): ToolView {
  const i = t.input;
  const pending = !t.result;
  const { added, removed } = patchStats(t);
  const v = (done: string, doing: string) => (pending ? doing : done);
  switch (t.name) {
    case 'Bash':
      return { verb: v('Ran', 'Running'), target: String(i.description || i.command || ''), added: 0, removed: 0, file: null };
    case 'Read':
      return { verb: v('Read', 'Reading'), target: rel(i.file_path, cwd), added: 0, removed: 0, file: null };
    case 'Edit':
    case 'MultiEdit':
      return { verb: v('Edited', 'Editing'), target: rel(i.file_path, cwd), added, removed, file: rel(i.file_path, cwd) };
    case 'Write':
      return { verb: v('Wrote', 'Writing'), target: rel(i.file_path, cwd), added, removed, file: rel(i.file_path, cwd) };
    case 'NotebookEdit':
      return { verb: v('Edited notebook', 'Editing notebook'), target: rel(i.notebook_path, cwd), added: 0, removed: 0, file: null };
    case 'Grep':
    case 'Glob':
      return { verb: v('Searched for', 'Searching for'), target: String(i.pattern ?? ''), added: 0, removed: 0, file: null };
    case 'WebFetch':
      return { verb: v('Fetched', 'Fetching'), target: String(i.url ?? ''), added: 0, removed: 0, file: null };
    case 'WebSearch':
      return { verb: v('Searched the web for', 'Searching the web for'), target: String(i.query ?? ''), added: 0, removed: 0, file: null };
    case 'Agent':
    case 'Task':
      return { verb: v('Delegated', 'Delegating'), target: String(i.description ?? ''), added: 0, removed: 0, file: null };
    case 'TodoWrite':
      return { verb: 'Updated the plan', target: '', added: 0, removed: 0, file: null };
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? (i.questions[0] as { question?: string })?.question : '';
      return { verb: v('Asked you', 'Asking you'), target: String(q ?? ''), added: 0, removed: 0, file: null };
    }
    case 'ExitPlanMode':
      return { verb: 'Proposed a plan', target: '', added: 0, removed: 0, file: null };
    case 'Skill':
      return { verb: v('Used skill', 'Using skill'), target: String(i.skill ?? ''), added: 0, removed: 0, file: null };
    default: {
      const mcp = t.name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return { verb: v('Used', 'Using'), target: `${mcp[2]} (${mcp[1]})`, added: 0, removed: 0, file: null };
      return { verb: v('Used', 'Using'), target: t.name, added: 0, removed: 0, file: null };
    }
  }
}

export function patchStats(t: Tool): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of t.result?.patch ?? []) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  // A new file is recorded with an empty patch; count its lines instead.
  if (!added && !removed && t.name === 'Write' && typeof t.input.content === 'string') added = t.input.content.split('\n').length;
  return { added, removed };
}

/** "read 3 files, edited 2, ran 4 commands" for a collapsed step group. */
export function summarizeSteps(steps: ConversationItem[]): string {
  const tools = steps.filter((s): s is Tool => s.kind === 'tool');
  const count = (names: string[]) => tools.filter((t) => names.includes(t.name)).length;
  const parts: string[] = [];
  const read = count(['Read']);
  const edited = count(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  const ran = count(['Bash']);
  const searched = count(['Grep', 'Glob', 'WebSearch', 'WebFetch']);
  if (read) parts.push(`read ${read} file${read > 1 ? 's' : ''}`);
  if (edited) parts.push(`changed ${edited} file${edited > 1 ? 's' : ''}`);
  if (ran) parts.push(`ran ${ran} command${ran > 1 ? 's' : ''}`);
  if (searched) parts.push(`searched ${searched}×`);
  const other = tools.length - read - edited - ran - searched;
  if (other) parts.push(`${other} other`);
  return parts.join(', ');
}
