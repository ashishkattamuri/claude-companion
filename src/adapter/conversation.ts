/**
 * Turns a Claude Code transcript into what the conversation view shows: messages, tool calls with
 * their results, and quiet notices. Unlike the indexer this keeps full text, because it renders
 * a single session on demand. Like the indexer it is lenient: unknown records are skipped.
 */

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
  | { kind: 'notice'; id: string; ts: string; tone: 'info' | 'warn'; text: string };

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
}

const MAX_RESULT_CHARS = 20_000;

/** User-role text injected by the harness rather than typed by the person. */
const HARNESS_PREFIXES = ['<command-', '<local-command', '<system-reminder>', '<bash-', '<task-notification>', 'Caveat:'];

export class ConversationParser {
  private items: ConversationItem[] = [];
  private byToolUseId = new Map<string, Extract<ConversationItem, { kind: 'tool' }>>();
  facts: SessionFacts = { model: null, permissionMode: null, contextTokens: null, costUsd: null, title: null, todos: null };

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
      case 'user':
        return this.user(rec, ts);
      case 'assistant':
        return this.assistant(rec, ts);
      default:
        return [];
    }
  }

  private system(rec: Record<string, any>, ts: string): ConversationItem[] {
    if (rec.subtype === 'compact_boundary')
      return [this.add({ kind: 'notice', id: rec.uuid, ts, tone: 'info', text: 'Conversation compacted to free up context.' })];
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
    if (rec.isCompactSummary) return [];
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
    }
    if (!Array.isArray(msg.content)) return [];

    const out: ConversationItem[] = [];
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
