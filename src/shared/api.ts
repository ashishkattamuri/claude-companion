/**
 * The contract between the Electron main process and the window.
 * Type-only: the renderer imports nothing from the backend at runtime.
 */
import type { ConversationItem, PatchHunk, SessionFacts, ToolResult } from '../adapter/conversation.js';
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
  /** Chats opened from this one. */
  children: { id: string; title: string; kind: string }[];
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
  /** Opens a fresh session that picks up from this one's notes. */
  handOff(sessionId: string): Promise<Result<string>>;
  pickFile(sessionId: string): Promise<string | null>;
  pinFile(sessionId: string, path: string): Promise<void>;
  unpinFile(sessionId: string, path: string): Promise<void>;
  reloadPins(sessionId: string): Promise<Result>;
  openNotes(sessionId: string): Promise<void>;
  refreshNotes(sessionId: string): Promise<void>;
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
