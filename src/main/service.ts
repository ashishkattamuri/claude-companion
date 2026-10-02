import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ConversationItem } from '../adapter/conversation.js';
import type { LlmClient } from '../analyze/llm.js';
import { getRecap, recapDay } from '../analyze/recap.js';
import { analysisNeeded, currentStatus, runJobs } from '../analyze/runner.js';
import type { Config } from '../config.js';
import type { LiveSession } from '../ingest/live.js';
import { scan } from '../ingest/scanner.js';
import type { DB } from '../store/db.js';
import { getSession, listProjects, listSessions, type SessionRow } from '../store/queries.js';
import type { NewSessionRequest, RecapView, Result, SessionListItem, SessionSnapshot, SessionState } from '../shared/api.js';
import { SessionChannel, type ChannelDeps } from './session.js';

export interface ServiceDeps {
  db: DB;
  cfg: Config;
  llm: LlmClient;
  loadLive: () => LiveSession[];
  env: () => Record<string, string>;
  claudeBin?: string;
  /** Background summaries and recaps; off in end-to-end tests so they make no extra model calls. */
  analysis?: boolean;
  /** Tests inject a fake channel factory; the app uses real pseudo-terminals. */
  createChannel?: (id: string, deps: ChannelDeps, info: ConstructorParameters<typeof SessionChannel>[2]) => SessionChannel;
  onItems?: (sessionId: string, items: ConversationItem[]) => void;
  onState?: (state: SessionState) => void;
  onData?: (sessionId: string, data: string, end: number) => void;
  onSent?: (sessionId: string, itemId: string) => void;
  onChanged?: () => void;
}

/**
 * Everything the window can ask for, independent of Electron. The main process wires these
 * methods to IPC. One SessionChannel per session the window has open or the app is running.
 */
export class CompanionService {
  private channels = new Map<string, SessionChannel>();
  private analyzing: Promise<void> | null = null;

  constructor(private d: ServiceDeps) {}

  refresh(): void {
    scan(this.d.db, this.d.cfg);
  }

  listSessions(query: { search?: string }): SessionListItem[] {
    const live = new Map(this.d.loadLive().map((l) => [l.sessionId, l]));
    const rows = listSessions(this.d.db, { search: query.search });
    const items: SessionListItem[] = rows.map((r) => this.listItem(r, live.get(r.id) ?? null));
    const known = new Set(rows.map((r) => r.id));

    if (!query.search) {
      // Running sessions with no transcript yet: just started here or elsewhere.
      for (const ch of this.channels.values()) {
        if (known.has(ch.sessionId) || !ch.running) continue;
        known.add(ch.sessionId);
        items.push(this.listItem(placeholderRow(ch.sessionId, ch.state.cwd, ch.state.title), live.get(ch.sessionId) ?? null));
      }
      for (const l of live.values()) {
        if (known.has(l.sessionId)) continue;
        items.push(this.listItem(placeholderRow(l.sessionId, l.cwd, l.name ?? '(new session)'), l));
      }
    }
    const rank = (s: SessionListItem) => (s.status === 'waiting' ? 3 : s.owned ? 2 : s.live ? 1 : 0);
    return items.sort((a, b) => rank(b) - rank(a) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  }

  private listItem(row: SessionRow, live: LiveSession | null): SessionListItem {
    const ch = this.channels.get(row.id);
    const owned = !!ch?.running;
    const status = owned ? ch!.state.status : live ? (live.status === 'busy' ? 'busy' : live.status === 'waiting' ? 'waiting' : 'idle') : null;
    // A session running here also shows in Claude Code's registry; it's ours, not "elsewhere".
    return { ...row, live: owned ? null : live, owned, status };
  }

  listProjects() {
    return listProjects(this.d.db).filter((p) => existsSync(p.cwd));
  }

  getRecap(): RecapView {
    return { recap: getRecap(this.d.db, recapDay(this.d.cfg).day), status: currentStatus(this.d.db, this.d.cfg) };
  }

  analyze(opts: { force?: boolean; endedSessionIds?: string[] } = {}): Promise<void> {
    if (this.d.analysis === false) return Promise.resolve();
    if (this.analyzing) return this.analyzing;
    if (!opts.force && !analysisNeeded(this.d.db, this.d.cfg)) return Promise.resolve();
    this.analyzing = runJobs(this.d.db, this.d.cfg, this.d.llm, { forceRecap: opts.force, endedSessionIds: opts.endedSessionIds })
      .then(() => undefined)
      .catch(() => undefined) // recorded in the analyzer status, which the window shows
      .finally(() => {
        this.analyzing = null;
        this.d.onChanged?.();
      });
    this.d.onChanged?.();
    return this.analyzing;
  }

  openSession(sessionId: string): Result<SessionSnapshot> {
    const existing = this.channels.get(sessionId);
    if (existing) return { ok: true, value: existing.snapshot() };
    const row = getSession(this.d.db, sessionId);
    const live = this.d.loadLive().find((l) => l.sessionId === sessionId) ?? null;
    if (!row && !live) return { ok: false, error: 'Unknown session.' };
    const ch = this.channel(sessionId, {
      cwd: row?.cwd ?? live?.cwd ?? null,
      title: row?.title ?? live?.name ?? '(new session)',
      mode: live ? 'mirror' : 'history',
      mirrorPid: live?.pid,
    });
    return { ok: true, value: ch.snapshot() };
  }

  /** The window stopped showing a session. Sessions running here keep running. */
  closeSessionView(sessionId: string): void {
    const ch = this.channels.get(sessionId);
    if (ch && !ch.running) {
      ch.dispose();
      this.channels.delete(sessionId);
    }
  }

  newSession(req: NewSessionRequest): Result<string> {
    if (!existsSync(req.cwd)) return { ok: false, error: `Folder not found: ${req.cwd}` };
    // Choosing the id up front ties the session to its transcript from the first message.
    const sessionId = randomUUID();
    const prompt = req.prompt?.trim();
    const args = ['--session-id', sessionId];
    if (req.model) args.push('--model', req.model);
    if (req.permissionMode && req.permissionMode !== 'default') args.push('--permission-mode', req.permissionMode);
    if (req.worktree) args.push('--worktree');
    if (prompt) args.push(prompt);
    const ch = this.channel(sessionId, {
      cwd: req.cwd,
      title: prompt ? prompt.split('\n')[0]!.slice(0, 80) : `New session · ${basename(req.cwd)}`,
      mode: 'owned',
    });
    if (prompt) ch.expectFromApp(prompt);
    try {
      ch.start(args);
    } catch (err) {
      this.dropChannel(sessionId);
      return { ok: false, error: `Could not start claude: ${(err as Error).message}` };
    }
    this.d.onChanged?.();
    return { ok: true, value: sessionId };
  }

  send(sessionId: string, text: string): Result {
    if (!text.trim()) return { ok: false, error: 'Nothing to send.' };
    const opened = this.openSession(sessionId);
    if (!opened.ok) return opened;
    const ch = this.channels.get(sessionId)!;
    if (ch.state.mode === 'mirror')
      return { ok: false, error: 'This session is running in another terminal. Quit it there to continue here.' };
    if (!ch.running) {
      const row = getSession(this.d.db, sessionId);
      if (row?.transcriptGone) return { ok: false, error: 'Claude Code deleted this transcript, so it can no longer be continued.' };
      if (!ch.state.cwd || !existsSync(ch.state.cwd)) return { ok: false, error: `Project folder not found: ${ch.state.cwd ?? 'unknown'}` };
      try {
        ch.start(['--resume', sessionId]);
      } catch (err) {
        return { ok: false, error: `Could not start claude: ${(err as Error).message}` };
      }
      this.d.onChanged?.();
    }
    ch.send(text);
    return { ok: true, value: undefined };
  }

  answer(sessionId: string, key: string): void {
    this.channels.get(sessionId)?.answer(key);
  }

  interrupt(sessionId: string): void {
    this.channels.get(sessionId)?.interrupt();
  }

  cyclePermissionMode(sessionId: string): void {
    this.channels.get(sessionId)?.cyclePermissionMode();
  }

  stop(sessionId: string): void {
    this.channels.get(sessionId)?.stop();
  }

  replay(sessionId: string): { data: string; end: number } | null {
    return this.channels.get(sessionId)?.snapshot().replay ?? null;
  }

  write(sessionId: string, data: string): void {
    this.channels.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.channels.get(sessionId)?.resize(cols, rows);
  }

  running(): SessionChannel[] {
    return [...this.channels.values()].filter((c) => c.running);
  }

  disposeAll(): void {
    for (const id of [...this.channels.keys()]) this.dropChannel(id);
  }

  private channel(sessionId: string, info: ConstructorParameters<typeof SessionChannel>[2]): SessionChannel {
    const deps: ChannelDeps = {
      projectsDir: this.d.cfg.projectsDir,
      claudeDir: this.d.cfg.claudeDir,
      claudeBin: this.d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude',
      env: this.d.env,
    };
    const ch = this.d.createChannel ? this.d.createChannel(sessionId, deps, info) : new SessionChannel(sessionId, deps, info);
    ch.on('items', (items: ConversationItem[]) => this.d.onItems?.(sessionId, items));
    ch.on('state', (state: SessionState) => this.d.onState?.(state));
    ch.on('data', (data: string, end: number) => this.d.onData?.(sessionId, data, end));
    ch.on('sent', (itemId: string) => this.d.onSent?.(sessionId, itemId));
    ch.on('status', () => this.d.onChanged?.());
    ch.on('exit', () => {
      // The session just ended: index it and refresh its summary.
      this.refresh();
      void this.analyze({ endedSessionIds: [sessionId] });
      this.d.onChanged?.();
    });
    this.channels.set(sessionId, ch);
    return ch;
  }

  private dropChannel(sessionId: string): void {
    this.channels.get(sessionId)?.dispose();
    this.channels.delete(sessionId);
  }
}

function placeholderRow(id: string, cwd: string | null, title: string): SessionRow {
  return {
    id,
    cwd,
    project: cwd ? basename(cwd) : null,
    projectId: null,
    gitBranch: null,
    title,
    lastPrompt: null,
    firstTs: null,
    lastTs: new Date().toISOString(),
    prompts: 0,
    messages: 0,
    costUsd: null,
    transcriptGone: false,
    summary: null,
  };
}
