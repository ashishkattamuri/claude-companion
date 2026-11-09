import { describe, expect, it } from 'vitest';
import type { Timeline, ToolStep } from '../src/analyze/audit/timeline.js';
import type { AuditView } from '../src/analyze/audit/view.js';
import { heaviest } from '../src/analyze/heavy.js';

let n = 0;
const step = (o: { name: string; input: Record<string, unknown>; tokens: number; firstCall: number; sent?: number; turn?: number; agent?: string | null }): ToolStep => {
  n++;
  return {
    index: n,
    id: `item-${n}`,
    toolUseId: `tu-${n}`,
    ts: '2026-11-08T10:00:00Z',
    agent: o.agent ?? null,
    turn: o.turn ?? 1,
    call: o.firstCall - 1,
    cwd: '/repo',
    name: o.name,
    input: o.input,
    result: { text: '', isError: false, chars: o.tokens * 4, tokens: o.tokens, sent: o.sent ?? 3, firstCall: o.firstCall },
  } as ToolStep;
};
const timeline = (steps: ToolStep[], compactions: number[] = [], turns = 3): Timeline =>
  ({
    sessionId: 's',
    calls: [],
    steps,
    messages: Array.from({ length: turns }, (_, i) => ({ id: `u${i}`, ts: '', turn: i + 1, text: '' })),
    texts: [],
    compactions,
    agents: [],
    costUsd: null,
  }) as unknown as Timeline;

describe('heaviest in context', () => {
  it('lists the biggest results since the last compaction, biggest first', () => {
    const before = step({ name: 'Read', input: { file_path: '/repo/old.log' }, tokens: 90_000, firstCall: 2 });
    const big = step({ name: 'Read', input: { file_path: '/repo/CHANGELOG.md' }, tokens: 40_000, firstCall: 6, turn: 1, sent: 5 });
    const mid = step({ name: 'Bash', input: { command: 'npm test' }, tokens: 12_000, firstCall: 8, turn: 3 });
    const tiny = step({ name: 'Grep', input: { pattern: 'retry' }, tokens: 300, firstCall: 9 });
    const sub = step({ name: 'Read', input: { file_path: '/repo/x.ts' }, tokens: 50_000, firstCall: 7, agent: 'a1' });
    const items = heaviest(timeline([before, big, mid, tiny, sub], [5]));
    expect(items.map((i) => i.label)).toEqual(['Read CHANGELOG.md', 'Bash: npm test']);
    expect(items[0]).toMatchObject({ itemId: big.id, tokens: 40_000, calls: 5, turnsAgo: 2, fix: null });
    expect(items[1]).toMatchObject({ turnsAgo: 0 });
  });

  it('keeps at most five', () => {
    const steps = Array.from({ length: 8 }, (_, i) => step({ name: 'Read', input: { file_path: `/repo/f${i}.ts` }, tokens: 2_000 + i, firstCall: 1 }));
    expect(heaviest(timeline(steps))).toHaveLength(5);
  });

  it("adds the audit's fix for a step it flagged", () => {
    const s = step({ name: 'Bash', input: { command: 'npm test' }, tokens: 30_000, firstCall: 1 });
    const audit = {
      findings: [
        { status: 'confirmed', fix: 'Pipe test output through tail -50', steps: [{ n: 1, itemId: s.id, label: '' }] },
        { status: 'rejected', fix: 'Ignore me', steps: [{ n: 1, itemId: s.id, label: '' }] },
      ],
    } as unknown as AuditView;
    expect(heaviest(timeline([s]), audit)[0]!.fix).toBe('Pipe test output through tail -50');
  });
});
