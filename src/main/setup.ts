import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmClient } from '../analyze/llm.js';
import {
  additiveDiff,
  applyEdit,
  checkProposals,
  collectEvidence,
  countRecurrence,
  dismissedFor,
  proposeEdits,
  ruleFits,
  setupTargets,
  suggestionKey,
} from '../analyze/setup.js';
import type { Config } from '../config.js';
import type { Result, SetupEvidence, SetupSuggestion, SetupView } from '../shared/api.js';
import type { DB } from '../store/db.js';
import { listProjects } from '../store/queries.js';

/** How far back a review reads. */
export const SETUP_DAYS = 14;

interface Row {
  id: number;
  project_cwd: string;
  target_path: string;
  target_label: string;
  target_kind: 'markdown' | 'settings';
  kind: SetupSuggestion['kind'];
  anchor: string | null;
  text: string;
  diff: string;
  why: string;
  evidence_json: string;
  match_json: string;
  key: string;
  status: SetupSuggestion['status'];
  created_at: string;
  applied_at: string | null;
  applied_hash: string | null;
  backup_path: string | null;
  before_count: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
/** Resolves symlinks (macOS /var → /private/var), so one folder's sessions are found under either spelling. */
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export class SetupSuggestions {
  private running = new Map<string, Promise<Result<number>>>();

  constructor(private d: { db: DB; cfg: Config; llm: LlmClient; onChanged: () => void }) {}

  /** The project's sessions with a transcript, active since `since`. Opted-out projects have none. */
  private sessions(cwd: string, since: string) {
    if (this.d.cfg.isOptedOut(cwd) || this.d.cfg.isOptedOut(real(cwd))) return [];
    const target = real(cwd);
    return (
      this.d.db
        .prepare(
          `SELECT s.id, s.cwd, s.source_path AS path,
                  COALESCE(s.title, s.name, (SELECT text FROM messages m WHERE m.session_id = s.id AND m.kind = 'prompt' ORDER BY ts LIMIT 1), s.last_prompt, 'Chat') AS title
           FROM sessions s
           WHERE s.last_ts >= ? AND s.transcript_gone = 0 AND s.source_path IS NOT NULL AND s.cwd IS NOT NULL ORDER BY s.first_ts`,
        )
        .all(since) as { id: string; cwd: string; path: string; title: string }[]
    ).filter((s) => (s.cwd === cwd || real(s.cwd) === target) && !this.d.db.prepare(`SELECT 1 FROM side_chats WHERE id = ?`).get(s.id));
  }

  view(cwd: string | null): SetupView {
    // One entry per folder, however its path was spelled.
    const seen = new Set<string>();
    const projects = listProjects(this.d.db)
      .filter((p) => !seen.has(real(p.cwd)) && !!seen.add(real(p.cwd)))
      .map((p) => ({ cwd: p.cwd, name: p.name, optedOut: this.d.cfg.isOptedOut(p.cwd) || this.d.cfg.isOptedOut(real(p.cwd)) }));
    const pick = cwd ?? projects.find((p) => !p.optedOut)?.cwd ?? null;
    const since = new Date(Date.now() - SETUP_DAYS * 86_400_000).toISOString();
    const rows = pick
      ? (this.d.db.prepare(`SELECT * FROM setup_suggestions WHERE project_cwd = ? AND status != 'dismissed' ORDER BY target_path, created_at`).all(pick) as Row[])
      : [];
    const run = pick
      ? (this.d.db.prepare(`SELECT ran_at, evidence, found, error FROM setup_runs WHERE project_cwd = ?`).get(pick) as
          | { ran_at: string; evidence: number; found: number; error: string | null }
          | undefined)
      : undefined;
    return {
      projects,
      cwd: pick,
      suggestions: rows.map((r) => this.toView(r)),
      running: !!pick && this.running.has(pick),
      lastRun: run ? { at: run.ran_at, evidence: run.evidence, found: run.found, error: run.error } : null,
      window: { days: SETUP_DAYS, sessions: pick ? this.sessions(pick, since).length : 0 },
      model: this.d.cfg.models.setup,
    };
  }

  private toView(r: Row): SetupSuggestion {
    const evidence = JSON.parse(r.evidence_json) as SetupEvidence[];
    let since: SetupSuggestion['since'] = null;
    if (r.status === 'applied' && r.applied_at) {
      const after = countRecurrence(this.sessions(r.project_cwd, r.applied_at), r.applied_at, { kind: r.kind, text: r.text, match: JSON.parse(r.match_json) });
      since = { after, before: r.before_count, notWorking: after > 0 && after >= Math.max(1, Math.ceil(r.before_count / 3)) };
    }
    return {
      id: r.id,
      targetPath: r.target_path,
      targetLabel: r.target_label,
      kind: r.kind,
      text: r.text,
      diff: r.diff,
      why: r.why,
      evidence,
      status: r.status,
      createdAt: r.created_at,
      appliedAt: r.applied_at,
      impact: { times: r.before_count, sessions: new Set(evidence.map((e) => e.sessionId)).size },
      since,
    };
  }

  /** Reads the project's last two weeks of sessions, asks for proposals once, and keeps the ones that hold up. */
  review(cwd: string): Promise<Result<number>> {
    const running = this.running.get(cwd);
    if (running) return running;
    const p = this.doReview(cwd).finally(() => {
      this.running.delete(cwd);
      this.d.onChanged();
    });
    this.running.set(cwd, p);
    this.d.onChanged();
    return p;
  }

  private async doReview(cwd: string): Promise<Result<number>> {
    if (this.d.cfg.isOptedOut(cwd) || this.d.cfg.isOptedOut(real(cwd))) return { ok: false, error: 'This folder is opted out, so Companion never reads its sessions.' };
    const since = new Date(Date.now() - SETUP_DAYS * 86_400_000).toISOString();
    const sessions = this.sessions(cwd, since);
    const evidence = collectEvidence(sessions, since);
    const record = (found: number, error: string | null) =>
      this.d.db
        .prepare(`INSERT OR REPLACE INTO setup_runs(project_cwd, ran_at, evidence, found, error) VALUES (?, ?, ?, ?, ?)`)
        .run(cwd, new Date().toISOString(), evidence.length, found, error);
    if (!evidence.length) {
      record(0, null);
      return { ok: true, value: 0 };
    }
    const skills = evidence.filter((e) => e.kind === 'skill' && e.pattern).map((e) => e.pattern!);
    const targets = setupTargets(this.d.cfg, cwd, skills);
    const dismissed = dismissedFor(this.d.db, cwd);
    const open = this.d.db.prepare(`SELECT key, text, target_path AS target FROM setup_suggestions WHERE project_cwd = ? AND status != 'dismissed'`).all(cwd) as {
      key: string;
      text: string;
      target: string;
    }[];
    let out;
    try {
      out = await proposeEdits(this.d.cfg, this.d.llm, { evidence, targets, dismissed: dismissed.map((d) => d.text), audit: this.auditFixes(sessions.map((s) => s.id)) });
    } catch (err) {
      record(0, (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
    // Dismissed ones never come back; open ones aren't proposed twice.
    const kept = checkProposals(out, targets, evidence, [...dismissed, ...open]);
    const insert = this.d.db.prepare(
      `INSERT INTO setup_suggestions(project_cwd, target_path, target_label, target_kind, kind, anchor, text, diff, why, evidence_json, match_json, key, status, created_at, before_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const k of kept)
      insert.run(cwd, k.target.path, k.target.label, k.target.kind, k.kind, k.anchor, k.text, k.diff, k.why, JSON.stringify(k.evidence), JSON.stringify(k.match), k.key, now, k.evidence.length);
    record(kept.length, null);
    return { ok: true, value: kept.length };
  }

  private auditFixes(sessionIds: string[]): string[] {
    const fixes: string[] = [];
    for (const id of sessionIds) {
      const row = this.d.db.prepare(`SELECT view_json FROM session_audits WHERE session_id = ?`).get(id) as { view_json: string } | undefined;
      if (!row) continue;
      try {
        for (const t of (JSON.parse(row.view_json).topFixes ?? []) as { fix: string }[]) if (t.fix && !fixes.includes(t.fix)) fixes.push(t.fix);
      } catch {
        /* skip a broken audit */
      }
    }
    return fixes.slice(0, 10);
  }

  private row(id: number): Row | undefined {
    return this.d.db.prepare(`SELECT * FROM setup_suggestions WHERE id = ?`).get(id) as Row | undefined;
  }

  /** Writes the suggestion into the file as it is now, after copying the file to a .bak. */
  apply(id: number): Result {
    const r = this.row(id);
    if (!r || r.status !== 'new') return { ok: false, error: 'That suggestion can’t be applied.' };
    if (this.d.cfg.isOptedOut(r.project_cwd)) return { ok: false, error: 'This folder is opted out.' };
    const existed = existsSync(r.target_path);
    const before = read(r.target_path);
    const after = applyEdit(before, r.target_kind, r.kind, r.text, r.anchor);
    if (after === null)
      return { ok: false, error: before.includes(r.text) ? 'The file already says this.' : 'The file changed since this was suggested; edit the suggestion and try again.' };
    if (additiveDiff({ content: before, kind: r.target_kind }, after) === null) return { ok: false, error: 'Applying it now would change existing text, so it was not applied.' };
    let backup: string | null = null;
    try {
      if (existed) {
        backup = `${r.target_path}.companion-${id}.bak`;
        copyFileSync(r.target_path, backup);
      } else mkdirSync(dirname(r.target_path), { recursive: true });
      writeFileSync(r.target_path, after);
    } catch (err) {
      return { ok: false, error: `Could not write ${r.target_path}: ${(err as Error).message}` };
    }
    this.d.db
      .prepare(`UPDATE setup_suggestions SET status = 'applied', applied_at = ?, applied_hash = ?, backup_path = ? WHERE id = ?`)
      .run(new Date().toISOString(), sha(after), backup, id);
    this.d.onChanged();
    return { ok: true, value: undefined };
  }

  /**
   * Takes the suggestion back out: restores the .bak if the file is as Apply left it, else removes just
   * the added text or rule, so later edits to the file are kept.
   */
  undo(id: number): Result {
    const r = this.row(id);
    if (!r || r.status !== 'applied') return { ok: false, error: 'That suggestion isn’t applied.' };
    const now = read(r.target_path);
    let restored: string | null = null;
    if (sha(now) === r.applied_hash) restored = r.backup_path ? read(r.backup_path) : null;
    else if (r.target_kind === 'markdown') {
      const at = now.indexOf(r.text);
      if (at < 0 || now.indexOf(r.text, at + 1) >= 0) return { ok: false, error: 'The added text was changed since, so it can’t be taken out automatically.' };
      restored = (now.slice(0, at).replace(/\n\n$/, '\n') + now.slice(at + r.text.length).replace(/^\n/, '')).replace(/\n*$/, '\n');
    } else {
      try {
        const obj = JSON.parse(now);
        const list = r.kind === 'allow' ? 'allow' : 'deny';
        obj.permissions[list] = (obj.permissions?.[list] ?? []).filter((x: string) => x !== r.text);
        restored = `${JSON.stringify(obj, null, 2)}\n`;
      } catch {
        return { ok: false, error: 'The settings file can’t be read, so the rule can’t be taken out automatically.' };
      }
    }
    try {
      if (restored === null) rmSync(r.target_path, { force: true });
      else writeFileSync(r.target_path, restored);
      if (r.backup_path) rmSync(r.backup_path, { force: true });
    } catch (err) {
      return { ok: false, error: `Could not write ${r.target_path}: ${(err as Error).message}` };
    }
    this.d.db.prepare(`UPDATE setup_suggestions SET status = 'new', applied_at = NULL, applied_hash = NULL, backup_path = NULL WHERE id = ?`).run(id);
    this.d.onChanged();
    return { ok: true, value: undefined };
  }

  dismiss(id: number): void {
    this.d.db.prepare(`UPDATE setup_suggestions SET status = 'dismissed' WHERE id = ? AND status = 'new'`).run(id);
    this.d.onChanged();
  }

  /** Changes the text to add, with the same checks as a proposal. */
  edit(id: number, text: string): Result {
    const r = this.row(id);
    if (!r || r.status !== 'new') return { ok: false, error: 'Only a suggestion that isn’t applied can be edited.' };
    const t = text.trim();
    if (!t) return { ok: false, error: 'Nothing to add.' };
    if ((r.kind === 'allow' || r.kind === 'deny') && !ruleFits(t, JSON.parse(r.evidence_json)))
      return { ok: false, error: 'That rule is wider than what was denied; keep it to the commands in the evidence.' };
    const content = read(r.target_path);
    const after = applyEdit(content, r.target_kind, r.kind, t, r.anchor);
    const diff = after === null ? null : additiveDiff({ content, kind: r.target_kind }, after);
    if (diff === null) return { ok: false, error: content.includes(t) ? 'The file already says this.' : 'That edit can’t be made as an addition to the file.' };
    this.d.db.prepare(`UPDATE setup_suggestions SET text = ?, diff = ?, key = ? WHERE id = ?`).run(t, diff, suggestionKey(r.target_path, r.kind, t), id);
    this.d.onChanged();
    return { ok: true, value: undefined };
  }
}
