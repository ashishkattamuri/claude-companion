/**
 * The contract between the Electron main process and the window.
 * Type-only: the renderer imports nothing from the backend at runtime.
 */
import type { RecapRow } from '../analyze/recap.js';
import type { AnalyzerStatus } from '../analyze/runner.js';
import type { LiveSession } from '../ingest/live.js';
import type { ProjectRow, SessionRow } from '../store/queries.js';

export type { ProjectRow, RecapRow, AnalyzerStatus, LiveSession };

export interface SessionItem extends SessionRow {
  /** Running somewhere (from Claude Code's live registry). */
  live: LiveSession | null;
  /** Open in a tab in this app. */
  termId: string | null;
}

export interface RecapView {
  recap: RecapRow | null;
  status: AnalyzerStatus | null;
}

export type OpenRequest =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'new'; cwd: string; prompt?: string }
  /** A recap action item: start fresh on it, or continue the session it came from. */
  | { kind: 'action'; mode: 'new' | 'continue'; sessionId: string; project: string; text: string };

export interface TermInfo {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  exitCode: number | null;
  exited: boolean;
}

export type OpenResult = { ok: true; term: TermInfo } | { ok: false; error: string };

/** Output since the terminal started: `end` is the total length written so far. */
export interface TermReplay {
  data: string;
  end: number;
}

export interface CompanionApi {
  listSessions(query: { search?: string; projectId?: number | null }): Promise<SessionItem[]>;
  listProjects(): Promise<ProjectRow[]>;
  getRecap(): Promise<RecapView>;
  regenerateRecap(): Promise<void>;
  openSession(req: OpenRequest): Promise<OpenResult>;
  listTerminals(): Promise<TermInfo[]>;
  replayTerminal(id: string): Promise<TermReplay>;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  /** `end` is the stream offset after this chunk, so a replay and live events can be stitched without gaps. */
  onTerminalData(cb: (id: string, data: string, end: number) => void): () => void;
  onTerminalExit(cb: (id: string, code: number) => void): () => void;
  /** Sessions, recap or analyzer status may have changed; re-fetch what you show. */
  onChanged(cb: () => void): () => void;
}
