import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../store/db.js';
import type { Result, SideAsk, SideChat, SideMessage, SideUsage } from '../shared/api.js';
import { findTranscript } from './transcript.js';

/**
 * Side chats: questions about a chat that never enter its context.
 *
 * A thread starts as a fork of the chat (`claude -p --resume <chat> --fork-session`), so the answer
 * sees the whole conversation while nothing is written to the chat itself. The fork reuses the
 * chat's history as the request prefix, so a recently active chat is read back from the prompt
 * cache. That only holds when the request matches the chat's (same model, tools and system
 * prompt), so the fork is started with no extra flags that would change them. Follow-ups resume the
 * fork. Fork transcripts are never ingested as sessions: the scanner skips every id in side_chats.
 */

export interface SideDeps {
  db: DB;
  projectsDir: string;
  claudeBin: string;
  env: () => Record<string, string>;
  onChanged: (sessionId: string) => void;
}

interface Running {
  sessionId: string;
  proc: ChildProcess;
  partial: string;
  activity: string | null;
}

/** How much of the replied-to message goes into the first question; the fork has the rest. */
const ANCHOR_CHARS = 4000;

export class SideChats {
  private running = new Map<string, Running>();

  constructor(private d: SideDeps) {}

  list(sessionId: string): SideChat[] {
    const chats = this.d.db
      .prepare(`SELECT id, session_id, anchor_id, anchor_role, anchor_text, created_at FROM side_chats WHERE session_id = ? ORDER BY created_at`)
      .all(sessionId) as ChatRow[];
    return chats.map((c) => this.view(c));
  }

  /** Every fork id, so the scanner and sidebar can leave them out. */
  forkIds(): Set<string> {
    return new Set((this.d.db.prepare(`SELECT id FROM side_chats`).all() as { id: string }[]).map((r) => r.id));
  }

  /**
   * Asks in a thread, starting it when `ask.chatId` is missing. Resolves once claude is running;
   * the answer streams in through onChanged.
   */
  ask(sessionId: string, cwd: string | null, model: string | null, ask: SideAsk): Result<string> {
    const text = ask.text.trim();
    if (!text) return { ok: false, error: 'Nothing to ask.' };
    if (!cwd) return { ok: false, error: "This chat's project folder is unknown." };
    if (!/^[\w-]+$/.test(sessionId) || !findTranscript(this.d.projectsDir, sessionId))
      return { ok: false, error: 'This chat has no transcript yet, so there is nothing to ask about.' };

    let chatId = ask.chatId;
    let args: string[];
    let prompt = text;
    if (chatId) {
      const chat = this.row(chatId);
      if (!chat || chat.session_id !== sessionId) return { ok: false, error: 'Unknown side chat.' };
      if (this.running.has(chatId)) return { ok: false, error: 'Wait for the answer before asking again.' };
      args = ['--resume', chatId];
    } else {
      if (!ask.anchor) return { ok: false, error: 'Pick a message to ask about.' };
      chatId = randomUUID();
      this.d.db
        .prepare(`INSERT INTO side_chats(id, session_id, anchor_id, anchor_role, anchor_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(chatId, sessionId, ask.anchor.id, ask.anchor.role, ask.anchor.text, new Date().toISOString());
      args = ['--resume', sessionId, '--fork-session', '--session-id', chatId];
      prompt = firstQuestion(ask.anchor, text);
    }
    this.addMessage(chatId, { role: 'user', text, ts: new Date().toISOString(), usage: null, error: null });

    const proc = spawn(
      this.d.claudeBin,
      ['-p', ...args, ...(model ? ['--model', model] : []), '--output-format', 'stream-json', '--verbose'],
      { cwd, env: this.d.env(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const run: Running = { sessionId, proc, partial: '', activity: 'Reading the chat' };
    this.running.set(chatId, run);
    this.follow(chatId, run);
    proc.stdin.end(prompt);
    this.d.onChanged(sessionId);
    return { ok: true, value: chatId };
  }

  stop(chatId: string): void {
    this.running.get(chatId)?.proc.kill('SIGTERM');
  }

  /** Stops every answer being written (the app is quitting). */
  stopAll(): void {
    for (const r of this.running.values()) r.proc.kill('SIGTERM');
  }

  /** Deletes a thread and its fork's transcript. */
  delete(chatId: string): void {
    const chat = this.row(chatId);
    if (!chat) return;
    this.stop(chatId);
    this.removeFork(chatId);
    this.d.db.prepare(`DELETE FROM side_chats WHERE id = ?`).run(chatId);
    this.d.onChanged(chat.session_id);
  }

  /** Deletes every thread of a chat (the chat itself is being deleted). */
  deleteFor(sessionId: string): void {
    for (const c of this.list(sessionId)) this.delete(c.id);
  }

  private removeFork(chatId: string): void {
    if (!/^[\w-]+$/.test(chatId)) return;
    const path = findTranscript(this.d.projectsDir, chatId);
    if (!path) return;
    rmSync(path, { force: true });
    rmSync(join(dirname(path), chatId), { recursive: true, force: true });
  }

  /** Reads claude's stream-json output: the answer as it's written, what it's doing, and the totals. */
  private follow(chatId: string, run: Running): void {
    const texts: string[] = [];
    let result: { text: string; usage: SideUsage | null; error: string | null } | null = null;
    let stderr = '';
    let buf = '';
    run.proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    run.proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && b.text) texts.push(b.text);
            else if (b.type === 'tool_use') run.activity = describe(b.name ?? 'tool', b.input ?? {});
          }
          if (texts.length) run.partial = texts.join('\n\n');
          this.d.onChanged(run.sessionId);
        } else if (ev.type === 'result') {
          result = {
            text: (ev.result ?? '').trim() || texts.at(-1) || '',
            usage: usageOf(ev),
            error: ev.is_error ? (ev.errors?.join(' ') || ev.result || 'Claude reported an error.') : null,
          };
        }
      }
    });
    run.proc.on('error', (err) => (stderr = err.message));
    run.proc.on('close', (code, signal) => {
      this.running.delete(chatId);
      if (!this.row(chatId)) return; // deleted meanwhile
      const stopped = signal === 'SIGTERM';
      const r = result as { text: string; usage: SideUsage | null; error: string | null } | null;
      const lines = stderr.trim().split('\n');
      const crash = lines.find((l) => /error/i.test(l)) ?? lines.at(-1);
      const error = r?.error ?? (stopped ? 'Stopped.' : r ? null : crash || `claude exited with code ${code}`);
      const text = r?.text || run.partial;
      if (text || error) this.addMessage(chatId, { role: 'assistant', text, ts: new Date().toISOString(), usage: r?.usage ?? null, error });
      this.d.onChanged(run.sessionId);
    });
  }

  private addMessage(chatId: string, m: SideMessage): void {
    this.d.db
      .prepare(`INSERT INTO side_messages(chat_id, role, text, ts, usage_json, error) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chatId, m.role, m.text, m.ts, m.usage ? JSON.stringify(m.usage) : null, m.error);
  }

  private row(chatId: string): ChatRow | undefined {
    return this.d.db
      .prepare(`SELECT id, session_id, anchor_id, anchor_role, anchor_text, created_at FROM side_chats WHERE id = ?`)
      .get(chatId) as ChatRow | undefined;
  }

  private view(c: ChatRow): SideChat {
    const messages = (
      this.d.db.prepare(`SELECT role, text, ts, usage_json, error FROM side_messages WHERE chat_id = ? ORDER BY id`).all(c.id) as {
        role: 'user' | 'assistant';
        text: string;
        ts: string;
        usage_json: string | null;
        error: string | null;
      }[]
    ).map((m) => ({ role: m.role, text: m.text, ts: m.ts, usage: m.usage_json ? (JSON.parse(m.usage_json) as SideUsage) : null, error: m.error }));
    const run = this.running.get(c.id);
    return {
      id: c.id,
      sessionId: c.session_id,
      anchor: { id: c.anchor_id, role: c.anchor_role, text: c.anchor_text },
      createdAt: c.created_at,
      messages,
      running: !!run,
      partial: run?.partial || null,
      activity: run?.activity ?? null,
    };
  }
}

interface ChatRow {
  id: string;
  session_id: string;
  anchor_id: string | null;
  anchor_role: 'user' | 'assistant';
  anchor_text: string;
  created_at: string;
}

interface StreamEvent {
  type: string;
  message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  total_cost_usd?: number;
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
}

/** The first message of a thread: which message the question is about, and that it's a side question. */
export function firstQuestion(anchor: NonNullable<SideAsk['anchor']>, question: string): string {
  const quoted = anchor.text.length > ANCHOR_CHARS ? `${anchor.text.slice(0, ANCHOR_CHARS)}\n[…]` : anchor.text;
  return [
    `I have a side question about this ${anchor.role === 'user' ? 'message of mine' : 'reply of yours'} from our conversation above:`,
    `<message>\n${quoted}\n</message>`,
    "This is a separate thread, so just answer the question, briefly. Don't continue the main task and don't change any files.",
    question,
  ].join('\n\n');
}

function usageOf(ev: StreamEvent): SideUsage | null {
  if (!ev.usage) return null;
  return {
    fresh: ev.usage.input_tokens ?? 0,
    cached: ev.usage.cache_read_input_tokens ?? 0,
    cacheWrite: ev.usage.cache_creation_input_tokens ?? 0,
    output: ev.usage.output_tokens ?? 0,
    costUsd: ev.total_cost_usd ?? null,
  };
}

function describe(name: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  const short = typeof target === 'string' ? target.split('\n')[0]!.slice(0, 80) : '';
  return short ? `${name} ${short}` : name;
}
