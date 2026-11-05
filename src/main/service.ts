import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { collectChanges, type FileChange } from '../adapter/changes.js';
import type { ConversationItem } from '../adapter/conversation.js';
import { detect } from '../analyze/audit/detectors.js';
import { chunkTurns, review, reviewModel } from '../analyze/audit/review.js';
import { loadTimeline } from '../analyze/audit/timeline.js';
import { buildAuditView, type AuditView } from '../analyze/audit/view.js';
import { readEntries, searchEarlier, type EarlierChat } from '../analyze/earlier.js';
import type { LlmClient } from '../analyze/llm.js';
import { notesBehind, notesPath, readNotes, recentExchanges, updateNotes } from '../analyze/notes.js';
import { getRecap, recapDay, removeGoneSessionsFromRecaps, removeSessionsFromRecaps } from '../analyze/recap.js';
import { cachedExplanations, explainChanges } from '../analyze/review.js';
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
import type { SearchEarlierRequest, SocketRequest, SocketResponse } from '../mcp/protocol.js';
import type {
  AuditState,
  NewSessionRequest,
  RecapView,
  Result,
  ReviewView,
  SessionExtras,
  SessionListItem,
  SessionSnapshot,
  SessionState,
  SideAsk,
  SideChat,
} from '../shared/api.js';
import { findBackground, startBackground, stopBackground } from './background.js';
import { branchContext } from './branch.js';
import { ContextUsage } from './context-usage.js';
import { SessionChannel, type ChannelDeps, type ChannelInfo } from './session.js';
import { SideChats } from './side-chat.js';
import { openInTerminalApp } from './terminal-app.js';
import { findTranscript } from './transcript.js';

export interface ServiceDeps {
  db: DB;
  cfg: Config;
  llm: LlmClient;
  /** For audit reviews, which read a whole session and can take minutes; defaults to `llm`. */
  auditLlm?: LlmClient;
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
  /** A session's side chats changed. */
  onSideChanged?: (sessionId: string) => void;
  /** Show this session in the window, optionally with a message ready in the composer. */
  onNavigate?: (sessionId: string, draft?: string) => void;
  /** How to run Companion's MCP server inside the sessions it starts (gives Claude the new-chat tool). */
  mcp?: { command: string; args: string[]; env: Record<string, string> } | null;
  /** Session notes (one small model call after a turn ends); off in tests that make no model calls. */
  notes?: boolean;
  /** Wait this long after a turn ends before updating the session's notes. */
  notesDelayMs?: number;
  /** Read each session's `/context` breakdown after its turns end (runs `claude -p /context`, no model call). */
  contextUsage?: boolean;
}

const ok: Result = { ok: true, value: undefined };
/** Ghost chats: Claude Code writes no memories for them. */
const GHOST_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
/** A ghost chat this new may not be in Claude Code's registry yet, so it isn't taken for ended. */
const GHOST_GRACE_MS = 30_000;
/** How long an ended ghost chat is remembered, to delete anything Claude Code writes after it stops. */
const GHOST_LINGER_MS = 120_000;
const GHOST_NO_AUDIT = "Ghost chats aren't audited: nothing about them is kept.";
const NEW_CHAT_TOOL = 'mcp__companion__start_new_chat';
const SEARCH_EARLIER_TOOL = 'mcp__companion__search_earlier_conversation';
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
  /** Audits in progress, by session. */
  private auditing = new Map<string, Promise<Result<AuditView>>>();
  private side: SideChats;
  /** Each session's changes, kept until its transcript grows. */
  private changes = new Map<string, { key: string; files: FileChange[]; at: number }>();
  private changesRecheck = new Map<string, NodeJS.Timeout>();
  /** Review explanations for ghost chats, which keep nothing on disk. */
  private ghostExplanations = new Map<string, Map<string, string>>();
  private endingGhosts = new Map<string, Promise<void>>();
  /** Explanations being written, and why the last attempt failed, by session. */
  private explaining = new Map<string, Promise<void>>();
  private explainErrors = new Map<string, string>();
  private context: ContextUsage | null = null;

  constructor(private d: ServiceDeps) {
    this.plugins = new PluginCli(d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude', d.env);
    if (d.contextUsage)
      this.context = new ContextUsage({
        claudeBin: d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude',
        env: d.env,
        onChanged: () => d.onChanged?.(),
      });
    this.side = new SideChats({
      db: d.db,
      projectsDir: d.cfg.projectsDir,
      claudeBin: d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude',
      env: d.env,
      onChanged: (sessionId) => d.onSideChanged?.(sessionId),
    });
    if (d.mcp) {
      this.mcpConfigPath = join(dirname(d.cfg.dbPath), 'mcp.json');
      mkdirSync(dirname(this.mcpConfigPath), { recursive: true });
      writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: { companion: d.mcp } }, null, 2));
    }
    // Ghost chats that ended while Companion was closed are deleted now.
    this.sweepGhosts();
  }

  /** Flags for every session Companion starts: its MCP server, with its tools pre-approved. */
  private launchArgs(): string[] {
    return this.mcpConfigPath ? ['--mcp-config', this.mcpConfigPath, '--allowedTools', NEW_CHAT_TOOL, SEARCH_EARLIER_TOOL] : [];
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
    this.sweepGhosts();
    scan(this.d.db, this.d.cfg);
    removeGoneSessionsFromRecaps(this.d.db);
  }

  listSessions(query: { search?: string }): SessionListItem[] {
    this.sweepGhosts();
    const live = new Map(this.d.loadLive().map((l) => [l.sessionId, l]));
    const rows = listSessions(this.d.db, { search: query.search });
    const items = rows.map((r) => this.listItem(r, live.get(r.id) ?? null));
    if (!query.search) {
      // Running sessions with no transcript yet.
      const known = new Set(rows.map((r) => r.id));
      const deleted = this.idSet(`SELECT session_id AS id FROM deleted_sessions UNION SELECT id FROM side_chats`);
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
    const ghosts = this.idSet(`SELECT session_id AS id FROM ghost_sessions WHERE ended_at IS NULL`);
    const audits = new Map(
      (this.d.db.prepare(`SELECT session_id AS id, waste_share AS share, model FROM session_audits`).all() as { id: string; share: number; model: string | null }[]).map(
        (r) => [r.id, { share: r.share, reviewed: r.model !== null }],
      ),
    );
    for (const s of items) {
      s.parentId = parents.get(s.id) ?? null;
      s.hidden = hidden.has(s.id);
      s.audit = audits.get(s.id) ?? null;
      s.auditing = this.auditing.has(s.id);
      s.ghost = ghosts.has(s.id);
    }
    // A ghost chat that has ended is being deleted: it's gone from the list already.
    const ended = this.idSet(`SELECT session_id AS id FROM ghost_sessions WHERE ended_at IS NOT NULL`);
    const rank = (s: SessionListItem) => (s.status === 'waiting' ? 3 : s.attached ? 2 : s.live ? 1 : 0);
    return items.filter((s) => (!superseded.has(s.id) || s.live) && !ended.has(s.id)).sort((a, b) => rank(b) - rank(a) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  }

  private listItem(row: SessionRow, live: LiveSession | null): SessionListItem {
    const ch = this.channels.get(row.id);
    const status = ch?.alive ? ch.state.status : live ? (live.status === 'busy' ? 'busy' : live.status === 'waiting' ? 'waiting' : 'idle') : null;
    return { ...row, live, background: live?.kind === 'bg', attached: !!ch?.attached, status, parentId: null, hidden: false, audit: null, auditing: false, ghost: false };
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
    }
    this.purge(ids, { tombstone: true });
    return ok;
  }

  /**
   * Deletes everything about these chats: their transcripts (and the folders beside them), notes,
   * side chats, and every row Companion keeps about them. `tombstone` records them as deleted so a
   * transcript that comes back isn't listed again; ghost chats keep no such record.
   */
  private purge(ids: string[], { tombstone }: { tombstone: boolean }): void {
    for (const id of ids) {
      this.dropChannel(id);
      clearTimeout(this.notesTimers.get(id));
      this.notesTimers.delete(id);
      this.changes.delete(id);
      this.ghostExplanations.delete(id);
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
      this.side.deleteFor(id);
    }

    const now = new Date().toISOString();
    this.d.db.transaction(() => {
      for (const id of ids) {
        if (tombstone) this.d.db.prepare(`INSERT OR REPLACE INTO deleted_sessions(session_id, deleted_at) VALUES (?, ?)`).run(id, now);
        // Messages, summaries and notes go with the session row.
        this.d.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM ingest_files WHERE session_id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM session_links WHERE child_id = ? OR parent_id = ?`).run(id, id);
        this.d.db.prepare(`DELETE FROM session_pins WHERE session_id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM hidden_sessions WHERE session_id = ?`).run(id);
        this.d.db.prepare(`DELETE FROM session_audits WHERE session_id = ?`).run(id);
      }
      // Its action items and summaries go from the recaps too.
      removeSessionsFromRecaps(this.d.db, ids);
    })();
    this.d.onChanged?.();
  }

  // ── Ghost chats ──────────────────────────────────────────────────────────────────────────────

  /** A ghost chat: nothing about it is kept, and it's deleted when it ends. */
  isGhost(sessionId: string): boolean {
    return !!this.d.db.prepare(`SELECT 1 FROM ghost_sessions WHERE session_id = ?`).get(sessionId);
  }

  /**
   * A ghost chat ended (End, or it exited): delete it. Its files in the project are the user's work
   * and stay; everything else about it goes. The row stays a little longer, marked ended, so the
   * transcript isn't indexed if Claude Code writes a last record after stopping (see sweepGhosts).
   */
  private endGhost(sessionId: string): Promise<void> {
    const running = this.endingGhosts.get(sessionId);
    if (running) return running;
    const p = (async () => {
      this.d.db.prepare(`UPDATE ghost_sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL`).run(new Date().toISOString(), sessionId);
      const jobId = this.channels.get(sessionId)?.state.jobId ?? this.d.loadLive().find((l) => l.sessionId === sessionId && l.kind === 'bg')?.jobId;
      if (jobId) await stopBackground(this.channelDeps, jobId);
      this.purge([sessionId], { tombstone: false });
    })().finally(() => this.endingGhosts.delete(sessionId));
    this.endingGhosts.set(sessionId, p);
    return p;
  }

  /**
   * Ghost chats that ended while nobody was watching (or while Companion was closed) are deleted;
   * anything Claude Code writes after one stops is deleted too, and once nothing is left the chat
   * is forgotten altogether.
   */
  private sweepGhosts(): void {
    const rows = this.d.db.prepare(`SELECT session_id AS id, started_at AS started, ended_at AS ended FROM ghost_sessions`).all() as {
      id: string;
      started: string;
      ended: string | null;
    }[];
    if (!rows.length) return;
    const live = new Set(this.d.loadLive().map((l) => l.sessionId));
    const now = Date.now();
    for (const r of rows) {
      if (this.endingGhosts.has(r.id)) continue;
      if (!r.ended) {
        // Just started: Claude Code may not have registered it yet.
        if (live.has(r.id) || this.channels.get(r.id)?.alive || now - Date.parse(r.started) < GHOST_GRACE_MS) continue;
        void this.endGhost(r.id);
        continue;
      }
      if (this.transcriptsOf(r.id).length) this.purge([r.id], { tombstone: false });
      else if (now - Date.parse(r.ended) > GHOST_LINGER_MS) this.d.db.prepare(`DELETE FROM ghost_sessions WHERE session_id = ?`).run(r.id);
    }
  }

  private transcriptsOf(sessionId: string): string[] {
    return listTranscripts(this.d.cfg.projectsDir).main.filter((p) => basename(p, '.jsonl') === sessionId);
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

  // ── Audits ───────────────────────────────────────────────────────────────────────────────────

  private transcriptOf(sessionId: string): string | null {
    const row = this.d.db.prepare(`SELECT source_path AS path FROM sessions WHERE id = ?`).get(sessionId) as { path: string | null } | undefined;
    if (row?.path && existsSync(row.path)) return row.path;
    return findTranscript(this.d.cfg.projectsDir, sessionId);
  }

  /** Tool calls in the main conversation, as ingested: how far an audit got, and how far the session is now. */
  private toolCalls(sessionId: string): number {
    return (
      this.d.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'tool_use' AND is_sidechain = 0`).get(sessionId) as { n: number }
    ).n;
  }

  /** What an audit would read and who reviews it, for the confirmation. */
  auditEstimate(sessionId: string): Result<{ calls: number; steps: number; tokens: number; parts: number; model: string }> {
    if (this.isGhost(sessionId)) return { ok: false, error: GHOST_NO_AUDIT };
    const path = this.transcriptOf(sessionId);
    if (!path) return { ok: false, error: 'This chat has no transcript to audit.' };
    const tl = loadTimeline(path);
    if (!tl.calls.length) return { ok: false, error: 'This chat has nothing to audit yet.' };
    return {
      ok: true,
      value: {
        calls: tl.calls.length,
        steps: tl.steps.length,
        tokens: tl.calls.reduce((s, c) => s + c.prompt + c.usage.output, 0),
        parts: chunkTurns(tl).length,
        model: reviewModel(tl, this.d.cfg.models.audit),
      },
    };
  }

  getAudit(sessionId: string): AuditState {
    const row = this.d.db.prepare(`SELECT covers_steps AS covers, view_json AS json FROM session_audits WHERE session_id = ?`).get(sessionId) as
      | { covers: number; json: string }
      | undefined;
    return {
      audit: row ? (JSON.parse(row.json) as AuditView) : null,
      running: this.auditing.has(sessionId),
      newSteps: row ? Math.max(0, this.toolCalls(sessionId) - row.covers) : 0,
    };
  }

  /**
   * Audits a session for wasted steps: the detectors, then a review by a second model. If the review
   * can't run (e.g. a usage limit), the detectors' findings are kept and the reason is shown.
   */
  runAudit(sessionId: string): Promise<Result<AuditView>> {
    const running = this.auditing.get(sessionId);
    if (running) return running;
    const run = (async (): Promise<Result<AuditView>> => {
      if (this.isGhost(sessionId)) return { ok: false, error: GHOST_NO_AUDIT };
      const path = this.transcriptOf(sessionId);
      if (!path) return { ok: false, error: 'This chat has no transcript to audit.' };
      this.refresh();
      const covers = this.toolCalls(sessionId);
      const tl = loadTimeline(path);
      const report = detect(tl);
      const model = reviewModel(tl, this.d.cfg.models.audit);
      let rv = null;
      let reviewError: string | null = null;
      try {
        rv = await review(tl, report, this.d.auditLlm ?? this.d.llm, { model, transcriptPath: path, claudeDir: this.d.cfg.claudeDir });
      } catch (err) {
        reviewError = (err as Error).message;
      }
      const view = buildAuditView(tl, report, rv, { createdAt: new Date().toISOString(), reviewError });
      this.d.db
        .prepare(
          `INSERT OR REPLACE INTO session_audits(session_id, covers_steps, model, waste_share, view_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, covers, view.model, view.wasted.share, JSON.stringify(view), view.createdAt);
      return { ok: true, value: view };
    })()
      .catch((err): Result<AuditView> => ({ ok: false, error: `The audit failed: ${(err as Error).message}` }))
      .finally(() => {
        this.auditing.delete(sessionId);
        this.d.onChanged?.();
      });
    this.auditing.set(sessionId, run);
    this.d.onChanged?.();
    return run;
  }

  // ── Side chats ───────────────────────────────────────────────────────────────────────────────

  listSideChats(sessionId: string): SideChat[] {
    return this.side.list(sessionId);
  }

  /** Asks about a chat in a fork of it, on the chat's own model so its history comes from the cache. */
  askSide(sessionId: string, ask: SideAsk): Result<string> {
    this.refresh();
    const ch = this.channels.get(sessionId);
    return this.side.ask(sessionId, this.cwdOf(sessionId), ch?.state.facts.model ?? null, ask);
  }

  stopSide(chatId: string): void {
    this.side.stop(chatId);
  }

  deleteSideChat(chatId: string): void {
    this.side.delete(chatId);
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

  private manualMode: boolean | null = null;

  /** Whether the installed Claude Code has the `manual` permission mode (checked once, from `--help`). */
  private hasManualMode(): boolean {
    if (this.manualMode === null) {
      const bin = this.d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude';
      const r = spawnSync(bin, ['--help'], { env: this.d.env(), encoding: 'utf8', timeout: 10_000 });
      this.manualMode = /--permission-mode[\s\S]{0,400}"manual"/.test(`${r.stdout ?? ''}`);
    }
    return this.manualMode;
  }

  async newSession(req: NewSessionRequest): Promise<Result<string>> {
    if (!existsSync(req.cwd)) return { ok: false, error: `Folder not found: ${req.cwd}` };
    const prompt = req.prompt?.trim();
    const args: string[] = this.launchArgs();
    if (req.model) args.push('--model', req.model);
    if (req.permissionMode && req.permissionMode !== 'default') args.push('--permission-mode', req.permissionMode);
    // "Ask before edits": newer Claude Code calls it `manual` and otherwise starts in Auto mode.
    else if (this.hasManualMode()) args.push('--permission-mode', 'manual');
    if (req.worktree) args.push('--worktree');
    // Ghost mode: Claude writes no memories. Background chats run in Claude Code's daemon, so say it
    // in the session's own settings as well as in the environment of the command that starts it.
    if (req.ghost) args.push('--settings', JSON.stringify({ env: GHOST_ENV }));
    // `--` ends the options: --allowedTools takes several values and --worktree an optional one,
    // so a prompt right after them would be swallowed as a tool or worktree name.
    if (prompt) args.push('--', prompt);
    let entry;
    try {
      const deps = req.ghost ? { ...this.channelDeps, env: () => ({ ...this.channelDeps.env(), ...GHOST_ENV }) } : this.channelDeps;
      entry = await startBackground(deps, req.cwd, args);
    } catch (err) {
      return { ok: false, error: `Could not start claude: ${(err as Error).message}` };
    }
    if (req.ghost) {
      this.d.db.prepare(`INSERT OR REPLACE INTO ghost_sessions(session_id, started_at, ended_at) VALUES (?, ?, NULL)`).run(entry.sessionId, new Date().toISOString());
      // In case it was indexed while starting.
      this.d.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(entry.sessionId);
      this.d.db.prepare(`DELETE FROM ingest_files WHERE session_id = ?`).run(entry.sessionId);
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

  /** Stops a background chat. A ghost chat is deleted once stopped. */
  async stop(sessionId: string): Promise<void> {
    if (this.isGhost(sessionId)) return this.endGhost(sessionId);
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
    this.side.stopAll();
    for (const id of [...this.channels.keys()]) this.dropChannel(id);
  }

  // ── Opening new chats from a session ─────────────────────────────────────────────────────────

  /** Requests from Companion's MCP server inside a session (Claude calling one of its tools). */
  async handleSocket(req: SocketRequest): Promise<SocketResponse> {
    if (req.method === 'hello') {
      if (req.params.sessionId) {
        this.toolsUp.add(req.params.sessionId);
        this.channels.get(req.params.sessionId)?.toolsReady();
      }
      return { ok: true, message: 'hello' };
    }
    if (req.method === 'search_earlier') return this.searchEarlier(req.params);
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

  /**
   * The chats a chat was opened from, nearest first. Restarts are skipped: a restarted chat is a
   * copy of the same conversation, so the search goes on to the chat it was opened from.
   */
  earlierChats(sessionId: string): { id: string; title: string }[] {
    const up = this.d.db.prepare(
      `SELECT l.parent_id AS id, l.kind, COALESCE(s.title, s.name, 'Earlier chat') AS title FROM session_links l
       LEFT JOIN sessions s ON s.id = l.parent_id WHERE l.child_id = ?`,
    );
    const out: { id: string; title: string }[] = [];
    const seen = new Set([sessionId]);
    for (let id = sessionId; ; ) {
      const row = up.get(id) as { id: string; kind: string; title: string } | undefined;
      if (!row || seen.has(row.id)) return out;
      seen.add(row.id);
      if (row.kind !== 'restart') out.push({ id: row.id, title: row.title });
      id = row.id;
    }
  }

  /** Claude looking up a detail in the conversation its chat was opened from (and only those). */
  private searchEarlier(p: SearchEarlierRequest['params']): SocketResponse {
    if (!p.sessionId) return { ok: false, error: 'Could not tell which chat the request came from.' };
    const lineage = this.earlierChats(p.sessionId);
    if (!lineage.length) return { ok: false, error: 'This chat was not opened from another chat, so there is no earlier conversation to search.' };
    let picked = p.scope === 'lineage' ? lineage : lineage.slice(0, 1);
    if (p.chat) {
      const c = lineage.find((l) => l.id === p.chat);
      if (!c) return { ok: false, error: `Chat ${p.chat} is not one this chat was opened from.` };
      picked = [c];
    }
    const chats: EarlierChat[] = [];
    for (const c of picked) {
      const path = this.transcriptOf(c.id);
      if (!path) continue;
      const depth = lineage.indexOf(c);
      chats.push({ ...c, relation: depth === 0 ? 'parent' : `${'great-'.repeat(depth - 1)}grandparent`, entries: readEntries(path) });
    }
    if (!chats.length) return { ok: false, error: 'The earlier conversation\'s transcript was not found.' };
    try {
      return { ok: true, message: searchEarlier(chats, p) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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
    if (this.isGhost(sessionId)) return { ok: false, error: "Ghost chats can't be restarted: stopping one deletes it." };
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

  /**
   * What the session changed, file by file: each file's net diff, whether it still matches the disk,
   * and a short explanation. `explain` writes the missing explanations in the background (one small
   * model call per batch of files); the view reports them as they arrive through onChanged.
   */
  review(sessionId: string, explain = false): ReviewView {
    const files = this.sessionChanges(sessionId);
    if (explain && files.length) this.explain(sessionId, files);
    const known = cachedExplanations(this.d.db, files.map((f) => f.hash));
    for (const [hash, text] of this.ghostExplanations.get(sessionId) ?? []) known.set(hash, text);
    return {
      files: files.map((f) => ({
        path: this.display(sessionId, f.abs),
        abs: f.abs,
        isNew: f.isNew,
        added: f.added,
        removed: f.removed,
        hunks: f.hunks,
        oldLineCount: f.oldLineCount,
        explanation: known.get(f.hash) ?? null,
        disk: diskState(f),
        partial: f.before === null,
        stepIds: f.stepIds,
        stepNotes: f.stepNotes,
        hash: f.hash,
      })),
      explaining: this.explaining.has(sessionId),
      error: this.explainErrors.get(sessionId) ?? null,
    };
  }

  /** Opens a file the session changed in the default app for it. */
  reviewedFile(sessionId: string, abs: string): string | null {
    return this.sessionChanges(sessionId).some((f) => f.abs === abs) && existsSync(abs) ? abs : null;
  }

  /**
   * The session's changes, re-read when its transcript has grown. `maxStaleMs` lets a caller that asks
   * often (the rail, on every update while Claude works) reuse a recent read instead of re-reading.
   */
  private sessionChanges(sessionId: string, maxStaleMs = 0): FileChange[] {
    const hit = this.changes.get(sessionId);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < maxStaleMs) {
      // Reusing a recent read: check again once the window has passed, so the last edit still shows.
      if (!this.changesRecheck.has(sessionId))
        this.changesRecheck.set(
          sessionId,
          setTimeout(() => {
            this.changesRecheck.delete(sessionId);
            this.d.onChanged?.();
          }, maxStaleMs - age + 50),
        );
      return hit.files;
    }
    const path = /^[\w-]+$/.test(sessionId) ? findTranscript(this.d.cfg.projectsDir, sessionId) : null;
    if (!path) return [];
    const st = statSync(path);
    const key = `${path}:${st.size}:${st.mtimeMs}`;
    if (hit?.key === key) return hit.files;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const files = collectChanges(lines, readText);
    this.changes.set(sessionId, { key, files, at: Date.now() });
    return files;
  }

  private explain(sessionId: string, files: FileChange[]): void {
    if (this.explaining.has(sessionId)) return;
    const missing = new Set(files.map((f) => f.hash));
    for (const h of cachedExplanations(this.d.db, [...missing]).keys()) missing.delete(h);
    // Ghost chats keep their explanations in memory only, for as long as the chat runs.
    let memory = this.ghostExplanations.get(sessionId);
    if (!memory && this.isGhost(sessionId)) this.ghostExplanations.set(sessionId, (memory = new Map()));
    for (const h of memory?.keys() ?? []) missing.delete(h);
    if (!missing.size) return;
    this.explainErrors.delete(sessionId);
    const p = explainChanges(this.d.db, this.d.cfg, this.d.llm, files.filter((f) => missing.has(f.hash)), (abs) => this.display(sessionId, abs), { memory })
      .catch((err: Error) => void this.explainErrors.set(sessionId, err.message || 'Could not write the explanations.'))
      .finally(() => {
        this.explaining.delete(sessionId);
        this.d.onChanged?.();
      });
    this.explaining.set(sessionId, p);
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
      context: this.context?.get(sessionId, this.cwdOf(sessionId)) ?? null,
      changes: this.sessionChanges(sessionId, 2000).map((f) => ({ path: this.display(sessionId, f.abs), abs: f.abs, added: f.added, removed: f.removed })),
      ghost: this.isGhost(sessionId),
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
    if (this.d.notes === false || this.isGhost(sessionId)) return;
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
    if (this.isGhost(sessionId)) return Promise.resolve(); // ghost chats keep no notes
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
    ch.on('turnEnded', () => {
      this.scheduleNotes(sessionId);
      const cwd = this.cwdOf(sessionId);
      if (cwd) this.context?.refresh(sessionId, cwd);
    });
    ch.on('ended', () => {
      // A ghost chat that ends is deleted, not indexed or summarised.
      if (this.isGhost(sessionId)) return void this.endGhost(sessionId);
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

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a changed file is still as the session left it. Unknown (rebuilt edits) counts as the same. */
function diskState(f: FileChange): 'same' | 'changed' | 'missing' {
  const now = readText(f.abs);
  if (now === null) return 'missing';
  return f.after === null || now === f.after ? 'same' : 'changed';
}
