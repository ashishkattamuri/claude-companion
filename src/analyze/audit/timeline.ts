import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * A session as the audit sees it: every model call with its token usage, and every tool call with
 * its full input and output. Built from the transcript file, not the database, because the
 * database keeps only the first 512 characters of tool output.
 *
 * Claude Code writes one model response as several records (one per content block), each repeating
 * the same usage, so calls are keyed by message id and counted once. Subagents write their own
 * transcripts under `<session>/subagents/`; their calls are included and tied to the tool call that
 * started them.
 */

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface ModelCall {
  index: number;
  id: string;
  ts: string;
  model: string | null;
  usage: Usage;
  /** Tokens sent to the model: the whole context at this call. */
  prompt: number;
  /** null for the main conversation, otherwise the subagent's id. */
  agent: string | null;
  turn: number;
  /** Tool calls this response made. */
  tools: number[];
}

export interface ToolStep {
  index: number;
  /** Same id the conversation view uses, so a finding can link to the step. */
  id: string;
  toolUseId: string;
  ts: string;
  agent: string | null;
  turn: number;
  call: number;
  cwd: string | null;
  name: string;
  input: Record<string, any>;
  result: StepResult | null;
}

export interface StepResult {
  text: string;
  isError: boolean;
  chars: number;
  /** Tokens this result added to the context, from how much the next call's context grew. */
  tokens: number;
  /** How many model calls carried it in their context, until the conversation was compacted. */
  sent: number;
  /** The call it first reached the model in, or null if no call came after it. */
  firstCall: number | null;
}

export interface UserMessage {
  id: string;
  ts: string;
  turn: number;
  text: string;
}

/** What Claude wrote to the user (not its thinking): evidence of what it used. */
export interface AssistantText {
  agent: string | null;
  call: number;
  text: string;
}

export interface Timeline {
  sessionId: string;
  calls: ModelCall[];
  steps: ToolStep[];
  messages: UserMessage[];
  texts: AssistantText[];
  /** Index of the first main-conversation call after each /compact. */
  compactions: number[];
  /** Subagents and the tool call that started each. */
  agents: { agentId: string; toolUseId: string | null }[];
  costUsd: number | null;
}

/** Relative price of each kind of token, against fresh input. Used to rank waste, not to bill. */
export const WEIGHTS: Usage = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

export const weighted = (u: Usage) =>
  u.input * WEIGHTS.input + u.cacheWrite * WEIGHTS.cacheWrite + u.cacheRead * WEIGHTS.cacheRead + u.output * WEIGHTS.output;

/** User-role text injected by the harness rather than typed by the person. */
const HARNESS_PREFIXES = ['<command-', '<local-command', '<system-reminder>', '<bash-', '<task-notification>', 'Caveat:'];

interface Pending {
  chars: number;
  step: ToolStep | null;
}

/** Per-conversation state: the main session and each subagent are parsed the same way. */
class Thread {
  calls: ModelCall[] = [];
  pending: Pending[] = [];
  compactedSinceLast = false;

  constructor(
    readonly agent: string | null,
    public turn: number,
  ) {}
}

export function loadTimeline(path: string): Timeline {
  const sessionId = basename(path, '.jsonl');
  const b = new TimelineBuilder(sessionId);
  b.feed(readLines(path), null);
  for (const sub of subagentFiles(path)) b.feed(readLines(sub.path), sub.agentId, sub.toolUseId);
  return b.finish();
}

export function timelineFromLines(sessionId: string, lines: string[], subagents: { agentId: string; toolUseId: string | null; lines: string[] }[] = []): Timeline {
  const b = new TimelineBuilder(sessionId);
  b.feed(lines, null);
  for (const s of subagents) b.feed(s.lines, s.agentId, s.toolUseId);
  return b.finish();
}

class TimelineBuilder {
  private calls: ModelCall[] = [];
  private steps: ToolStep[] = [];
  private messages: UserMessage[] = [];
  private texts: AssistantText[] = [];
  private compactions: number[] = [];
  private costUsd: number | null = null;
  private byToolUseId = new Map<string, ToolStep>();
  private threads: Thread[] = [];
  private agents: Timeline['agents'] = [];

  constructor(private sessionId: string) {}

  feed(lines: string[], agent: string | null, parentToolUseId: string | null = null): void {
    if (agent) this.agents.push({ agentId: agent, toolUseId: parentToolUseId });
    const turn = parentToolUseId ? (this.byToolUseId.get(parentToolUseId)?.turn ?? 0) : 0;
    const t = new Thread(agent, turn);
    this.threads.push(t);
    const byMessageId = new Map<string, ModelCall>();
    for (const line of lines) {
      let rec: Record<string, any>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      // Older Claude Code versions wrote subagent records inline; they belong to no thread we track.
      if (agent === null && rec.isSidechain) continue;
      // On a subscription Claude Code records 0; treat that as unknown.
      if (rec.type === 'cost-state' && typeof rec.totalCostUSD === 'number' && agent === null) this.costUsd = rec.totalCostUSD > 0 ? rec.totalCostUSD : null;
      else if (rec.type === 'system' && rec.subtype === 'compact_boundary') t.compactedSinceLast = true;
      else if (rec.type === 'assistant') this.assistant(t, rec, byMessageId);
      else if (rec.type === 'user') this.user(t, rec);
    }
  }

  private assistant(t: Thread, rec: Record<string, any>, byMessageId: Map<string, ModelCall>): void {
    const msg = rec.message ?? {};
    if (msg.model === '<synthetic>') return;
    const key = String(msg.id ?? rec.requestId ?? rec.uuid);
    let call = byMessageId.get(key);
    const u = msg.usage;
    const usage: Usage = {
      input: num(u?.input_tokens),
      cacheWrite: num(u?.cache_creation_input_tokens),
      cacheRead: num(u?.cache_read_input_tokens),
      output: num(u?.output_tokens),
    };
    if (!call) {
      call = {
        index: this.calls.length,
        id: key,
        ts: rec.timestamp ?? '',
        model: typeof msg.model === 'string' ? msg.model : null,
        usage,
        prompt: usage.input + usage.cacheWrite + usage.cacheRead,
        agent: t.agent,
        turn: t.turn,
        tools: [],
      };
      this.attribute(t, call);
      this.calls.push(call);
      t.calls.push(call);
      byMessageId.set(key, call);
    } else {
      // Later records of the same response can carry the final output count.
      call.usage.output = Math.max(call.usage.output, usage.output);
    }
    if (!Array.isArray(msg.content)) return;
    msg.content.forEach((block: any, i: number) => {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) this.texts.push({ agent: t.agent, call: call!.index, text: block.text });
      if (block?.type !== 'tool_use') return;
      const local = msg.content.length > 1 ? `${rec.uuid}:${i}` : String(rec.uuid);
      const step: ToolStep = {
        index: this.steps.length,
        id: t.agent ? `agent:${t.agent}:${local}` : local,
        toolUseId: String(block.id ?? ''),
        ts: rec.timestamp ?? '',
        agent: t.agent,
        turn: t.turn,
        call: call!.index,
        cwd: typeof rec.cwd === 'string' ? rec.cwd : null,
        name: String(block.name ?? 'tool'),
        input: block.input && typeof block.input === 'object' ? block.input : {},
        result: null,
      };
      this.steps.push(step);
      call!.tools.push(step.index);
      if (step.toolUseId) this.byToolUseId.set(step.toolUseId, step);
    });
  }

  private user(t: Thread, rec: Record<string, any>): void {
    if (rec.isCompactSummary) return;
    const content = rec.message?.content;
    if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const step = this.byToolUseId.get(block.tool_use_id);
        const text = resultText(block.content);
        if (step) step.result = { text, isError: block.is_error === true, chars: text.length, tokens: 0, sent: 0, firstCall: null };
        t.pending.push({ chars: text.length, step: step ?? null });
      }
      return;
    }
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n')
          : '';
    t.pending.push({ chars: text.length, step: null });
    const trimmed = text.trim();
    if (t.agent || rec.isMeta || !trimmed || trimmed.startsWith('[Request interrupted') || HARNESS_PREFIXES.some((p) => trimmed.startsWith(p)))
      return;
    t.turn++;
    this.messages.push({ id: String(rec.uuid), ts: rec.timestamp ?? '', turn: t.turn, text: trimmed });
  }

  /**
   * Splits how much the context grew since the previous call among what arrived in between, by
   * size. The transcript has no per-result token counts, but the growth is exact; bounds keep one
   * result from soaking up growth that came from something unrecorded (reminders, attachments).
   */
  private attribute(t: Thread, call: ModelCall): void {
    const last = t.calls.at(-1);
    const growth = last && !t.compactedSinceLast ? call.prompt - last.prompt - last.usage.output : -1;
    const chars = t.pending.reduce((s, p) => s + p.chars, 0);
    if (t.compactedSinceLast && t.agent === null) this.compactions.push(call.index);
    for (const p of t.pending) {
      if (!p.step?.result) continue;
      const est = growth > 0 && chars > 0 ? (growth * p.chars) / chars : p.chars / 4;
      p.step.result.tokens = Math.round(Math.min(p.chars / 2, Math.max(p.chars / 6, est)));
      p.step.result.firstCall = call.index;
    }
    t.pending = [];
    t.compactedSinceLast = false;
  }

  finish(): Timeline {
    for (const t of this.threads) {
      const cut = new Set(t.agent === null ? this.compactions : []);
      const order = t.calls.map((c) => c.index);
      const pos = new Map(order.map((c, i) => [c, i]));
      for (const s of this.steps) {
        const r = s.result;
        if (s.agent !== t.agent || !r || r.firstCall === null) continue;
        let sent = 0;
        for (let i = pos.get(r.firstCall)!; i < order.length; i++) {
          if (sent > 0 && cut.has(order[i]!)) break;
          sent++;
        }
        r.sent = sent;
      }
    }
    return { sessionId: this.sessionId, calls: this.calls, steps: this.steps, messages: this.messages, texts: this.texts, compactions: this.compactions, agents: this.agents, costUsd: this.costUsd };
  }
}

/** The next call in the same conversation after `call`, or null. */
export function nextCall(tl: Timeline, call: ModelCall): ModelCall | null {
  for (let i = call.index + 1; i < tl.calls.length; i++) if (tl.calls[i]!.agent === call.agent) return tl.calls[i]!;
  return null;
}

function subagentFiles(path: string): { path: string; agentId: string; toolUseId: string | null }[] {
  const dir = join(dirname(path), basename(path, '.jsonl'), 'subagents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .map((f) => {
      const agentId = f.slice('agent-'.length, -'.jsonl'.length);
      let toolUseId: string | null = null;
      try {
        toolUseId = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), 'utf8')).toolUseId ?? null;
      } catch {
        // No meta: the subagent's calls still count, under turn 0.
      }
      return { path: join(dir, f), agentId, toolUseId };
    });
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
