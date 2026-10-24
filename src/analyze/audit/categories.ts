/**
 * The kinds of waste an audit looks for. Ids are stable: findings, the review prompt, the UI and
 * per-project stats all refer to them. Detectors find some kinds mechanically; the review model
 * finds the rest and may add kinds that aren't listed.
 */
export interface Category {
  id: string;
  group: string;
  name: string;
}

const GROUPS: [string, string, string[]][] = [
  ['A', 'Redundant retrieval', [
    'Same file or range read again with no change in between',
    'File re-read right after editing it',
    'One file read in many small slices',
    'Same or near-duplicate search repeated',
    'Searched for a path that was already known',
    'Same read-only command re-run with nothing changed',
    'Same URL fetched or web search made twice',
    'Whole large file read when a search or range would do',
    'Generated, vendored or lock files read without need',
  ]],
  ['B', 'Forgotten or ignored context', [
    'Rediscovered a fact it was given at the start',
    'Rediscovered a fact found earlier in the session',
    'Asked the user something already answered',
    'Rediscovered after /compact what compaction dropped',
    'Branch or hand-off rediscovered what its parent knew',
    'Retried an approach already ruled out',
    'Ignored a stated preference, then redid the work',
  ]],
  ['C', 'Environment discovery', [
    'Probed for tools, versions or commands knowable up front',
    'Tried the wrong package manager or runner first',
    'Path or working-directory mistake',
  ]],
  ['D', 'Failed tool calls', [
    'Edit failed on stale or unread text',
    'Tool input error',
    'Retried a denied permission unchanged',
    'Command not found or wrong flags',
    'Command timed out in the foreground',
  ]],
  ['E', 'Loops and thrash', [
    'Same failing command re-run with no relevant change',
    'Fix, revert, fix again on the same lines',
    'Edited something, then undid it',
    'Tried approaches without using what the last failure showed',
  ]],
  ['F', 'Verification', [
    'Full suite run when a targeted test would do',
    'Built or tested before the edits were finished',
    'Same check run twice with nothing changed',
    'Skipped a cheap early check, causing later rework',
  ]],
  ['G', 'Output bloat', [
    'Huge command output with no filter',
    'Large tool result carried in context for many calls',
    'Printed whole files or long diffs back unasked',
  ]],
  ['H', 'Plan churn and scope', [
    'Plan item dropped after effort was spent on it',
    'Work outside the plan that the ask did not need',
    'Todo list rewritten without progress',
    'Planning effort out of proportion to the task',
    'Steps done in an order that caused rework',
  ]],
  ['I', 'Sequencing', [
    'Independent reads done one per turn instead of together',
    'Waited on something that could run in the background',
  ]],
  ['J', 'Subagents', [
    'Subagent started for a lookup one tool call would do',
    'Subagent rediscovered context the parent had',
    'Two subagents did overlapping work',
    'Parent re-read what a subagent had just reported',
  ]],
  ['K', 'Context and model use', [
    'Worked on with the context nearly full instead of compacting',
    'Compacted early or loosely and lost needed details',
    'Long extended thinking on mechanical steps',
  ]],
  ['L', 'Edits and files', [
    'Many small edits to one region that could be one',
    'Rewrote a whole file to change a few lines',
    'Scratch files created and never used or left behind',
    'Formatting-only churn mixed into real edits',
  ]],
];

// Numbered across groups, as in the issue: A1-A9, B10-B16, C17-C19, ...
export const CATEGORIES: Category[] = (() => {
  const out: Category[] = [];
  let n = 1;
  for (const [letter, group, names] of GROUPS) for (const name of names) out.push({ id: `${letter}${n++}`, group, name });
  return out;
})();

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function category(id: string): Category {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown audit category ${id}`);
  return c;
}
