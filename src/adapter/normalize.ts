/**
 * The only module that knows Claude Code's transcript format.
 *
 * The JSONL format is undocumented and changes between versions, so parsing is lenient:
 * anything we don't recognise becomes an `unknown` event instead of an error.
 */
import { z } from 'zod';

export type MessageKind = 'prompt' | 'meta' | 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'other';

export interface MessageEvent {
  kind: 'message';
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  ts: string;
  role: 'user' | 'assistant';
  messageKind: MessageKind;
  toolName: string | null;
  text: string;
  isSidechain: boolean;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
}

export type NormalizedEvent =
  | MessageEvent
  | { kind: 'title'; sessionId: string | null; title: string }
  | { kind: 'last_prompt'; sessionId: string | null; text: string }
  | { kind: 'name'; sessionId: string | null; name: string }
  | { kind: 'cost'; sessionId: string | null; totalCostUsd: number }
  | { kind: 'ignored'; type: string }
  | { kind: 'unknown'; type: string }
  | { kind: 'invalid' };

/** Record types we've seen and deliberately skip. */
const IGNORED_TYPES = new Set([
  'attachment',
  'mode',
  'permission-mode',
  'atis-latch',
  'file-history-snapshot',
  'queue-operation',
  'system',
  'bridge-session',
  'file-history-delta',
  'last-prompt', // when it only carries a leafUuid
]);

const MAX_TEXT = 4096;
const MAX_TOOL_RESULT = 512;

const Block = z.looseObject({ type: z.string() });

const MessageRecord = z.looseObject({
  type: z.enum(['user', 'assistant']),
  uuid: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  parentUuid: z.string().nullish(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  toolUseResult: z.unknown().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(Block)]) }),
});

/** User-role text that is harness output, not something the human typed. */
const META_PREFIXES = ['<command-', '<local-command', '<system-reminder>', '<bash-', '<task-notification>', 'Caveat:'];

export function normalizeLine(line: string): NormalizedEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'invalid' };
  }
  if (!raw || typeof raw !== 'object') return { kind: 'invalid' };
  const rec = raw as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type : '<missing>';
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : null;

  if (type === 'user' || type === 'assistant') {
    const parsed = MessageRecord.safeParse(rec);
    return parsed.success ? normalizeMessage(parsed.data) : { kind: 'unknown', type };
  }
  if (type === 'ai-title' && typeof rec.aiTitle === 'string') return { kind: 'title', sessionId, title: rec.aiTitle };
  // Older Claude Code versions wrote `summary` records that served as the session title.
  if (type === 'summary' && typeof rec.summary === 'string') return { kind: 'title', sessionId, title: rec.summary };
  if (type === 'last-prompt' && typeof rec.lastPrompt === 'string')
    return { kind: 'last_prompt', sessionId, text: rec.lastPrompt };
  if (type === 'agent-name' && typeof rec.agentName === 'string') return { kind: 'name', sessionId, name: rec.agentName };
  // Cumulative for the session, so the last record wins.
  if (type === 'cost-state' && typeof rec.totalCostUSD === 'number')
    return { kind: 'cost', sessionId, totalCostUsd: rec.totalCostUSD };
  if (IGNORED_TYPES.has(type)) return { kind: 'ignored', type };
  return { kind: 'unknown', type };
}

function normalizeMessage(r: z.infer<typeof MessageRecord>): MessageEvent {
  const { kind, toolName, text } = classifyContent(r.type, r.message.content, r.isMeta === true);
  return {
    kind: 'message',
    uuid: r.uuid,
    sessionId: r.sessionId,
    parentUuid: r.parentUuid ?? null,
    ts: r.timestamp,
    role: r.type,
    messageKind: kind,
    toolName,
    text: truncate(text, kind === 'tool_result' ? MAX_TOOL_RESULT : MAX_TEXT),
    isSidechain: r.isSidechain === true,
    cwd: r.cwd ?? null,
    gitBranch: r.gitBranch ?? null,
    version: r.version ?? null,
  };
}

function classifyContent(
  role: 'user' | 'assistant',
  content: string | z.infer<typeof Block>[],
  isMeta: boolean,
): { kind: MessageKind; toolName: string | null; text: string } {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;

  const toolUse = blocks.find((b) => b.type === 'tool_use');
  if (toolUse) {
    const name = typeof toolUse.name === 'string' ? toolUse.name : null;
    return { kind: 'tool_use', toolName: name, text: summarizeToolInput(toolUse.input) };
  }
  const toolResult = blocks.find((b) => b.type === 'tool_result');
  if (toolResult) return { kind: 'tool_result', toolName: null, text: stringifyContent(toolResult.content) };

  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();

  if (role === 'assistant') {
    if (text) return { kind: 'text', toolName: null, text };
    return { kind: blocks.some((b) => b.type === 'thinking') ? 'thinking' : 'other', toolName: null, text: '' };
  }
  if (!text) return { kind: 'other', toolName: null, text: '' };
  const meta = isMeta || META_PREFIXES.some((p) => text.startsWith(p));
  return { kind: meta ? 'meta' : 'prompt', toolName: null, text };
}

/** Keep the parts of a tool input that say what it did (file paths, commands), not file contents. */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const key of ['file_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']) {
    if (typeof i[key] === 'string') return `${key}: ${i[key]}`;
  }
  return '';
}

function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
