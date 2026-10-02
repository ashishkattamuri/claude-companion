/**
 * The contract between the Electron main process and the window.
 * Type-only: the renderer imports nothing from the backend at runtime.
 */
import type { ConversationItem, PatchHunk, SessionFacts, ToolResult } from '../adapter/conversation.js';
import type { RecapRow } from '../analyze/recap.js';
import type { AnalyzerStatus } from '../analyze/runner.js';
import type { LiveSession } from '../ingest/live.js';
import type { ProjectRow, SessionRow } from '../store/queries.js';

export type { ConversationItem, PatchHunk, SessionFacts, ToolResult, ProjectRow, RecapRow, AnalyzerStatus, LiveSession };

/** A dialog Claude Code is showing in the terminal, offered in the UI as well. */
export type ScreenPrompt =
  | { kind: 'trust'; question: string; options: []; yesSelected: boolean }
  | {
      kind: 'permission' | 'choice';
      question: string;
      header: string | null;
      options: { key: string; label: string; selected: boolean }[];
    };

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
}

export interface RecapView {
  recap: RecapRow | null;
  status: AnalyzerStatus | null;
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
