import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { LlmClient } from '../analyze/llm.js';
import { getRecap, recapDay } from '../analyze/recap.js';
import { analysisNeeded, currentStatus, runJobs } from '../analyze/runner.js';
import type { Config } from '../config.js';
import type { LiveSession } from '../ingest/live.js';
import { scan } from '../ingest/scanner.js';
import type { DB } from '../store/db.js';
import { getSession, listProjects, listSessions, type SessionRow } from '../store/queries.js';
import type { OpenRequest, OpenResult, RecapView, SessionItem, TermInfo } from '../shared/api.js';
import type { SpawnSpec } from './pty.js';

/** The slice of PtyManager the service needs; tests pass a fake. */
export interface Terminals {
  open(spec: SpawnSpec): TermInfo;
  list(): TermInfo[];
  findBySession(sessionId: string): TermInfo | null;
}

export interface ServiceDeps {
  db: DB;
  cfg: Config;
  terminals: Terminals;
  llm: LlmClient;
  loadLive: () => LiveSession[];
  env: () => Record<string, string>;
  claudeBin?: string;
  onChanged?: () => void;
}

/**
 * Everything the window can ask for, independent of Electron.
 * The main process wires these methods to IPC.
 */
export class CompanionService {
  private analyzing: Promise<void> | null = null;

  constructor(private d: ServiceDeps) {}

  refresh(): void {
    scan(this.d.db, this.d.cfg);
  }

  listSessions(query: { search?: string; projectId?: number | null }): SessionItem[] {
    const live = new Map(this.d.loadLive().map((l) => [l.sessionId, l]));
    const terms = new Map(this.d.terminals.list().filter((t) => !t.exited).map((t) => [t.sessionId, t.id]));
    const rows = listSessions(this.d.db, query);
    const items: SessionItem[] = rows.map((r) => ({ ...r, live: live.get(r.id) ?? null, termId: terms.get(r.id) ?? null }));

    // A session that just started is live before its transcript has any messages.
    if (!query.search) {
      const known = new Set(rows.map((r) => r.id));
      const filterCwd = query.projectId != null ? listProjects(this.d.db).find((p) => p.id === query.projectId)?.cwd : null;
      for (const l of live.values()) {
        if (known.has(l.sessionId) || (filterCwd && filterCwd !== l.cwd)) continue;
        items.push({ ...liveOnlyRow(l), live: l, termId: terms.get(l.sessionId) ?? null });
      }
    }
    const rank = (s: SessionItem) => (s.termId ? 2 : s.live ? 1 : 0);
    return items.sort((a, b) => rank(b) - rank(a) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  }

  listProjects() {
    return listProjects(this.d.db).filter((p) => existsSync(p.cwd));
  }

  getRecap(): RecapView {
    return {
      recap: getRecap(this.d.db, recapDay(this.d.cfg).day),
      status: currentStatus(this.d.db, this.d.cfg),
    };
  }

  /** Runs summaries and the recap in this process, if there's anything to do. Never runs twice at once. */
  analyze(opts: { force?: boolean; endedSessionIds?: string[] } = {}): Promise<void> {
    if (this.analyzing) return this.analyzing;
    if (!opts.force && !analysisNeeded(this.d.db, this.d.cfg)) return Promise.resolve();
    this.analyzing = runJobs(this.d.db, this.d.cfg, this.d.llm, {
      forceRecap: opts.force,
      endedSessionIds: opts.endedSessionIds,
    })
      .then(() => undefined)
      .catch(() => undefined) // the failure is recorded in the analyzer status, which the window shows
      .finally(() => {
        this.analyzing = null;
        this.d.onChanged?.();
      });
    this.d.onChanged?.();
    return this.analyzing;
  }

  open(req: OpenRequest): OpenResult {
    if (req.kind === 'new') return this.startNew(req.cwd, req.prompt);
    if (req.kind === 'resume') return this.resume(req.sessionId);

    const where = this.locate(req.sessionId, req.project);
    if (!where) return { ok: false, error: `Can't find the folder for ${req.project}.` };
    if (req.mode === 'continue') {
      if (!req.sessionId) return { ok: false, error: 'This item is not tied to a session; start a new one instead.' };
      return this.resume(req.sessionId);
    }
    return this.startNew(where, req.text);
  }

  private resume(sessionId: string): OpenResult {
    const open = this.d.terminals.findBySession(sessionId);
    if (open) return { ok: true, term: open };

    const s = getSession(this.d.db, sessionId);
    if (!s) return { ok: false, error: 'Unknown session.' };
    const live = this.d.loadLive().find((l) => l.sessionId === sessionId);
    if (live) return { ok: false, error: `This session is already running in another terminal (pid ${live.pid}).` };
    if (s.transcriptGone) return { ok: false, error: 'Claude Code deleted this transcript, so it can no longer be resumed.' };
    if (!s.cwd || !existsSync(s.cwd)) return { ok: false, error: `Project folder not found: ${s.cwd ?? 'unknown'}` };
    return this.spawn(sessionId, s.title, s.cwd, ['--resume', sessionId]);
  }

  private startNew(cwd: string, prompt?: string): OpenResult {
    if (!existsSync(cwd)) return { ok: false, error: `Folder not found: ${cwd}` };
    // Choosing the id up front ties the tab to its transcript from the first message.
    const sessionId = randomUUID();
    const text = prompt?.trim();
    const title = text ? text.split('\n')[0]!.slice(0, 60) : `New session · ${basename(cwd)}`;
    return this.spawn(sessionId, title, cwd, ['--session-id', sessionId, ...(text ? [text] : [])]);
  }

  private spawn(sessionId: string, title: string, cwd: string, args: string[]): OpenResult {
    try {
      const term = this.d.terminals.open({
        id: randomUUID(),
        sessionId,
        title,
        cwd,
        file: this.d.claudeBin ?? process.env.COMPANION_CLAUDE_BIN ?? 'claude',
        args,
        env: this.d.env(),
      });
      return { ok: true, term };
    } catch (err) {
      return { ok: false, error: `Could not start claude: ${(err as Error).message}` };
    }
  }

  /** Where to run an action item: its source session's folder, else the project's. */
  private locate(sessionId: string, project: string): string | null {
    const s = sessionId ? getSession(this.d.db, sessionId) : null;
    if (s?.cwd && existsSync(s.cwd)) return s.cwd;
    return this.listProjects().find((p) => p.name === project)?.cwd ?? null;
  }
}

function liveOnlyRow(l: LiveSession): SessionRow {
  return {
    id: l.sessionId,
    cwd: l.cwd,
    project: basename(l.cwd) || null,
    projectId: null,
    gitBranch: null,
    title: l.name ?? '(new session)',
    lastPrompt: null,
    firstTs: null,
    lastTs: null,
    prompts: 0,
    messages: 0,
    costUsd: null,
    transcriptGone: false,
    summary: null,
  };
}
