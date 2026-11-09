import { describe, expect, it } from 'vitest';
import { ConversationParser } from '../src/adapter/conversation.js';
import { toTurns } from '../src/renderer/src/turns.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', uuid, timestamp: '2026-11-08T10:00:00Z', message: { role: 'user', content }, ...extra });
const reply = (uuid: string, text: string) =>
  line({ type: 'assistant', uuid, timestamp: '2026-11-08T10:00:05Z', message: { id: uuid, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }] } });
const boundary = (uuid: string, meta: Record<string, unknown> | undefined) =>
  line({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: '2026-11-08T11:00:00Z', content: 'Conversation compacted', ...(meta ? { compactMetadata: meta } : {}) });
const summary = (parentUuid: string, text: string) => user('s1', text, { parentUuid, isCompactSummary: true, isVisibleInTranscriptOnly: true });

const LEAD =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n';

describe('compaction', () => {
  it('records the numbers, then joins the summary without its lead-in', () => {
    const p = new ConversationParser();
    p.push([user('u1', 'Fix the retries'), reply('a1', 'Done.'), boundary('c1', { trigger: 'manual', preTokens: 81248, postTokens: 11813, cumulativeDroppedTokens: 69435, durationMs: 39674 })]);
    const marker = p.all().find((i) => i.kind === 'notice' && i.compaction)!;
    expect(marker).toMatchObject({
      text: 'Compacted 81k → 12k tokens',
      compaction: { trigger: 'manual', before: 81248, after: 11813, droppedTotal: 69435, durationMs: 39674, summary: null },
    });
    expect(p.facts.compactions).toEqual({ count: 1, lastAt: '2026-11-08T11:00:00Z', droppedTotal: 69435 });
    expect(p.facts.contextTokens).toBe(11813);

    const changed = p.push([summary('c1', `${LEAD}1. Primary Request and Intent:\n   - Add retries to the webhook handler.`)]);
    expect(changed.map((i) => i.id)).toEqual(['c1']);
    expect(marker.kind === 'notice' && marker.compaction?.summary).toBe('1. Primary Request and Intent:\n   - Add retries to the webhook handler.');
    // The summary is not shown as a message from you.
    expect(p.all().filter((i) => i.kind === 'user')).toHaveLength(1);
  });

  it('adds up what several compactions dropped, and copes with older records without numbers', () => {
    const p = new ConversationParser();
    p.push([boundary('c1', undefined), boundary('c2', { trigger: 'auto', preTokens: 300_000, postTokens: 25_000 })]);
    const [first, second] = p.all().filter((i) => i.kind === 'notice');
    expect(first).toMatchObject({ text: 'Conversation compacted to free up context.', compaction: { trigger: null, before: null } });
    expect(second).toMatchObject({ compaction: { trigger: 'auto' } });
    expect(p.facts.compactions).toMatchObject({ count: 2, droppedTotal: 275_000 });
  });

  it('stands on its own between turns, where it happened', () => {
    const p = new ConversationParser();
    p.push([
      user('u1', 'First'),
      reply('a1', 'One.'),
      boundary('c1', { trigger: 'auto', preTokens: 9000, postTokens: 2000 }),
      reply('a2', 'Carrying on.'),
      user('u2', 'Second'),
      reply('a3', 'Two.'),
    ]);
    const turns = toTurns(p.all());
    expect(turns.map((t) => (t.compaction ? 'compaction' : (t.user?.text ?? 'continued')))).toEqual(['First', 'compaction', 'continued', 'Second']);
    expect(turns[0]!.answer.map((i) => i.kind)).toEqual(['assistant']);
  });
});
