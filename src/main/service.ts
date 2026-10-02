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
import { startBackground, stopBackground } from './background.js';
import { SessionChannel, type ChannelDeps, type ChannelInfo } from './session.js';
import { openInTerminalApp } from './terminal-app.js';

export interface ServiceDeps {
  db: DB;
  cfg: Config;
  llm: LlmClient;
  loadLive: () => LiveSession[];
  env: () => Record<string, string>;
  claudeBin?: string;
  /** Background summaries and recaps; off in end-to-end tests so they make no extra model calls. */
  analysis?: boolean;
  onItems?: (sessionId: string, items: ConversationItem[]) => void;
  onState?: (state: SessionState) => void;
  onData?: (sessionId: string, data: string, end: number) => void;
  onSent?: (sessionId: string, itemId: string) => void;
  onChanged?: () => void;
}

const ok: Result = { ok: true, value: undefined };

/**
 * Everything the window can ask for, independent of Electron. The main process wires these
 * methods to IPC. One SessionChannel per session the window has open or has attached to.
 */
export class CompanionService {
  private channels = new Map<string, SessionChannel>();
  private analyzing: Promise<void> | null = null;

  constructor(private d: ServiceDeps) {}

  private get channelDeps(): ChannelDeps {
    return {
      projectsDir: this.d.cfg.projectsDir,
      claudeDir: this.d.cfg.claudeDir,
      claudeBin: this.d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude',
      env: this.d.env,
    };
  }

  refresh(): void {
    scan(this.d.db, this.d.cfg);
  }

  listSessions(query: { search?: string }): SessionListItem[] {
    const live = new Map(this.d.loadLive().map((l) => [l.sessionId, l]));
    const rows = listSessions(this.d.db, { search: query.search });
    const items = rows.map((r) => this.listItem(r, live.get(r.id) ?? null));
    if (!query.search) {
      // Running sessions with no transcript yet.
      const known = new Set(rows.map((r) => r.id));
      for (const l of live.values()) {
        if (!known.has(l.sessionId)) items.push(this.listItem(placeholderRow(l.sessionId, l.cwd, l.name ?? '(new session)'), l));
      }
    }
    const rank = (s: SessionListItem) => (s.status === 'waiting' ? 3 : s.attached ? 2 : s.live ? 1 : 0);
    return items.sort((a, b) => rank(b) - rank(a) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  }

  private listItem(row: SessionRow, live: LiveSession | null): SessionListItem {
    const ch = this.channels.get(row.id);
    const status = ch?.alive ? ch.state.status : live ? (live.status === 'busy' ? 'busy' : live.status === 'waiting' ? 'waiting' : 'idle') : null;
    return { ...row, live, background: live?.kind === 'bg', attached: !!ch?.attached, status };
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

  /** Starts showing a session. A background session is attached right away, so it can be driven. */
  openSession(sessionId: string): Result<SessionSnapshot> {
    let ch = this.channels.get(sessionId);
    if (!ch) {
      const row = getSession(this.d.db, sessionId);
      const live = this.d.loadLive().find((l) => l.sessionId === sessionId) ?? null;
      if (!row && !live) return { ok: false, error: 'Unknown session.' };
      const info: ChannelInfo = { cwd: row?.cwd ?? live?.cwd ?? null, title: row?.title ?? live?.name ?? '(new session)', mode: 'history' };
      if (live?.kind === 'bg' && live.jobId) Object.assign(info, { mode: 'background', jobId: live.jobId });
      else if (live) Object.assign(info, { mode: 'mirror', mirrorPid: live.pid });
      ch = this.channel(sessionId, info);
    }
    if (ch.state.mode === 'background') ch.attach();
    return { ok: true, value: ch.snapshot() };
  }

  /** The window stopped showing a session. Attached sessions stay attached. */
  closeSessionView(sessionId: string): void {
    const ch = this.channels.get(sessionId);
    if (ch && !ch.attached) this.dropChannel(sessionId);
  }

  async newSession(req: NewSessionRequest): Promise<Result<string>> {
    if (!existsSync(req.cwd)) return { ok: false, error: `Folder not found: ${req.cwd}` };
    const prompt = req.prompt?.trim();
    const args: string[] = [];
    if (req.model) args.push('--model', req.model);
    if (req.permissionMode && req.permissionMode !== 'default') args.push('--permission-mode', req.permissionMode);
    if (req.worktree) args.push('--worktree');
    if (prompt) args.push(prompt);
    let entry;
    try {
      entry = await startBackground(this.channelDeps, req.cwd, args);
    } catch (err) {
      return { ok: false, error: `Could not start claude: ${(err as Error).message}` };
    }
    const ch = this.channel(entry.sessionId, {
      cwd: req.cwd,
      title: prompt ? prompt.split('\n')[0]!.slice(0, 80) : `New session · ${basename(req.cwd)}`,
      mode: 'history',
      sentFromApp: prompt ? [prompt] : [],
    });
    ch.useBackground(entry);
    ch.attach();
    this.d.onChanged?.();
    return { ok: true, value: entry.sessionId };
  }

  async send(sessionId: string, text: string): Promise<Result> {
    if (!text.trim()) return { ok: false, error: 'Nothing to send.' };
    const opened = this.openSession(sessionId);
    if (!opened.ok) return opened;
    const ch = this.channels.get(sessionId)!;
    if (ch.state.mode === 'mirror')
      return {
        ok: false,
        error:
          'This session runs in a plain terminal, which only that terminal can type into. Start sessions with `claude --bg` (or from Companion) to drive them from both places.',
      };
    if (ch.state.mode === 'history') {
      const row = getSession(this.d.db, sessionId);
      if (row?.transcriptGone) return { ok: false, error: 'Claude Code deleted this transcript, so it can no longer be continued.' };
      if (!ch.state.cwd || !existsSync(ch.state.cwd)) return { ok: false, error: `Project folder not found: ${ch.state.cwd ?? 'unknown'}` };
      try {
        ch.useBackground(await startBackground(this.channelDeps, ch.state.cwd, ['--resume', sessionId]));
      } catch (err) {
        return { ok: false, error: `Could not continue the session: ${(err as Error).message}` };
      }
      this.d.onChanged?.();
    }
    ch.attach();
    ch.send(text);
    return ok;
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

  async stop(sessionId: string): Promise<void> {
    const jobId = this.channels.get(sessionId)?.state.jobId;
    if (jobId) await stopBackground(this.channelDeps, jobId);
  }

  async openInTerminal(sessionId: string): Promise<Result> {
    const ch = this.channels.get(sessionId);
    if (!ch?.state.jobId) return { ok: false, error: 'Only running sessions can be opened in a terminal. Send a message to start it.' };
    return openInTerminalApp(`claude attach ${ch.state.jobId}`, ch.state.cwd ?? process.cwd());
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

  /** Detaches from everything. Background sessions keep running without Companion. */
  disposeAll(): void {
    for (const id of [...this.channels.keys()]) this.dropChannel(id);
  }

  private channel(sessionId: string, info: ChannelInfo): SessionChannel {
    const ch = new SessionChannel(sessionId, this.channelDeps, info);
    ch.on('items', (items: ConversationItem[]) => this.d.onItems?.(sessionId, items));
    ch.on('state', (state: SessionState) => this.d.onState?.(state));
    ch.on('data', (data: string, end: number) => this.d.onData?.(sessionId, data, end));
    ch.on('sent', (itemId: string) => this.d.onSent?.(sessionId, itemId));
    ch.on('status', () => this.d.onChanged?.());
    ch.on('ended', () => {
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
