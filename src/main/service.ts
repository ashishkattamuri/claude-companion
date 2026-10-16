import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { ConversationItem } from '../adapter/conversation.js';
import type { LlmClient } from '../analyze/llm.js';
import { notesBehind, notesPath, readNotes, recentExchanges, updateNotes } from '../analyze/notes.js';
import { getRecap, recapDay } from '../analyze/recap.js';
import { analysisNeeded, currentStatus, runJobs } from '../analyze/runner.js';
import type { Config } from '../config.js';
import type { LiveSession } from '../ingest/live.js';
import { scan } from '../ingest/scanner.js';
import type { DB } from '../store/db.js';
import { getSession, listProjects, listSessions, type SessionRow } from '../store/queries.js';
import type { SocketRequest, SocketResponse } from '../mcp/protocol.js';
import type {
  NewSessionRequest,
  RecapView,
  Result,
  SessionExtras,
  SessionListItem,
  SessionSnapshot,
  SessionState,
} from '../shared/api.js';
import { startBackground, stopBackground } from './background.js';
import { branchContext } from './branch.js';
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
  /** Show this session in the window, optionally with a message ready in the composer. */
  onNavigate?: (sessionId: string, draft?: string) => void;
  /** How to run Companion's MCP server inside the sessions it starts (gives Claude the new-chat tool). */
  mcp?: { command: string; args: string[]; env: Record<string, string> } | null;
  /** Session notes (one small model call after a turn ends); off in tests that make no model calls. */
  notes?: boolean;
  /** Wait this long after a turn ends before updating the session's notes. */
  notesDelayMs?: number;
}

const ok: Result = { ok: true, value: undefined };
const NEW_CHAT_TOOL = 'mcp__companion__start_new_chat';
/** `claude mcp add` name for the user-scope registration. */
const MCP_NAME = 'companion';

/**
 * Everything the window can ask for, independent of Electron. The main process wires these
 * methods to IPC. One SessionChannel per session the window has open or has attached to.
 */
export class CompanionService {
  private channels = new Map<string, SessionChannel>();
  private analyzing: Promise<void> | null = null;
  private notesTimers = new Map<string, NodeJS.Timeout>();
  private notesRunning = new Map<string, Promise<void>>();
  private mcpConfigPath: string | null = null;
  /** Restarts in progress, by the session being restarted; resolves to the restarted copy's id. */
  private restarts = new Map<string, Promise<Result<string>>>();
  /** Sessions whose Companion tools have connected (their MCP server said hello). */
  private toolsUp = new Set<string>();
  private toolsEverywhere: boolean | null = null;
  private checkingTools = false;

  constructor(private d: ServiceDeps) {
    if (d.mcp) {
      this.mcpConfigPath = join(dirname(d.cfg.dbPath), 'mcp.json');
      mkdirSync(dirname(this.mcpConfigPath), { recursive: true });
      writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: { companion: d.mcp } }, null, 2));
    }
  }

  /** Flags for every session Companion starts: its MCP server, with the new-chat tool pre-approved. */
  private launchArgs(): string[] {
    return this.mcpConfigPath ? ['--mcp-config', this.mcpConfigPath, '--allowedTools', NEW_CHAT_TOOL] : [];
  }

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
        if (known.has(l.sessionId)) continue;
        const title = this.linkTitle(l.sessionId) ?? this.channels.get(l.sessionId)?.state.title ?? l.name ?? '(new session)';
        items.push(this.listItem(placeholderRow(l.sessionId, l.cwd, title), l));
      }
    }
    // A chat restarted as a copy is superseded by the copy; list only the copy.
    const superseded = new Set(
      (this.d.db.prepare(`SELECT parent_id FROM session_links WHERE kind = 'restart'`).all() as { parent_id: string }[]).map((r) => r.parent_id),
    );
    // Chats opened from another one, so the sidebar can nest them under it.
    const parents = new Map(
      (this.d.db.prepare(`SELECT child_id, parent_id FROM session_links WHERE kind = 'branch'`).all() as { child_id: string; parent_id: string }[]).map(
        (r) => [r.child_id, r.parent_id],
      ),
    );
    for (const s of items) s.parentId = parents.get(s.id) ?? null;
    const rank = (s: SessionListItem) => (s.status === 'waiting' ? 3 : s.attached ? 2 : s.live ? 1 : 0);
    return items.filter((s) => !superseded.has(s.id) || s.live).sort((a, b) => rank(b) - rank(a) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  }

  private listItem(row: SessionRow, live: LiveSession | null): SessionListItem {
    const ch = this.channels.get(row.id);
    const status = ch?.alive ? ch.state.status : live ? (live.status === 'busy' ? 'busy' : live.status === 'waiting' ? 'waiting' : 'idle') : null;
    return { ...row, live, background: live?.kind === 'bg', attached: !!ch?.attached, status, parentId: null };
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
    const args: string[] = this.launchArgs();
    if (req.model) args.push('--model', req.model);
    if (req.permissionMode && req.permissionMode !== 'default') args.push('--permission-mode', req.permissionMode);
    if (req.worktree) args.push('--worktree');
    // `--` ends the options: --allowedTools takes several values and --worktree an optional one,
    // so a prompt right after them would be swallowed as a tool or worktree name.
    if (prompt) args.push('--', prompt);
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
    this.awaitTools(ch);
    ch.attach();
    this.d.onChanged?.();
    return { ok: true, value: entry.sessionId };
  }

  async send(sessionId: string, text: string): Promise<Result> {
    if (!text.trim()) return { ok: false, error: 'Nothing to send.' };
    // Typed while the chat is restarting: it belongs to the restarted copy.
    const restarting = this.restarts.get(sessionId);
    if (restarting) {
      const r = await restarting;
      if (r.ok && r.value !== sessionId) return this.send(r.value, text);
    }
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
      if (ch.state.facts.newChatTool || this.toolsEverywhere) this.awaitTools(ch);
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
    for (const t of this.notesTimers.values()) clearTimeout(t);
    for (const id of [...this.channels.keys()]) this.dropChannel(id);
  }

  // ── Opening new chats from a session ─────────────────────────────────────────────────────────

  /** Requests from Companion's MCP server inside a session (Claude calling the new-chat tool). */
  async handleSocket(req: SocketRequest): Promise<SocketResponse> {
    if (req.method === 'hello') {
      if (req.params.sessionId) {
        this.toolsUp.add(req.params.sessionId);
        this.channels.get(req.params.sessionId)?.toolsReady();
      }
      return { ok: true, message: 'hello' };
    }
    if (req.method !== 'new_chat') return { ok: false, error: 'Unknown request.' };
    const parentId = req.params.sessionId;
    if (!parentId) return { ok: false, error: 'Could not tell which chat the request came from.' };
    const r = await this.branch(parentId, { kind: 'branch', title: req.params.title, prompt: req.params.prompt });
    return r.ok
      ? {
          ok: true,
          message: `Opened a new chat "${req.params.title}" in Companion, started it on your opening message, and switched the user to it. Nothing else to do here; just tell the user it's open.`,
        }
      : { ok: false, error: r.error };
  }

  /**
   * Opens a fresh chat from `parentId`: a new background session in the same folder, given the
   * parent's notes (plus any exchanges the notes don't cover yet) as hidden background context.
   * The new chat starts working on `prompt` right away, and the window switches to it.
   */
  async branch(parentId: string, opts: { kind: 'branch' | 'handoff'; title: string; prompt: string }): Promise<Result<string>> {
    this.refresh();
    const parent = getSession(this.d.db, parentId);
    const cwd = parent?.cwd ?? this.channels.get(parentId)?.state.cwd;
    if (!cwd || !existsSync(cwd)) return { ok: false, error: 'The original chat\'s project folder was not found.' };
    const context = branchContext({
      parentTitle: parent?.title ?? 'earlier chat',
      parentId,
      kind: opts.kind,
      notes: readNotes(this.d.db, parentId)?.text ?? null,
      recent: recentExchanges(this.d.db, parentId),
      pins: this.pins(parentId),
    });
    // Same model as the chat it came from.
    const model = this.channels.get(parentId)?.state.facts.model;
    let entry;
    try {
      entry = await startBackground(this.channelDeps, cwd, [
        ...this.launchArgs(),
        ...(model ? ['--model', model] : []),
        // Keeps the background context across resumes of the new chat.
        '--system-prompt-snapshot',
        'on',
        '--append-system-prompt',
        context,
        // The new chat starts on its opening message right away.
        '--',
        opts.prompt,
      ]);
    } catch (err) {
      return { ok: false, error: `Could not start the new chat: ${(err as Error).message}` };
    }
    this.d.db
      .prepare(`INSERT OR REPLACE INTO session_links(child_id, parent_id, title, kind, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.sessionId, parentId, opts.title, opts.kind, new Date().toISOString());
    for (const pin of this.pins(parentId)) this.pinFile(entry.sessionId, pin);
    const ch = this.channel(entry.sessionId, { cwd, title: opts.title, mode: 'history', sentFromApp: [opts.prompt] });
    ch.useBackground(entry);
    this.awaitTools(ch);
    ch.attach();
    this.d.onChanged?.();
    this.d.onNavigate?.(entry.sessionId);
    return { ok: true, value: entry.sessionId };
  }

  /** A fresh session that picks up where this one is, without its long context. */
  handOff(sessionId: string): Promise<Result<string>> {
    const title = getSession(this.d.db, sessionId)?.title ?? this.channels.get(sessionId)?.state.title ?? 'session';
    return this.branch(sessionId, {
      kind: 'handoff',
      title: `Continued: ${title}`.slice(0, 80),
      prompt: "Let's pick up where we left off. What's the next step?",
    });
  }

  // ── Making the new-chat tool available ───────────────────────────────────────────────────────

  /**
   * Restarts a chat so it has Companion's tools. Claude Code keeps a background session's original
   * options on resume, so resuming with our flags starts a copy of the conversation (full history)
   * that has them. The window switches to the copy; the old one is listed no more.
   */
  restartWithTools(sessionId: string): Promise<Result<string>> {
    const running = this.restarts.get(sessionId);
    if (running) return running;
    const p = this.doRestart(sessionId).finally(() => this.restarts.delete(sessionId));
    this.restarts.set(sessionId, p);
    return p;
  }

  private async doRestart(sessionId: string): Promise<Result<string>> {
    const ch = this.channels.get(sessionId);
    const cwd = this.cwdOf(sessionId);
    if (ch?.state.mode === 'mirror') return { ok: false, error: 'This chat runs in another terminal; restart it there.' };
    if (!cwd || !existsSync(cwd)) return { ok: false, error: 'The project folder was not found.' };
    if (ch?.state.jobId) await stopBackground(this.channelDeps, ch.state.jobId);
    let entry;
    try {
      entry = await startBackground(this.channelDeps, cwd, ['--resume', sessionId, ...this.launchArgs()]);
    } catch (err) {
      return { ok: false, error: `Could not restart the chat: ${(err as Error).message}` };
    }
    if (entry.sessionId === sessionId) {
      ch?.useBackground(entry);
      if (ch) this.awaitTools(ch);
      ch?.attach();
      this.d.onChanged?.();
      return { ok: true, value: sessionId };
    }
    const title = getSession(this.d.db, sessionId)?.title ?? ch?.state.title ?? 'Chat';
    this.d.db
      .prepare(`INSERT OR REPLACE INTO session_links(child_id, parent_id, title, kind, created_at) VALUES (?, ?, ?, 'restart', ?)`)
      .run(entry.sessionId, sessionId, title, new Date().toISOString());
    for (const pin of this.pins(sessionId)) this.pinFile(entry.sessionId, pin);
    const notes = readNotes(this.d.db, sessionId);
    if (notes) {
      const path = notesPath(this.d.cfg, entry.sessionId);
      copyFileSync(notes.path, path);
      this.d.db
        .prepare(`INSERT OR REPLACE INTO session_notes(session_id, covers_until, path, model, updated_at) VALUES (?, ?, ?, NULL, ?)`)
        .run(entry.sessionId, notes.coversUntil, path, notes.updatedAt);
    }
    const copy = this.channel(entry.sessionId, { cwd, title, mode: 'history' });
    copy.useBackground(entry);
    this.awaitTools(copy);
    copy.attach();
    this.closeSessionView(sessionId);
    this.d.onChanged?.();
    this.d.onNavigate?.(entry.sessionId);
    return { ok: true, value: entry.sessionId };
  }

  /** Hold the session's first messages until its tools connect, unless they already have. */
  private awaitTools(ch: SessionChannel): void {
    if (!this.toolsUp.has(ch.sessionId)) ch.expectTools();
  }

  /**
   * Whether the new-chat tool is registered for all Claude sessions (`claude mcp add --scope user`).
   * `claude mcp get` takes a moment (it connects to the server), so it runs in the background and
   * the answer is cached; until then this reports false.
   */
  toolsInstalledEverywhere(): boolean {
    if (this.toolsEverywhere === null && !this.checkingTools) {
      this.checkingTools = true;
      execFile(this.channelDeps.claudeBin, ['mcp', 'get', MCP_NAME], { env: this.d.env(), timeout: 20_000 }, (err) => {
        this.checkingTools = false;
        this.toolsEverywhere = !err;
        this.d.onChanged?.();
      });
    }
    return this.toolsEverywhere ?? false;
  }

  /** Registers the new-chat tool for every Claude session, including ones started in a terminal. */
  installToolsEverywhere(): Result {
    if (!this.d.mcp) return { ok: false, error: 'Not available in this build.' };
    const env = Object.entries(this.d.mcp.env)
      .filter(([k]) => k === 'ELECTRON_RUN_AS_NODE')
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = spawnSync(
      this.channelDeps.claudeBin,
      ['mcp', 'add', '--scope', 'user', MCP_NAME, ...env, '--', this.d.mcp.command, ...this.d.mcp.args],
      { env: this.d.env(), encoding: 'utf8', timeout: 15_000 },
    );
    this.toolsEverywhere = null;
    if (r.status !== 0) return { ok: false, error: `claude mcp add failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}` };
    this.d.onChanged?.();
    return ok;
  }

  // ── Context tools ────────────────────────────────────────────────────────────────────────────

  /** Runs Claude Code's /compact, keeping your pinned files and any focus you give. */
  compact(sessionId: string, focus: string): Promise<Result> {
    const pins = this.pins(sessionId).map((p) => this.display(sessionId, p));
    const instructions = [focus.trim(), pins.length ? `Keep full details about these pinned files: ${pins.join(', ')}.` : '']
      .filter(Boolean)
      .join(' ');
    return this.send(sessionId, `/compact${instructions ? ` ${instructions}` : ''}`);
  }

  /** Asks Claude to read the pinned files again, e.g. after compacting. */
  reloadPins(sessionId: string): Promise<Result> {
    const pins = this.pins(sessionId).map((p) => `@${this.display(sessionId, p)}`);
    if (!pins.length) return Promise.resolve({ ok: false, error: 'No pinned files.' });
    return this.send(sessionId, `Please re-read these pinned files so their details are fresh: ${pins.join(' ')}`);
  }

  pins(sessionId: string): string[] {
    return (
      this.d.db.prepare(`SELECT path FROM session_pins WHERE session_id = ? ORDER BY pinned_at`).all(sessionId) as { path: string }[]
    ).map((r) => r.path);
  }

  pinFile(sessionId: string, path: string): void {
    const cwd = getSession(this.d.db, sessionId)?.cwd ?? this.channels.get(sessionId)?.state.cwd ?? '';
    const abs = real(isAbsolute(path) || !cwd ? path : join(cwd, path));
    this.d.db
      .prepare(`INSERT OR IGNORE INTO session_pins(session_id, path, pinned_at) VALUES (?, ?, ?)`)
      .run(sessionId, abs, new Date().toISOString());
    this.d.onChanged?.();
  }

  unpinFile(sessionId: string, path: string): void {
    this.d.db.prepare(`DELETE FROM session_pins WHERE session_id = ? AND path = ?`).run(sessionId, path);
    this.d.onChanged?.();
  }

  extras(sessionId: string): SessionExtras {
    const notes = readNotes(this.d.db, sessionId);
    const parent = this.d.db
      .prepare(
        `SELECT l.parent_id AS id, COALESCE(s.title, s.name, l.title) AS title, l.kind FROM session_links l
         LEFT JOIN sessions s ON s.id = l.parent_id WHERE l.child_id = ?`,
      )
      .get(sessionId) as { id: string; title: string; kind: string } | undefined;
    const children = this.d.db
      .prepare(`SELECT child_id AS id, title, kind FROM session_links WHERE parent_id = ? ORDER BY created_at`)
      .all(sessionId) as { id: string; title: string; kind: string }[];
    return {
      toolsEverywhere: this.toolsInstalledEverywhere(),
      notes: notes ? { path: notes.path, updatedAt: notes.updatedAt, behind: notesBehind(this.d.db, sessionId), preview: notes.text.slice(0, 1200) } : null,
      notesUpdating: this.notesRunning.has(sessionId),
      pins: this.pins(sessionId).map((path) => ({ path, label: this.display(sessionId, path) })),
      parent: parent ?? null,
      children,
    };
  }

  private linkTitle(sessionId: string): string | null {
    return (this.d.db.prepare(`SELECT title FROM session_links WHERE child_id = ?`).get(sessionId) as { title: string } | undefined)?.title ?? null;
  }

  cwdOf(sessionId: string): string | null {
    return getSession(this.d.db, sessionId)?.cwd ?? this.channels.get(sessionId)?.state.cwd ?? null;
  }

  notesPath(sessionId: string): string | null {
    return readNotes(this.d.db, sessionId)?.path ?? null;
  }

  /** Updates the notes now (e.g. from the "Update" button). */
  refreshNotes(sessionId: string): Promise<void> {
    return this.runNotes(sessionId);
  }

  /** A path as Claude sees it from the session's folder: relative when it's inside the project. */
  private display(sessionId: string, path: string): string {
    const raw = getSession(this.d.db, sessionId)?.cwd ?? this.channels.get(sessionId)?.state.cwd;
    const cwd = raw ? real(raw) : null;
    return cwd && path.startsWith(`${cwd}/`) ? relative(cwd, path) : path;
  }

  /** Notes are updated once a turn has ended and the session has been quiet for a moment. */
  private scheduleNotes(sessionId: string, delayMs = this.d.notesDelayMs ?? 45_000): void {
    if (this.d.notes === false) return;
    clearTimeout(this.notesTimers.get(sessionId));
    this.notesTimers.set(
      sessionId,
      setTimeout(() => {
        this.notesTimers.delete(sessionId);
        const busy = this.channels.get(sessionId)?.state.status === 'busy';
        if (busy) return; // another turn started; its end reschedules
        void this.runNotes(sessionId);
      }, delayMs),
    );
  }

  private runNotes(sessionId: string): Promise<void> {
    const running = this.notesRunning.get(sessionId);
    if (running) return running;
    const p = (async () => {
      this.d.onChanged?.();
      this.refresh();
      await updateNotes(this.d.db, this.d.cfg, this.d.llm, sessionId);
    })()
      .catch(() => undefined) // a failed update is retried after the next turn
      .finally(() => {
        this.notesRunning.delete(sessionId);
        this.d.onChanged?.();
      });
    this.notesRunning.set(sessionId, p);
    return p;
  }

  private channel(sessionId: string, info: ChannelInfo): SessionChannel {
    const ch = new SessionChannel(sessionId, this.channelDeps, info);
    ch.on('items', (items: ConversationItem[]) => this.d.onItems?.(sessionId, items));
    ch.on('state', (state: SessionState) => this.d.onState?.(state));
    ch.on('data', (data: string, end: number) => this.d.onData?.(sessionId, data, end));
    ch.on('sent', (itemId: string) => this.d.onSent?.(sessionId, itemId));
    ch.on('status', () => this.d.onChanged?.());
    ch.on('turnEnded', () => this.scheduleNotes(sessionId));
    ch.on('ended', () => {
      this.scheduleNotes(sessionId, 0);
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

/** Resolves symlinks (e.g. macOS /var → /private/var) so paths from different sources compare equal. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
