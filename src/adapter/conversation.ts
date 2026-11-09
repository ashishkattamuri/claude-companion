/**
 * Turns a Claude Code transcript into what the conversation view shows: messages, tool calls with
 * their results, and quiet notices. Unlike the indexer this keeps full text, because it renders
 * a single session on demand. Like the indexer it is lenient: unknown records are skipped.
 */
import { TTL_MS, duration } from '../shared/cache.js';
import { shortModel } from '../shared/model.js';

export type ConversationItem =
  | { kind: 'user'; id: string; ts: string; text: string; images: number }
  | { kind: 'assistant'; id: string; ts: string; text: string; model: string | null }
  | { kind: 'thinking'; id: string; ts: string; text: string }
  | {
      kind: 'tool';
      id: string;
      ts: string;
      name: string;
      input: Record<string, unknown>;
      /** Filled in when the tool_result arrives; until then the call is pending. */
      result: ToolResult | null;
    }
  | {
      kind: 'notice';
      id: string;
      ts: string;
      tone: 'info' | 'warn';
      text: string;
      /** Set on a model call that missed the prompt cache: what it reprocessed, and the likely cause. */
      cacheMiss?: { tokens: number; reason: CacheMissReason };
      /** Set on a compaction: its numbers, and the summary Claude works from afterwards. */
      compaction?: Compaction;
    };

/** One compaction, from Claude Code's compact_boundary record and the summary that follows it. */
export interface Compaction {
  /** Started by Claude Code when the context filled up, or by you (/compact). */
  trigger: 'auto' | 'manual' | null;
  before: number | null;
  after: number | null;
  /** Tokens dropped by every compaction in the chat so far, this one included. */
  droppedTotal: number | null;
  durationMs: number | null;
  /** What the model works from instead of the earlier conversation; null until it's recorded. */
  summary: string | null;
}

/**
 * Why a call reprocessed the conversation instead of reading it from the cache, judged from the
 * transcript (the API's own cache diagnostics need an API key Companion doesn't use). The first
 * that applies wins: model, then compaction, then expiry, then a change of tools or skills.
 */
export type CacheMissReason = 'model' | 'compacted' | 'expired' | 'tools' | 'unknown';

export interface ToolResult {
  text: string;
  isError: boolean;
  /** Unified-diff hunks Claude Code records for edits. */
  patch: PatchHunk[] | null;
  truncated: boolean;
}

export interface PatchHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** Session-level facts the side panel shows. */
export interface SessionFacts {
  model: string | null;
  permissionMode: string | null;
  /** Tokens in the context window as of the last model call. */
  contextTokens: number | null;
  costUsd: number | null;
  title: string | null;
  todos: { content: string; status: string }[] | null;
  /**
   * Whether Claude has Companion's new-chat tool in this session: true or false once the session
   * has listed its tools (on its first turn), null before that.
   */
  newChatTool: boolean | null;
  /** The prompt cache as of the last model call, or null before the first one. */
  cache: CacheFacts | null;
  /** How often the chat was compacted, when last, and how much it has dropped in all. */
  compactions: { count: number; lastAt: string | null; droppedTotal: number };
}

/** What the last model call read from and wrote to the prompt cache, and how long the cache lives. */
export interface CacheFacts {
  /** When the call's response was recorded; the cache lives for `ttl` after it. */
  at: string;
  read: number;
  written: number;
  /** Input past the last cache breakpoint: processed at full price and not cached. */
  uncached: number;
  /** From the cache writes so far (reads don't say); null until one is seen. */
  ttl: '5m' | '1h' | null;
}

export const NEW_CHAT_TOOL = 'mcp__companion__start_new_chat';

const MAX_RESULT_CHARS = 20_000;

/**
 * A call missed the cache when it read at least this much less than the previous call left cached.
 * (Writing a lot is not a miss: a big tool result is new input, cached for the first time.)
 */
const MISS_MIN_TOKENS = 20_000;

/** Records that change the tools, MCP servers or skills Claude has. */
const TOOL_CHANGES = new Set(['deferred_tools_delta', 'mcp_instructions_delta', 'skill_listing', 'agent_listing_delta']);

/** User-role text injected by the harness rather than typed by the person. */
const HARNESS_PREFIXES = ['<command-', '<local-command', '<system-reminder>', '<bash-', '<task-notification>', 'Caveat:'];

export class ConversationParser {
  private items: ConversationItem[] = [];
  private byToolUseId = new Map<string, Extract<ConversationItem, { kind: 'tool' }>>();
  /** The previous model call, and what happened between it and the next one. */
  private lastCall: { id: string; ts: string; model: string | null; cached: number } | null = null;
  private since = new Set<'compacted' | 'tools'>();
  facts: SessionFacts = { model: null, permissionMode: null, contextTokens: null, costUsd: null, title: null, todos: null, newChatTool: null, cache: null, compactions: { count: 0, lastAt: null, droppedTotal: 0 } };
  /** Compaction notices by their boundary record's uuid, so the summary that follows can join them. */
  private compactionsById = new Map<string, Extract<ConversationItem, { kind: 'notice' }>>();

  /** Feeds raw JSONL lines; returns the items that were added or changed. */
  push(lines: string[]): ConversationItem[] {
    const changed = new Map<string, ConversationItem>();
    for (const line of lines) {
      let rec: Record<string, any>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object' || rec.isSidechain) continue;
      for (const item of this.record(rec)) changed.set(item.id, item);
    }
    return [...changed.values()];
  }

  all(): ConversationItem[] {
    return this.items;
  }

  private add(item: ConversationItem): ConversationItem {
    this.items.push(item);
    return item;
  }

  private record(rec: Record<string, any>): ConversationItem[] {
    const ts: string = rec.timestamp ?? '';
    switch (rec.type) {
      case 'ai-title':
        if (typeof rec.aiTitle === 'string') this.facts.title = rec.aiTitle;
        return [];
      case 'permission-mode':
        if (typeof rec.permissionMode === 'string') this.facts.permissionMode = rec.permissionMode;
        return [];
      case 'cost-state':
        if (typeof rec.totalCostUSD === 'number') this.facts.costUsd = rec.totalCostUSD;
        return [];
      case 'system':
        return this.system(rec, ts);
      case 'attachment':
        this.attachment(rec.attachment);
        return [];
      case 'user':
        return this.user(rec, ts);
      case 'assistant':
        return this.assistant(rec, ts);
      default:
        return [];
    }
  }

  /** Claude Code lists the (deferred) tools a session has; that tells us whether the new-chat tool is there. */
  private attachment(a: Record<string, any> | undefined): void {
    if (TOOL_CHANGES.has(a?.type)) this.since.add('tools');
    if (a?.type !== 'deferred_tools_delta') return;
    if ((a.addedNames ?? []).includes(NEW_CHAT_TOOL)) this.facts.newChatTool = true;
    else if ((a.removedNames ?? []).includes(NEW_CHAT_TOOL)) this.facts.newChatTool = false;
    else if (this.facts.newChatTool === null && (a.addedNames ?? []).length) this.facts.newChatTool = false;
  }

  private system(rec: Record<string, any>, ts: string): ConversationItem[] {
    if (rec.subtype === 'compact_boundary') return [this.compacted(rec, ts)];
    if (rec.subtype === 'away_summary' && typeof rec.content === 'string')
      return [
        this.add({
          kind: 'notice',
          id: rec.uuid,
          ts,
          tone: 'info',
          text: `Recap: ${rec.content.replace(/\s*\(disable recaps in \/config\)\s*$/, '')}`,
        }),
      ];
    return [];
  }

  private user(rec: Record<string, any>, ts: string): ConversationItem[] {
    const content = rec.message?.content;
    if (rec.isCompactSummary) {
      const notice = this.compactionsById.get(rec.parentUuid) ?? [...this.compactionsById.values()].at(-1);
      if (!notice?.compaction) return [];
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n') : '';
      notice.compaction.summary = summaryBody(text);
      return [notice];
    }
    if (typeof content === 'string') return this.userText(rec, ts, content, 0);
    if (!Array.isArray(content)) return [];

    const out: ConversationItem[] = [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const tool = this.byToolUseId.get(block.tool_use_id);
      if (!tool) continue;
      tool.result = toolResult(block, rec.toolUseResult);
      if (tool.name === 'TodoWrite' && Array.isArray(tool.input.todos)) this.facts.todos = tool.input.todos as SessionFacts['todos'];
      out.push(tool);
    }
    if (out.length) return out;

    const text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
    const images = content.filter((b: any) => b?.type === 'image').length;
    return this.userText(rec, ts, text, images);
  }

  private userText(rec: Record<string, any>, ts: string, raw: string, images: number): ConversationItem[] {
    const text = raw.trim();
    if (text.startsWith('[Request interrupted'))
      return [this.add({ kind: 'notice', id: rec.uuid, ts, tone: 'warn', text: 'You interrupted Claude.' })];
    if (rec.isMeta || HARNESS_PREFIXES.some((p) => text.startsWith(p))) {
      const command = text.match(/<command-name>([^<]+)<\/command-name>/)?.[1];
      return command ? [this.add({ kind: 'notice', id: rec.uuid, ts, tone: 'info', text: `Ran ${command}` })] : [];
    }
    if (!text && !images) return [];
    return [this.add({ kind: 'user', id: rec.uuid, ts, text, images })];
  }

  private assistant(rec: Record<string, any>, ts: string): ConversationItem[] {
    const msg = rec.message ?? {};
    if (typeof msg.model === 'string' && msg.model !== '<synthetic>') this.facts.model = msg.model;
    const usage = msg.usage;
    if (usage && typeof usage.input_tokens === 'number') {
      this.facts.contextTokens =
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const split = usage.cache_creation ?? {};
      const ttl = split.ephemeral_1h_input_tokens > 0 ? '1h' : split.ephemeral_5m_input_tokens > 0 ? '5m' : (this.facts.cache?.ttl ?? null);
      this.facts.cache = {
        at: ts,
        read: usage.cache_read_input_tokens ?? 0,
        written: usage.cache_creation_input_tokens ?? 0,
        uncached: usage.input_tokens,
        ttl,
      };
    }
    const out: ConversationItem[] = [];
    // One call can be recorded as several records (one per content block) with the same usage.
    if (usage && typeof msg.id === 'string' && msg.id !== this.lastCall?.id && msg.model !== '<synthetic>') {
      const miss = this.lastCall && this.cacheMiss(this.facts.cache!, this.lastCall, msg.model ?? null);
      if (miss) out.push(this.add({ kind: 'notice', id: `${rec.uuid}:cache`, ts, tone: miss.reason === 'compacted' ? 'info' : 'warn', text: miss.text, cacheMiss: miss }));
      this.lastCall = { id: msg.id, ts, model: msg.model ?? null, cached: this.facts.cache!.read + this.facts.cache!.written };
      this.since.clear();
    }
    if (!Array.isArray(msg.content)) return out;

    msg.content.forEach((block: any, i: number) => {
      // One record per content block today, but older versions put several blocks in one record.
      const id = msg.content.length > 1 ? `${rec.uuid}:${i}` : rec.uuid;
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (rec.isApiErrorMessage) out.push(this.add({ kind: 'notice', id, ts, tone: 'warn', text: block.text.trim() }));
        else out.push(this.add({ kind: 'assistant', id, ts, text: block.text, model: this.facts.model }));
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.push(this.add({ kind: 'thinking', id, ts, text: block.thinking }));
      } else if (block?.type === 'tool_use') {
        const tool = this.add({
          kind: 'tool',
          id,
          ts,
          name: String(block.name ?? 'tool'),
          input: block.input && typeof block.input === 'object' ? block.input : {},
          result: null,
        }) as Extract<ConversationItem, { kind: 'tool' }>;
        this.byToolUseId.set(block.id, tool);
        out.push(tool);
      }
    });
    return out;
  }

  private compacted(rec: Record<string, any>, ts: string): ConversationItem {
    this.since.add('compacted');
    const m = rec.compactMetadata ?? {};
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const compaction: Compaction = {
      trigger: m.trigger === 'auto' || m.trigger === 'manual' ? m.trigger : null,
      before: num(m.preTokens),
      after: num(m.postTokens),
      droppedTotal: num(m.cumulativeDroppedTokens),
      durationMs: num(m.durationMs),
      summary: null,
    };
    const c = this.facts.compactions;
    const dropped = compaction.droppedTotal ?? c.droppedTotal + (compaction.before !== null && compaction.after !== null ? compaction.before - compaction.after : 0);
    this.facts.compactions = { count: c.count + 1, lastAt: ts, droppedTotal: dropped };
    // The context is the compacted size from here, not what the last call before it used.
    if (compaction.after !== null) this.facts.contextTokens = compaction.after;
    const text =
      compaction.before !== null && compaction.after !== null
        ? `Compacted ${k(compaction.before)} → ${k(compaction.after)} tokens`
        : 'Conversation compacted to free up context.';
    const notice = this.add({ kind: 'notice', id: rec.uuid, ts, tone: 'info', text, compaction }) as Extract<ConversationItem, { kind: 'notice' }>;
    this.compactionsById.set(rec.uuid, notice);
    return notice;
  }

  /** Whether this call missed the cache and, if so, the likely cause in words. */
  private cacheMiss(
    cache: CacheFacts,
    prev: { ts: string; model: string | null; cached: number },
    model: string | null,
  ): { tokens: number; reason: CacheMissReason; text: string } | null {
    // What the previous call left cached (no more than this call's input, which compacting shrinks),
    // minus what this one read of it: processed again.
    const tokens = Math.min(prev.cached, cache.read + cache.written + cache.uncached) - cache.read;
    if (tokens < MISS_MIN_TOKENS) return null;
    const size = `~${k(tokens)} tokens`;
    const missed = `Cache miss · ${size} processed again at full price.`;
    const gap = Date.parse(cache.at) - Date.parse(prev.ts);
    if (prev.model && model && prev.model !== model)
      return { tokens, reason: 'model', text: `${missed} The model changed (${shortModel(prev.model)} → ${shortModel(model)}), and each model has its own cache.` };
    if (this.since.has('compacted'))
      return { tokens, reason: 'compacted', text: `${size} cached afresh after compacting, as expected: compacting replaces the conversation.` };
    if (cache.ttl && gap > TTL_MS[cache.ttl])
      return { tokens, reason: 'expired', text: `${missed} The cache had expired: ${duration(gap)} since the previous reply, and it lasts ${cache.ttl === '1h' ? '1 h' : '5 min'}.` };
    if (this.since.has('tools'))
      return { tokens, reason: 'tools', text: `${missed} The tools or skills Claude has changed just before (MCP servers, deferred tools or skills).` };
    return { tokens, reason: 'unknown', text: `${missed} No cause found in the transcript.` };
  }
}

/** 1500 → "1.5k", 142000 → "142k". */
const k = (n: number) => (n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));

/** The summary without Claude Code's lead-in ("This session is being continued … Summary:"). */
function summaryBody(text: string): string {
  const t = text.trim();
  const at = t.search(/^Summary:\s*$/m);
  return (at >= 0 && at < 400 ? t.slice(at).replace(/^Summary:\s*/, '') : t).trim();
}

function toolResult(block: any, structured: any): ToolResult {
  let text = '';
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content))
    text = block.content
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  const truncated = text.length > MAX_RESULT_CHARS;
  const patch = Array.isArray(structured?.structuredPatch)
    ? structured.structuredPatch
        .filter((h: any) => Array.isArray(h?.lines))
        .map((h: any) => ({ oldStart: h.oldStart ?? 0, newStart: h.newStart ?? 0, lines: h.lines.map(String) }))
    : null;
  return { text: truncated ? text.slice(0, MAX_RESULT_CHARS) : text, isError: block.is_error === true, patch, truncated };
}
