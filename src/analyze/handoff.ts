import { createHash } from 'node:crypto';
import type { FileChange } from '../adapter/changes.js';
import type { Trail } from '../adapter/trail.js';
import { verificationFor } from '../adapter/trail.js';
import type { HandoffParts, ReturnPackage } from '../shared/api.js';
import { composeMessage } from '../shared/handoffMessage.js';
import type { DB } from '../store/db.js';

/**
 * Hand-offs between a chat and the chats opened from it. Outbound, the record is exactly what the new
 * chat was given. Back, a return package collects what the child did, from its transcript: its own
 * last reply (a claim, not a result), the changes, the tests that ran, and what's still open. Nothing
 * is sent to the parent until you send it, and each version is sent at most once.
 */

/** What a child chat was given when it was opened, as stored on its link. */
export function readHandoff(db: DB, childId: string): { prompt: string | null; parts: HandoffParts | null } | null {
  const row = db.prepare(`SELECT prompt, context_json FROM session_links WHERE child_id = ?`).get(childId) as
    | { prompt: string | null; context_json: string | null }
    | undefined;
  if (!row) return null;
  let parts: HandoffParts | null = null;
  try {
    parts = row.context_json ? (JSON.parse(row.context_json) as HandoffParts) : null;
  } catch {
    parts = null;
  }
  return { prompt: row.prompt, parts };
}

/** Identifies what the child has done so far: a package for an older state is out of date. */
export function childStateKey(files: FileChange[], trail: Trail): string {
  return createHash('sha256')
    .update(trail.last?.id ?? '')
    .update(files.map((f) => f.hash).join(','))
    .digest('hex')
    .slice(0, 24);
}

export interface PackageInput {
  childId: string;
  parentId: string;
  childTitle: string;
  parentTitle: string;
  kind: string;
  files: FileChange[];
  trail: Trail;
  display: (abs: string) => string;
  disk: (f: FileChange) => 'same' | 'changed' | 'missing';
  /** The child's last reply and its id, read from the transcript. */
  lastReply: { id: string; text: string } | null;
  todos: { content: string; status: string }[] | null;
  childStatus: ReturnPackage['childStatus'];
  childCwd: string | null;
  parentCwd: string | null;
}

/** Builds a package from the child's transcript. Every line is a recorded fact or labelled as the child's claim. */
export function buildPackage(p: PackageInput): Omit<ReturnPackage, 'id' | 'version' | 'status' | 'sentAt' | 'createdAt' | 'outdated' | 'message'> {
  const lastEdit = new Map<string, number>();
  for (const e of p.trail.edits) lastEdit.set(e.abs, e.seq);
  const changes = p.files.map((f) => {
    const v = verificationFor(lastEdit.get(f.abs) ?? null, p.trail.tests);
    return { path: p.display(f.abs), added: f.added, removed: f.removed, disk: p.disk(f), verified: v.state };
  });
  const lastSeq = Math.max(0, ...lastEdit.values());
  const verification = p.trail.tests.map((t) => ({
    command: t.command,
    outcome: t.outcome,
    summary: t.summary,
    stepId: t.stepId,
    stale: t.seq < lastSeq,
  }));
  const decisions: ReturnPackage['decisions'] = [];
  for (const f of p.files)
    f.stepNotes.forEach((n, i) => {
      if (n && !decisions.some((d) => d.text === n)) decisions.push({ text: n, stepId: f.stepIds[i]! });
    });
  const remaining = (p.todos ?? []).filter((t) => t.status !== 'completed').map((t) => t.content);
  const same = !!p.childCwd && !!p.parentCwd && p.childCwd === p.parentCwd;

  const concerns: string[] = [];
  if (p.childStatus === 'working') concerns.push('The child is still working, so this is a snapshot of work in progress.');
  if (p.childStatus === 'interrupted') concerns.push('The child’s last turn was interrupted.');
  const failing = verification.filter((v) => v.outcome === 'failed' && !v.stale);
  if (failing.length) concerns.push(`${failing.length} test or check run${failing.length === 1 ? '' : 's'} failed after the last edit.`);
  const unverified = changes.filter((c) => c.verified !== 'passed');
  if (changes.length && unverified.length)
    concerns.push(
      unverified.length === changes.length
        ? 'None of the changes has a passing test or check after its last edit.'
        : `Not verified: ${unverified.map((c) => c.path).slice(0, 5).join(', ')}${unverified.length > 5 ? ` and ${unverified.length - 5} more` : ''}.`,
    );
  const denied = p.trail.failures.filter((f) => f.denied).length;
  if (denied) concerns.push(`${denied} step${denied === 1 ? ' was' : 's were'} denied permission.`);
  const external = changes.filter((c) => c.disk !== 'same');
  if (external.length) concerns.push(`Changed on disk since the child edited them: ${external.map((c) => c.path).join(', ')}.`);

  const suggestion = !changes.length
    ? remaining.length
      ? 'Decide whether the remaining items still matter here.'
      : 'Read the outcome; there are no file changes to review.'
    : !same
      ? `Review the ${changes.length} changed file${changes.length === 1 ? '' : 's'} in ${p.childCwd}, then merge them into this folder if they hold up; nothing has been merged.`
      : unverified.length
        ? `Review the ${changes.length} changed file${changes.length === 1 ? '' : 's'} and run the tests before building on them.`
        : `Review the ${changes.length} changed file${changes.length === 1 ? '' : 's'}; they are already in this folder.`;

  return {
    childId: p.childId,
    parentId: p.parentId,
    childTitle: p.childTitle,
    parentTitle: p.parentTitle,
    stateKey: childStateKey(p.files, p.trail),
    childStatus: p.childStatus,
    outcome: p.lastReply,
    remaining,
    changes,
    workspace: { child: p.childCwd, parent: p.parentCwd, same },
    decisions: decisions.slice(-6),
    verification,
    concerns,
    suggestion,
  };
}

export { composeMessage, SECTIONS, type Section } from '../shared/handoffMessage.js';

interface ReturnRow {
  id: number;
  child_id: string;
  parent_id: string;
  version: number;
  state_key: string;
  package_json: string;
  message: string | null;
  status: 'draft' | 'sent';
  created_at: string;
  sent_at: string | null;
}

export function listReturns(db: DB, childId: string): ReturnRow[] {
  return db.prepare(`SELECT * FROM handoff_returns WHERE child_id = ? ORDER BY version`).all(childId) as ReturnRow[];
}

export function toPackage(r: ReturnRow, currentKey: string | null): ReturnPackage {
  const body = JSON.parse(r.package_json) as Omit<ReturnPackage, 'id' | 'version' | 'status' | 'sentAt' | 'createdAt' | 'outdated' | 'message'>;
  return {
    ...body,
    id: r.id,
    version: r.version,
    status: r.status,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    outdated: currentKey !== null && currentKey !== r.state_key,
    message: r.message ?? composeMessage({ ...body, version: r.version }),
  };
}

/** Saves a package as the next version, unless the latest version is for the same state already. */
export function savePackage(db: DB, body: ReturnType<typeof buildPackage>): ReturnRow {
  const prev = listReturns(db, body.childId).at(-1);
  if (prev && prev.state_key === body.stateKey) return prev;
  const version = (prev?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO handoff_returns(child_id, parent_id, version, state_key, package_json, message, status, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'draft', ?)`)
    .run(body.childId, body.parentId, version, body.stateKey, JSON.stringify(body), now);
  return db.prepare(`SELECT * FROM handoff_returns WHERE id = ?`).get(info.lastInsertRowid) as ReturnRow;
}

/**
 * Claims a version for sending. Fails if it was sent already (so a repeated click or event never
 * delivers twice) or a newer version exists.
 */
export function claimForSend(db: DB, id: number, message: string): { ok: true; row: ReturnRow } | { ok: false; error: string } {
  const row = db.prepare(`SELECT * FROM handoff_returns WHERE id = ?`).get(id) as ReturnRow | undefined;
  if (!row) return { ok: false, error: 'That return package no longer exists.' };
  if (row.status === 'sent') return { ok: false, error: `Version ${row.version} was already sent to the original chat.` };
  const latest = listReturns(db, row.child_id).at(-1)!;
  if (latest.id !== row.id) return { ok: false, error: `Version ${latest.version} is newer; send that one instead.` };
  const r = db.prepare(`UPDATE handoff_returns SET status = 'sent', sent_at = ?, message = ? WHERE id = ? AND status = 'draft'`).run(new Date().toISOString(), message, id);
  if (r.changes !== 1) return { ok: false, error: `Version ${row.version} was already sent to the original chat.` };
  return { ok: true, row };
}

/** Puts a version back to draft when sending it failed. */
export function unclaim(db: DB, id: number): void {
  db.prepare(`UPDATE handoff_returns SET status = 'draft', sent_at = NULL WHERE id = ?`).run(id);
}
