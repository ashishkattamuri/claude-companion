/**
 * The contract between the Electron main process and the window.
 * Type-only: the renderer imports nothing from the backend at runtime.
 */
import type { ConversationItem, PatchHunk, SessionFacts, ToolResult } from '../adapter/conversation.js';
import type { TestRun, TrailFailure, TrailRequest, Verification } from '../adapter/trail.js';
import type { SinceData, SinceFile } from '../analyze/since.js';
import type { AuditView } from '../analyze/audit/view.js';
import type { HeavyItem } from '../analyze/heavy.js';
import type { RecapRow } from '../analyze/recap.js';
import type { AnalyzerStatus } from '../analyze/runner.js';
import type { RecapSource, ServerView } from '../connectors/index.js';
import type { GitHubActivity, GitHubItem } from '../connectors/github.js';
import type { ActionResult, CatalogPlugin, MarketplaceAction, PluginAction, PluginCatalog, PluginConfig } from '../connectors/plugins.js';
import type { ServerConfig } from '../connectors/servers.js';
import type { LiveSession } from '../ingest/live.js';
import type { ProjectRow, SessionRow } from '../store/queries.js';

export type { ConversationItem, PatchHunk, SessionFacts, ToolResult, ProjectRow, RecapRow, AnalyzerStatus, LiveSession };
export type { ServerView, RecapSource, GitHubActivity, GitHubItem, ServerConfig };
export type { ActionResult, CatalogPlugin, MarketplaceAction, PluginAction, PluginCatalog, PluginConfig };
export type { AuditView, HeavyItem };
export type { TestRun, TrailFailure, TrailRequest, Verification, SinceFile };

/** What a session did since your viewing checkpoint; `paths` names each file as the chat sees it. */
export interface SinceView extends SinceData {
  paths: Record<string, string>;
}
export type { AuditFindingView, AuditStepRef } from '../analyze/audit/view.js';

/** A session's latest audit, whether one is running, and how far the session has moved on since. */
export interface AuditState {
  audit: AuditView | null;
  running: boolean;
  /** Tool calls made since the audit ran. */
  newSteps: number;
}

/** A dialog Claude Code is showing in the terminal, offered in the UI as well. */
export type ScreenPrompt =
  | { kind: 'trust'; question: string; options: []; yesSelected: boolean }
  | {
      kind: 'permission' | 'choice';
      question: string;
      header: string | null;
      options: { key: string; label: string; selected: boolean }[];
    }
  /** Any other dialog or menu (e.g. /plugin): shown as drawn, answered with arrow keys, Enter and Esc. */
  | { kind: 'menu'; lines: string[] };

/**
 * How the window can drive the session:
 * - attached: a Claude Code background session with Companion's terminal attached. Every attached
 *   terminal (Companion, iTerm via `claude attach`) can type into it.
 * - background: a background session not attached here yet; sending a message attaches.
 * - mirror: a plain `claude` running in another terminal; shown live, read-only.
 * - history: not running; sending a message continues it as a background session.
 */
export type SessionMode = 'attached' | 'background' | 'mirror' | 'history';

export interface SessionState {
  sessionId: string;
  mode: SessionMode;
  /** starting → idle ⇄ busy, waiting while a dialog needs an answer, exited when claude quits. */
  status: 'starting' | 'idle' | 'busy' | 'waiting' | 'exited' | 'stopped';
  prompt: ScreenPrompt | null;
  /** Messages typed in the app that haven't reached Claude yet. */
  queued: string[];
  facts: SessionFacts;
  cwd: string | null;
  title: string;
  /** For mirrors: where the session runs, e.g. "pid 48343". */
  elsewhere: string | null;
  /** Background sessions: the id for `claude attach <id>`. */
  jobId: string | null;
}

export interface SessionSnapshot {
  state: SessionState;
  items: ConversationItem[];
  /** Ids of user messages that were sent from this app (the rest were typed in a terminal). */
  sentFromApp: string[];
  /** Raw terminal output for the terminal view, with its stream offset. */
  replay: { data: string; end: number } | null;
}

export interface SessionListItem extends SessionRow {
  live: LiveSession | null;
  /** A background session: drivable from Companion and any terminal that attaches. */
  background: boolean;
  /** Companion's terminal is attached to it right now. */
  attached: boolean;
  status: SessionState['status'] | null;
  /** The chat this one was opened from. */
  parentId: string | null;
  /** Hidden from the sidebar unless "Show hidden" is on. */
  hidden: boolean;
  /** The latest audit: the share of the session's cost it found wasted. */
  audit: { share: number; reviewed: boolean } | null;
  auditing: boolean;
}

/** Context tools and links for one session. */
export interface SessionExtras {
  /** The new-chat tool is registered for all Claude sessions (`companion tools install`). */
  toolsEverywhere: boolean;
  notes: { path: string; updatedAt: string; behind: boolean; preview: string } | null;
  notesUpdating: boolean;
  pins: { path: string; label: string }[];
  /** The chat this one was opened from. */
  parent: { id: string; title: string; kind: string } | null;
  /** Chats opened from this one, and where each one's return stands. */
  children: { id: string; title: string; kind: string; returned: { version: number; status: 'draft' | 'sent'; outdated: boolean } | null }[];
  /** For a chat opened from another: what it was given, and its return packages. */
  handoff: HandoffRecord | null;
  /** What fills the context window, from Claude Code's `/context`; null until first read. */
  context: ContextBreakdown | null;
  /** Files the session changed, with each file's net +/− over the session (the same as the review). */
  changes: { path: string; abs: string; added: number; removed: number }[];
  /** The biggest tool results in the context since the last compaction, biggest first. */
  heavy: HeavyItem[];
}

/**
 * Running chats with a warm cache that a change of tools reaches right away: Claude Code picks up an
 * MCP server added or removed mid-chat, and the next message reprocesses the whole conversation.
 */
export interface ToolChangeImpact {
  chats: { id: string; title: string; tokens: number }[];
  total: number;
}

/** One hunk of a unified diff: lines start with ' ' (context), '-' (removed) or '+' (added). */
export interface ReviewHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A file the session changed: its net diff over the whole session, and a short explanation. */
export interface ReviewFile {
  /** As Claude sees it from the session's folder: relative when inside the project. */
  path: string;
  abs: string;
  isNew: boolean;
  added: number;
  removed: number;
  hunks: ReviewHunk[];
  /** Lines in the file before the session changed it (0 for a new file), for the trailing gap. */
  oldLineCount: number;
  /** Two or three sentences on what changed and why; null until written (or when it failed). */
  explanation: string | null;
  /** Whether the file on disk still matches what the session left: else someone changed it since. */
  disk: 'same' | 'changed' | 'missing';
  /** The file's earlier content wasn't recorded, so these are the session's edits one by one. */
  partial: boolean;
  /** The conversation steps that changed it, oldest first. */
  stepIds: string[];
  /** What Claude said just before each of those steps, in its own words; null when it said nothing. */
  stepNotes: (string | null)[];
  /** Identifies this exact change; explanations are cached by it. */
  hash: string;
  /** When each step ran, and the conversation ids of the requests that led to them. */
  stepTs: string[];
  requestIds: string[];
  /** Each hunk's key (what it changes, not where), to recognise it after other edits. */
  hunkKeys: string[];
  /** Where the file was last edited in the transcript, to order it against test runs. */
  lastSeq: number | null;
  /** Test evidence after the file's last edit (a test ran and how it came out; not what it covered). */
  verification: Verification;
  /**
   * Your explicit review of the file, kept apart from merely having seen it: reviewed, never
   * reviewed, or reviewed and changed since (`changedHunks` are the hunks to look at again).
   */
  review: { state: 'unreviewed' | 'reviewed' | 'changed'; at: string | null; changedHunks: number[] };
}

/** A behavior the session's changes add or alter, with the files that make it up. */
export interface ReviewBehavior {
  id: string;
  title: string;
  summary: string;
  why: string | null;
  /** Paths as in ReviewFile.path; only files the session actually changed. */
  files: string[];
  /** The requests it answers (conversation ids). */
  requestIds: string[];
  /** The model's judgment from the diff; null when nothing judged it. */
  risk: 'low' | 'medium' | 'high' | null;
  riskReason: string | null;
}

/** The changes grouped by behavior, and what was implemented against what was asked. Inferred by a model. */
export interface ReviewOverview {
  /** The set of changes it was written for. */
  key: string;
  implemented: string | null;
  behaviors: ReviewBehavior[];
  /** Where the changes go beyond, fall short of, or differ from the requests. */
  deviations: { text: string; requestIds: string[] }[];
  /** null when it was built without a model call (a small change). */
  model: string | null;
  createdAt: string;
}

export interface ReviewView {
  files: ReviewFile[];
  /** Explanations are being written. */
  explaining: boolean;
  /** Why the last explanation run failed, if it did. */
  error: string | null;
  /** What you asked for: the requests that led to these edits, and the latest one. */
  requests: TrailRequest[];
  /** Tests and checks Claude ran in the session, oldest first. */
  tests: TestRun[];
  /** Steps that failed or were denied. */
  failures: TrailFailure[];
  overview: ReviewOverview | null;
  /** The overview was written for an earlier set of changes. */
  overviewStale: boolean;
  overviewing: boolean;
  overviewError: string | null;
  /** Behaviors you marked as understood, by id, and whether their files changed since. */
  understood: Record<string, { at: string; changed: boolean }>;
}

/** Claude Code's `/context` categories (tokens each), and the space kept free for autocompact. */
export interface ContextBreakdown {
  categories: { name: string; tokens: number }[];
  autocompact: number;
}

/** The background a chat opened from another was given, exactly as supplied. */
export interface HandoffParts {
  notes: string | null;
  /** The parent's last exchanges, word for word, when included. */
  recent: string | null;
  /** Pinned files (absolute paths) the new chat was told to read. */
  pins: string[];
  /** Opened from the preview, where you could edit all of this. */
  previewed: boolean;
  /** The full background text Claude was given. */
  text?: string;
}

/** A hand-off before it starts: everything the new chat will be given, for you to edit. */
export interface HandoffDraft {
  kind: 'branch' | 'handoff';
  title: string;
  /** The opening message: the goal. */
  prompt: string;
  notes: string | null;
  recent: string | null;
  pins: { path: string; label: string }[];
}

/** The same record from either side: what the child was given and what came back. */
export interface HandoffRecord {
  childId: string;
  parentId: string;
  parentTitle: string;
  childTitle: string;
  kind: string;
  createdAt: string;
  prompt: string | null;
  /** null for chats opened before hand-offs were recorded. */
  parts: HandoffParts | null;
  pinLabels: string[];
  /** The full text given to the child, as Claude got it. */
  context: string | null;
  returns: { id: number; version: number; status: 'draft' | 'sent'; sentAt: string | null; outdated: boolean }[];
}

/** What a child chat did, prepared for its parent. Facts from the transcript; the outcome is the child's claim. */
export interface ReturnPackage {
  id: number;
  version: number;
  childId: string;
  parentId: string;
  childTitle: string;
  parentTitle: string;
  stateKey: string;
  createdAt: string;
  status: 'draft' | 'sent';
  sentAt: string | null;
  /** The child did more since this version was prepared. */
  outdated: boolean;
  childStatus: 'working' | 'waiting' | 'idle' | 'ended' | 'interrupted';
  /** The child's last reply, in its own words. */
  outcome: { id: string; text: string } | null;
  remaining: string[];
  changes: { path: string; added: number; removed: number; disk: 'same' | 'changed' | 'missing'; verified: Verification['state'] }[];
  /** Where the child's changes are: in the parent's folder already, or elsewhere (a worktree). */
  workspace: { child: string | null; parent: string | null; same: boolean };
  /** What the child said as it made its edits, with the step. */
  decisions: { text: string; stepId: string }[];
  verification: { command: string; outcome: TestRun['outcome']; summary: string | null; stepId: string; stale: boolean }[];
  concerns: string[];
  suggestion: string;
  /** The message to send: the default composition, or what was sent. */
  message: string;
}

/** Tokens and cost of one side-chat answer. `cached` is the chat's history read back from the prompt cache. */
export interface SideUsage {
  fresh: number;
  cached: number;
  cacheWrite: number;
  output: number;
  costUsd: number | null;
}

export interface SideMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
  usage: SideUsage | null;
  error: string | null;
}

/**
 * A hunk or file a side chat asks about, frozen when the question was asked: the exact diff, the
 * steps that made it and what Claude said there, so the thread keeps its evidence after the code moves on.
 */
export interface ChangeRef {
  abs: string;
  path: string;
  /** The hunk asked about, or null for the whole file. */
  hunk: number | null;
  /** Identifies the hunk by what it changes (see hunkKey); null for a whole file. */
  hunkKey: string | null;
  /** The file's net change when asked; a whole-file question is stale once it differs. */
  fileHash: string;
  /** The diff asked about, as unified-diff text. */
  diff: string;
  /** Lines it spans in the file after the change; null for a whole file. */
  from: number | null;
  to: number | null;
  /** The edits that made it, and what Claude said just before the last of them. */
  stepIds: string[];
  note: string | null;
  /** The request that led to it. */
  request: string | null;
  at: string;
}

/**
 * A side chat: a question about a chat, answered in a fork of it so the chat's own context never
 * sees it. The thread shows only the message it replies to, not the forked history.
 */
export interface SideChat {
  id: string;
  sessionId: string;
  anchor: { id: string | null; role: 'user' | 'assistant'; text: string; change?: ChangeRef | null };
  /** For a change: the code changed since the question, so the answers may be out of date. */
  stale: boolean;
  createdAt: string;
  messages: SideMessage[];
  /** An answer is being written. */
  running: boolean;
  /** The answer so far, while running. */
  partial: string | null;
  /** What Claude is doing while running, e.g. "Reading src/app.ts". */
  activity: string | null;
}

export interface SideAsk {
  /** Continue this thread; omitted to start one. */
  chatId?: string;
  /** The message (or change) a new thread replies to. */
  anchor?: { id: string | null; role: 'user' | 'assistant'; text: string; change?: ChangeRef | null };
  text: string;
}

export interface RecapView {
  recap: RecapRow | null;
  status: AnalyzerStatus | null;
  /** What GitHub returned for this recap. */
  source: RecapSource | null;
  /** Offer to connect GitHub: you work in GitHub repos and Companion doesn't read from GitHub yet. */
  githubOffer: { existing: string | null } | null;
}

export interface NewSessionRequest {
  cwd: string;
  prompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  model?: string;
  worktree?: boolean;
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface CompanionApi {
  listSessions(query: { search?: string }): Promise<SessionListItem[]>;
  listProjects(): Promise<ProjectRow[]>;
  getRecap(): Promise<RecapView>;
  regenerateRecap(): Promise<void>;

  /** Starts watching a session and returns everything needed to render it. */
  openSession(sessionId: string): Promise<Result<SessionSnapshot>>;
  closeSessionView(sessionId: string): void;
  newSession(req: NewSessionRequest): Promise<Result<string>>;
  /** Sends a message; starts claude with --resume first if the session isn't running here. */
  send(sessionId: string, text: string): Promise<Result>;
  /** Answers the dialog on screen: an option key ("1"), or "yes"/"no" for folder trust. */
  answer(sessionId: string, key: string): void;
  interrupt(sessionId: string): void;
  cyclePermissionMode(sessionId: string): void;
  /** Stops the session's claude process (`claude stop`). The session can be continued later. */
  stop(sessionId: string): Promise<void>;
  /** Opens the same live session in Terminal or iTerm (`claude attach <id>`). */
  openInTerminal(sessionId: string): Promise<Result>;
  pickFolder(): Promise<string | null>;
  /** Hides chats and the chats opened from them, or shows them again. Transcripts are untouched. */
  setHidden(sessionIds: string[], hidden: boolean): Promise<void>;
  /** Asks to confirm, stops chats that run in the background, and deletes their transcripts. */
  deleteSessions(sessionIds: string[]): Promise<Result<boolean>>;

  getExtras(sessionId: string): Promise<SessionExtras>;
  /** Runs /compact, keeping pinned files and the optional focus. */
  compact(sessionId: string, focus: string): Promise<Result>;
  /** Opens a fresh session that picks up from this one's notes; with a draft, exactly what you edited. */
  handOff(sessionId: string, draft?: HandoffDraft): Promise<Result<string>>;
  /** What a hand-off from this chat would give the new chat, to edit before it starts. */
  previewHandoff(sessionId: string, kind: HandoffDraft['kind']): Promise<Result<HandoffDraft>>;
  getHandoff(childId: string): Promise<HandoffRecord | null>;
  /** Prepares (or reuses, if nothing changed) a return package for a child chat. Sends nothing. */
  prepareReturn(childId: string): Promise<Result<ReturnPackage>>;
  /** Sends a package's message to the parent chat (queued if it's busy). Each version is sent once. */
  sendReturn(packageId: number, message: string): Promise<Result>;
  pickFile(sessionId: string): Promise<string | null>;
  pinFile(sessionId: string, path: string): Promise<void>;
  unpinFile(sessionId: string, path: string): Promise<void>;
  reloadPins(sessionId: string): Promise<Result>;
  openNotes(sessionId: string): Promise<void>;
  /** What the session changed, file by file; `explain` also writes the missing explanations and overview. */
  getReview(sessionId: string, explain?: boolean): Promise<ReviewView>;
  /** Writes a new overview for the current changes (the shown one is out of date). */
  refreshOverview(sessionId: string): Promise<void>;
  /** Marks a file reviewed (its current hunks), or clears the mark. */
  markReviewed(sessionId: string, abs: string, reviewed: boolean): Promise<void>;
  /**
   * What changed since your viewing checkpoint, frozen at `upto` (a transcript position; omitted for
   * the latest). Never moves the checkpoint.
   */
  getSince(sessionId: string, upto?: number | null): Promise<SinceView>;
  /** You've caught up to `upto`: it becomes the new checkpoint. */
  markSeen(sessionId: string, upto: number): Promise<void>;
  /** Marks a behavior understood, or clears the mark. This is your acknowledgement, not test evidence. */
  markUnderstood(sessionId: string, behaviorId: string, understood: boolean): Promise<void>;
  /** Opens a file the session changed in its default app. */
  openChangedFile(sessionId: string, path: string): Promise<void>;
  refreshNotes(sessionId: string): Promise<void>;
  getAudit(sessionId: string): Promise<AuditState>;
  /**
   * Asks to confirm (showing what it will read and which model reviews it), then audits the session
   * for wasted steps. `null` means cancelled. Resolves when the audit is done.
   */
  runAudit(sessionId: string): Promise<Result<AuditView | null>>;
  listSideChats(sessionId: string): Promise<SideChat[]>;
  /** Asks a side question (a new thread, or a follow-up). Resolves with the thread id once it starts. */
  askSide(sessionId: string, ask: SideAsk): Promise<Result<string>>;
  stopSide(chatId: string): void;
  /** The same change as a thread asked about, as the code is now: to ask again on the latest revision. */
  latestChange(sessionId: string, chatId: string): Promise<ChangeRef | null>;
  deleteSideChat(chatId: string): Promise<void>;
  /** A session's side chats changed (an answer streamed in, finished, or a thread was deleted). */
  onSideChanged(cb: (sessionId: string) => void): () => void;
  /** Restarts a chat that lacks Companion's tools as a copy that has them (history kept). */
  restartWithTools(sessionId: string): Promise<Result<string>>;
  /** Registers the new-chat tool for every Claude session, including ones in a terminal. */
  installToolsEverywhere(): Promise<Result>;
  /** Claude Code's plugin catalog, installed plugins and marketplaces (what `/plugin` shows). */
  listPlugins(): Promise<Result<PluginCatalog>>;
  /**
   * Installs, uninstalls, enables, disables or updates a plugin for every session. Uninstalling,
   * and installing a plugin that runs a command, ask to confirm first; `null` means cancelled.
   */
  pluginAction(action: PluginAction, id: string): Promise<Result<ActionResult | null>>;
  /** Adds (source: owner/repo, URL or path), removes (asks first) or refreshes a marketplace. */
  marketplaceAction(action: MarketplaceAction, target?: string): Promise<Result<ActionResult | null>>;
  /** What an installed plugin adds to sessions and its context cost (`claude plugin details`). */
  pluginDetails(id: string): Promise<Result<string>>;
  pluginConfig(id: string): Promise<Result<PluginConfig>>;
  /** Saves option values; returns the ones saved. */
  savePluginConfig(id: string, values: Record<string, string>): Promise<Result<string[]>>;

  /** MCP servers from Claude Code's settings and from enabled plugins. */
  listServers(): Promise<ServerView[]>;
  /** Running chats an MCP server added or removed now would reach, and what each would reprocess. */
  toolChangeImpact(): Promise<ToolChangeImpact>;
  /** Connects to a server to see whether it works (and who it's signed in as). */
  checkConnector(name: string): Promise<ServerView | null>;
  /** Lets Companion read from a server (e.g. GitHub for the recap), or stops it and forgets what it fetched. */
  setConnectorEnabled(name: string, enabled: boolean): Promise<ServerView | null>;
  /** Adds an MCP server to Claude Code for every session. */
  addServer(name: string, config: ServerConfig): Promise<Result>;
  /** Asks to confirm, then removes the server from Claude Code (`claude mcp remove`). */
  removeConnector(name: string): Promise<Result<boolean>>;
  dismissGithubOffer(): Promise<void>;

  /** The app wants to show a session (e.g. a new chat Claude just opened). */
  onNavigate(cb: (sessionId: string, draft?: string) => void): () => void;

  /** The terminal output so far, for a terminal view that is (re)mounting. */
  replayTerminal(sessionId: string): Promise<{ data: string; end: number } | null>;
  writeTerminal(sessionId: string, data: string): void;
  resizeTerminal(sessionId: string, cols: number, rows: number): void;

  onItems(cb: (sessionId: string, items: ConversationItem[]) => void): () => void;
  onState(cb: (state: SessionState) => void): () => void;
  /** `end` is the stream offset after this chunk, so replay and live data join without gaps. */
  onTerminalData(cb: (sessionId: string, data: string, end: number) => void): () => void;
  /** User messages sent from the app, once they show up in the transcript. */
  onSentFromApp(cb: (sessionId: string, itemId: string) => void): () => void;
  /** Sessions, recap or analyzer status may have changed; re-fetch lists. */
  onChanged(cb: () => void): () => void;
}
