import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { ConversationItem } from '../adapter/conversation.js';
import type { LlmClient } from '../analyze/llm.js';
import { notesBehind, notesPath, readNotes, recentExchanges, updateNotes } from '../analyze/notes.js';
import { getRecap, recapDay, removeSessionsFromRecaps } from '../analyze/recap.js';
import { analysisNeeded, currentStatus, runJobs } from '../analyze/runner.js';
import type { Config } from '../config.js';
import {
  checkServer,
  dismissGithubOffer,
  forgetServer,
  getRecapSource,
  githubOffer,
  listServers,
  setServerEnabled,
  type ServerView,
} from '../connectors/index.js';
import {
  PluginCli,
  type ActionResult,
  type MarketplaceAction,
  type PluginAction,
  type PluginCatalog,
  type PluginConfig,
} from '../connectors/plugins.js';
import { addClaudeServer, removeClaudeServer, type ServerConfig } from '../connectors/servers.js';
import type { LiveSession } from '../ingest/live.js';
import { listTranscripts, scan } from '../ingest/scanner.js';
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
import { findBackground, startBackground, stopBackground } from './background.js';
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
  /** Chats being continued in the background, so messages sent meanwhile share the one resume. */
  private resumes = new Map<string, Promise<Result>>();
  /** Sessions whose Companion tools have connected (their MCP server said hello). */
  private toolsUp = new Set<string>();
  private toolsEverywhere: boolean | null = null;
  private checkingTools = false;
  private plugins: PluginCli;

  constructor(private d: ServiceDeps) {
    this.plugins = new PluginCli(d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude', d.env);
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
      const deleted = this.idSet(`SELECT session_id AS id FROM deleted_sessions`);
      for (const l of live.values()) {
        if (known.has(l.sessionId) || deleted.has(l.sessionId)) continue;
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
    const hidden = this.idSet(`SELECT session_id AS id FROM hidden_sessions`);
    for (const s of items) {
      s.parentId = parents.get(s.id) ?? null;
      s.hidden = hidden.has(s.id);
    }
    const rank = (s: SessionListItem) => (s.status === 'waiting' ? 3 : s.attached ? 2 : s.live ? 1 : 0);
    return items.filter((s) => !superseded.has(s.id) || s.live).sort((a, b) => rank(b) - rank(a) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  }

  private listItem(row: SessionRow, live: LiveSession | null): SessionListItem {
    const ch = this.channels.get(row.id);
    const status = ch?.alive ? ch.state.status : live ? (live.status === 'busy' ? 'busy' : live.status === 'waiting' ? 'waiting' : 'idle') : null;
    return { ...row, live, background: live?.kind === 'bg', attached: !!ch?.attached, status, parentId: null, hidden: false };
  }

  private idSet(sql: string, ...params: unknown[]): Set<string> {
    return new Set((this.d.db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id));
  }

  // ── Cleaning up the sidebar ──────────────────────────────────────────────────────────────────

  /** Hides chats along with the chats opened from them (they're nested under them), or shows them again. */
  setHidden(sessionIds: string[], hidden: boolean): void {
    const ids = sessionIds.flatMap((id) => [id, ...this.descendants(id)]);
    const now = new Date().toISOString();
    const stmt = hidden
      ? this.d.db.prepare(`INSERT OR IGNORE INTO hidden_sessions(session_id, hidden_at) VALUES (?, ?)`)
      : this.d.db.prepare(`DELETE FROM hidden_sessions WHERE session_id = ?`);
    this.d.db.transaction(() => {
      for (const id of ids) hidden ? stmt.run(id, now) : stmt.run(id);
    })();
    this.d.onChanged?.();
  }

  /** Chats opened from this one, and from those, and so on. */
  private descendants(sessionId: string): string[] {
    const out: string[] = [];
    const next = this.d.db.prepare(`SELECT child_id AS id FROM session_links WHERE parent_id = ? AND kind = 'branch'`);
    const walk = (id: string) => {
      for (const { id: child } of next.all(id) as { id: string }[]) {
        if (out.includes(child) || child === sessionId) continue;
        out.push(child);
        walk(child);
      }
    };
    walk(sessionId);
    return out;
  }

  /** Deletes several chats; ones that can't be deleted yet are skipped and named in the error. */
  async deleteSessions(sessionIds: string[]): Promise<Result> {
    const failed: string[] = [];
    for (const id of sessionIds) {
      const r = await this.deleteSession(id);
      if (!r.ok) failed.push(sessionIds.length === 1 ? r.error : `${getSession(this.d.db, id)?.title ?? id}: ${r.error}`);
    }
    if (!failed.length) return ok;
    return { ok: false, error: sessionIds.length === 1 ? failed[0]! : `Not deleted (${failed.length}): ${failed.join(' · ')}` };
  }

  /**
   * Removes a chat from Companion and deletes its transcript under ~/.claude/projects. A chat that
   * runs in the background is stopped first; one in a plain terminal has to be quit there. If the
   * chat was restarted from an older copy, that copy (listed no more) goes too. Chats opened from
   * it stay, and move up to the top level.
   */
  async deleteSession(sessionId: string): Promise<Result> {
    const ids = [sessionId, ...this.restartedFrom(sessionId)];
    if (ids.some((id) => !/^[\w-]+$/.test(id))) return { ok: false, error: 'Unexpected session id.' };
    const live = this.d.loadLive();
    for (const id of ids) {
      const l = live.find((x) => x.sessionId === id);
      if (this.channels.get(id)?.state.mode === 'mirror' || (l && l.kind !== 'bg'))
        return { ok: false, error: 'This chat is running in another terminal. Quit it there, then delete it.' };
    }
    for (const id of ids) {
      const jobId = this.channels.get(id)?.state.jobId ?? live.find((x) => x.sessionId === id)?.jobId;
      if (jobId) await stopBackground(this.channelDeps, jobId);
      this.dropChannel(id);
      clearTimeout(this.notesTimers.get(id));
      this.notesTimers.delete(id);
    }

    for (const id of ids) {
      const paths = new Set(listTranscripts(this.d.cfg.projectsDir).main.filter((p) => basename(p, '.jsonl') === id));
      const source = this.d.db.prepare(`SELECT source_path AS path FROM sessions WHERE id = ?`).get(id) as { path: string | null } | undefined;
      if (source?.path) paths.add(source.path);
      for (const p of paths) {
        rmSync(p, { force: true });
        // Subagent transcripts and tool output Claude Code keeps beside the transcript.
        rmSync(join(dirname(p), id), { recursive: true, force: true });
      }
      const notes = readNotes(this.d.db, id);
      if (notes) rmSync(notes.path, { force: true });
    }

    const now = new Date().toISOString();
    this.d.db.transaction(() => {
      for (const id of ids) {
        this.d.db.prepare(`INSERT OR REPLACE INTO deleted_sessions(session_id, deleted_at) VALUES (?, ?)`).run(id, now);
        // Messages, summaries and notes go with the session row.
        this.d.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM ingest_files WHERE session_id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM session_links WHERE child_id = ? OR parent_id = ?`).run(id, id);
        this.d.db.prepare(`DELETE FROM session_pins WHERE session_id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM hidden_sessions WHERE session_id = ?`).run(id);
      }
      // Its action items and summaries go from the recaps too.
      removeSessionsFromRecaps(this.d.db, ids);
    })();
    this.d.onChanged?.();
    return ok;
  }

  /** The older copies a chat was restarted from (see restartWithTools). */
  private restartedFrom(sessionId: string): string[] {
    const out: string[] = [];
    const prev = this.d.db.prepare(`SELECT parent_id AS id FROM session_links WHERE child_id = ? AND kind = 'restart'`);
    for (let id = sessionId; ; ) {
      const row = prev.get(id) as { id: string } | undefined;
      if (!row || row.id === sessionId || out.includes(row.id)) return out;
      out.push(row.id);
      id = row.id;
    }
  }

  listProjects() {
    return listProjects(this.d.db).filter((p) => existsSync(p.cwd));
  }

  getRecap(): RecapView {
    const { day } = recapDay(this.d.cfg);
    const recent = Date.now() - 14 * 86_400_000;
    const cwds = this.listProjects().filter((p) => p.lastTs && Date.parse(p.lastTs) > recent).map((p) => p.cwd);
    return {
      recap: getRecap(this.d.db, day),
      status: currentStatus(this.d.db, this.d.cfg),
      source: getRecapSource(this.d.db, day),
      githubOffer: githubOffer(this.d.db, this.d.cfg, cwds),
    };
  }

  /** Claude Code's plugin catalog and marketplaces, as `/plugin` shows them. */
  async listPlugins(): Promise<Result<PluginCatalog>> {
    try {
      return { ok: true, value: await this.plugins.catalog() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Installs, removes, turns on or off, or updates a plugin, for every Claude Code session. */
  async pluginAction(action: PluginAction, id: string, acceptCommand?: string): Promise<Result<ActionResult>> {
    return this.cliResult(() => this.plugins.plugin(action, id, acceptCommand));
  }

  async marketplaceAction(action: MarketplaceAction, target?: string): Promise<Result<ActionResult>> {
    return this.cliResult(() => this.plugins.marketplace(action, target));
  }

  async pluginDetails(id: string): Promise<Result<string>> {
    try {
      return { ok: true, value: await this.plugins.details(id) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async pluginConfig(id: string): Promise<Result<PluginConfig>> {
    try {
      return { ok: true, value: await this.plugins.config(id) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async savePluginConfig(id: string, values: Record<string, string>): Promise<Result<string[]>> {
    try {
      return { ok: true, value: (await this.plugins.saveConfig(id, values)).saved };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** A `--json` action's result line; "failed" comes back as an error, a command to confirm as is. */
  private async cliResult(fn: () => Promise<ActionResult>): Promise<Result<ActionResult>> {
    try {
      const r = await fn();
      this.d.onChanged?.();
      if (r.outcome === 'ok' || r.shownCommand || r.failureCode === 'already_in_goal_state') return { ok: true, value: r };
      return { ok: false, error: r.message ?? `Failed (${r.failureCode ?? r.outcome})` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** MCP servers from Claude Code's settings and from enabled plugins. */
  listServers(): ServerView[] {
    return listServers(this.d.db, this.d.cfg);
  }

  async checkConnector(name: string): Promise<ServerView | null> {
    const view = await checkServer(this.d.db, this.d.cfg, name);
    this.d.onChanged?.();
    return view;
  }

  async setConnectorEnabled(name: string, enabled: boolean): Promise<ServerView | null> {
    // One GitHub source at a time.
    if (enabled) {
      const kind = listServers(this.d.db, this.d.cfg).find((s) => s.name === name)?.kind;
      for (const s of listServers(this.d.db, this.d.cfg))
        if (kind && s.kind === kind && s.name !== name && s.enabled) setServerEnabled(this.d.db, this.d.cfg, s.name, false);
    }
    setServerEnabled(this.d.db, this.d.cfg, name, enabled);
    // Turning one on checks it straight away, so the page says whether it works.
    const view = enabled ? await checkServer(this.d.db, this.d.cfg, name) : null;
    this.d.onChanged?.();
    return view ?? listServers(this.d.db, this.d.cfg).find((s) => s.name === name) ?? null;
  }

  /** Adds an MCP server to Claude Code for every session (`claude mcp add-json --scope user`). */
  addServer(name: string, config: ServerConfig): Result {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, error: 'Use letters, numbers, dots, dashes or underscores for the name.' };
    if (listServers(this.d.db, this.d.cfg).some((s) => s.name === name)) return { ok: false, error: `There is already a server called ${name}.` };
    const err = addClaudeServer(this.channelDeps.claudeBin, this.d.env(), name, config);
    if (err) return { ok: false, error: err };
    this.d.onChanged?.();
    return ok;
  }

  removeConnector(name: string): Result {
    const err = removeClaudeServer(this.channelDeps.claudeBin, this.d.env(), name);
    if (err) return { ok: false, error: err };
    forgetServer(this.d.db, this.d.cfg, name);
    this.d.onChanged?.();
    return ok;
  }

  dismissGithubOffer(): void {
    dismissGithubOffer(this.d.db);
    this.d.onChanged?.();
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
      const resumed = await this.resume(ch);
      if (!resumed.ok) return resumed;
    }
    // Continuing a hidden chat brings it back.
    if (this.d.db.prepare(`SELECT 1 FROM hidden_sessions WHERE session_id = ?`).get(sessionId)) this.setHidden([sessionId], false);
    ch.attach();
    ch.send(text);
    return ok;
  }

  /**
   * Continues a chat that isn't running as a background session. Messages sent while that is still
   * starting wait for the same resume: a second `--resume` of a running chat would make Claude Code
   * start a new, empty session, and the window would follow that one instead of the chat.
   */
  private resume(ch: SessionChannel): Promise<Result> {
    const running = this.resumes.get(ch.sessionId);
    if (running) return running;
    const p = this.doResume(ch).finally(() => this.resumes.delete(ch.sessionId));
    this.resumes.set(ch.sessionId, p);
    return p;
  }

  private async doResume(ch: SessionChannel): Promise<Result> {
    const sessionId = ch.sessionId;
    const row = getSession(this.d.db, sessionId);
    if (row?.transcriptGone) return { ok: false, error: 'Claude Code deleted this transcript, so it can no longer be continued.' };
    if (!ch.state.cwd || !existsSync(ch.state.cwd)) return { ok: false, error: `Project folder not found: ${ch.state.cwd ?? 'unknown'}` };
    // Already running (continued from a terminal meanwhile): use it rather than starting another.
    let entry = findBackground(this.d.cfg.claudeDir, sessionId);
    if (!entry) {
      try {
        entry = await startBackground(this.channelDeps, ch.state.cwd, ['--resume', sessionId]);
      } catch (err) {
        return { ok: false, error: `Could not continue the session: ${(err as Error).message}` };
      }
      if (entry.sessionId !== sessionId) {
        // Claude Code started a new, empty session because the chat was running after all.
        await stopBackground(this.channelDeps, entry.jobId);
        entry = findBackground(this.d.cfg.claudeDir, sessionId);
        if (!entry) return { ok: false, error: 'Could not continue the session: it is already running elsewhere.' };
      }
    }
    ch.useBackground(entry);
    if (ch.state.facts.newChatTool || this.toolsEverywhere) this.awaitTools(ch);
    this.d.onChanged?.();
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
