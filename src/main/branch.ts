/**
 * The background context a new chat starts with when it is opened from another one. It is given
 * to claude with --append-system-prompt, so Claude knows it but the new chat doesn't show it, and
 * --system-prompt-snapshot keeps it across resumes.
 */
export function branchContext(p: {
  parentTitle: string;
  parentId: string;
  kind: 'branch' | 'handoff';
  notes: string | null;
  recent: string;
  pins: string[];
}): string {
  const why =
    p.kind === 'handoff'
      ? 'The user handed this work off from an earlier Claude Code conversation to start fresh with a clean context.'
      : 'The user moved a topic from an earlier Claude Code conversation into this new chat to discuss it separately.';
  return [
    `${why} The earlier conversation was "${p.parentTitle}" (session ${p.parentId}).`,
    'Below is what you know from it. Treat it as background knowledge you already have: do not recap it or mention these notes unless the user asks. Answer the user\'s message in this chat directly.',
    p.notes ? `<earlier_conversation_notes>\n${p.notes}\n</earlier_conversation_notes>` : '',
    p.recent ? `<most_recent_exchanges>\nThe last messages of that conversation, word for word (they may overlap the notes):\n${p.recent}\n</most_recent_exchanges>` : '',
    p.pins.length
      ? `<pinned_files>\nThe user pinned these files as essential. Read them before relying on details about them:\n${p.pins.map((f) => `- ${f}`).join('\n')}\n</pinned_files>`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
