import type { DB } from './db.js';

export interface SessionRow {
  id: string;
  cwd: string | null;
  project: string | null;
  projectId: number | null;
  gitBranch: string | null;
  title: string;
  lastPrompt: string | null;
  firstTs: string | null;
  lastTs: string | null;
  prompts: number;
  messages: number;
  costUsd: number | null;
  transcriptGone: boolean;
  /** Our rolling summary of the session, when one exists. */
  summary: string | null;
}

export interface ProjectRow {
  id: number;
  cwd: string;
  name: string;
  lastTs: string | null;
  sessions: number;
}

const SESSION_COLUMNS = `
  s.id, s.cwd, p.name AS project, s.project_id AS projectId, s.git_branch AS gitBranch,
  COALESCE(s.title, s.name, s.last_prompt,
           (SELECT text FROM messages m WHERE m.session_id = s.id AND m.kind = 'prompt' ORDER BY ts LIMIT 1),
           '(untitled)') AS title,
  s.last_prompt AS lastPrompt, s.first_ts AS firstTs, s.last_ts AS lastTs,
  s.user_prompt_count AS prompts, s.msg_count AS messages, s.cost_usd AS costUsd,
  s.transcript_gone AS transcriptGone,
  json_extract(d.digest_json, '$.summary') AS summary`;

export function getSession(db: DB, id: string): SessionRow | null {
  return listSessions(db, { id, limit: 1 })[0] ?? null;
}

export function listSessions(
  db: DB,
  opts: { search?: string; projectId?: number | null; id?: string; limit?: number } = {},
): SessionRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 500 };
  if (opts.id) {
    where.push('s.id = @id');
    params.id = opts.id;
  }
  if (opts.projectId != null) {
    where.push('s.project_id = @projectId');
    params.projectId = opts.projectId;
  }
  const fts = opts.search ? toFtsQuery(opts.search) : null;
  if (fts) {
    where.push(`s.id IN (SELECT m.session_id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
                         WHERE messages_fts MATCH @fts)`);
    params.fts = fts;
  }
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN session_digests d ON d.session_id = s.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.last_ts DESC LIMIT @limit`,
    )
    .all(params) as (Omit<SessionRow, 'transcriptGone'> & { transcriptGone: number })[];
  return rows.map((r) => ({ ...r, gitBranch: r.gitBranch === 'HEAD' ? null : r.gitBranch, transcriptGone: !!r.transcriptGone }));
}

export function listProjects(db: DB): ProjectRow[] {
  return db
    .prepare(
      `SELECT p.id, p.cwd, p.name, MAX(s.last_ts) AS lastTs, COUNT(s.id) AS sessions
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id ORDER BY lastTs DESC`,
    )
    .all() as ProjectRow[];
}

/** Turns free text into a safe FTS5 query: every word must match, as a prefix. */
export function toFtsQuery(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}_]+/gu);
  if (!terms) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}
