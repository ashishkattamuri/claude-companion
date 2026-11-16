import type { ReturnPackage } from './api.js';

export type Section = 'outcome' | 'remaining' | 'changes' | 'decisions' | 'verification' | 'concerns' | 'suggestion';
export const SECTIONS: Section[] = ['outcome', 'remaining', 'changes', 'decisions', 'verification', 'concerns', 'suggestion'];

type Body = Pick<ReturnPackage, 'childTitle' | 'outcome' | 'remaining' | 'changes' | 'workspace' | 'decisions' | 'verification' | 'concerns' | 'suggestion'> & {
  version: number;
};

/** The message the parent gets, from the sections you keep. You can edit it before it's sent. */
export function composeMessage(pkg: Body, keep: Section[] = SECTIONS): string {
  const on = new Set(keep);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const out: string[] = [`Back from the chat "${pkg.childTitle}" (return package v${pkg.version}).`];
  if (on.has('outcome'))
    out.push(pkg.outcome ? `Outcome, in the child's own words (a claim, not verified):\n${clip(pkg.outcome.text.trim(), 1500)}` : 'Outcome: the child has not replied yet.');
  if (on.has('remaining') && pkg.remaining.length) out.push(`Still to do:\n${pkg.remaining.map((r) => `- ${r}`).join('\n')}`);
  if (on.has('changes'))
    out.push(
      pkg.changes.length
        ? `Changes (${pkg.workspace.same ? 'already in this folder' : `in ${pkg.workspace.child}, not merged into this folder`}):\n${pkg.changes.map((c) => `- ${c.path} +${c.added} −${c.removed}`).join('\n')}`
        : 'Changes: none.',
    );
  if (on.has('decisions') && pkg.decisions.length) out.push(`What the child said as it made them:\n${pkg.decisions.map((d) => `- ${clip(d.text.replace(/\s+/g, ' '), 200)}`).join('\n')}`);
  if (on.has('verification')) {
    const fresh = pkg.verification.filter((v) => !v.stale);
    out.push(
      fresh.length
        ? `Verification (ran after the last edit; what each covered isn't recorded):\n${fresh.map((v) => `- ${clip(v.command, 120)}: ${v.outcome}${v.summary ? ` (${v.summary})` : ''}`).join('\n')}`
        : pkg.verification.length
          ? 'Verification: not verified. Tests ran only before the last edit.'
          : 'Verification: not verified. No test or check ran.',
    );
  }
  if (on.has('concerns') && pkg.concerns.length) out.push(`Open concerns:\n${pkg.concerns.map((c) => `- ${c}`).join('\n')}`);
  if (on.has('suggestion')) out.push(`Suggested next step: ${pkg.suggestion}`);
  return out.join('\n\n');
}
