import { describe, expect, it } from 'vitest';
import { ConversationParser } from '../src/adapter/conversation.js';
import { cacheStatus, duration, hitRatio } from '../src/shared/cache.js';
import { toTurns } from '../src/renderer/src/turns.js';

const call = (uuid: string, timestamp: string, usage: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', uuid, timestamp, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage } });

describe('prompt cache facts', () => {
  it('reads the TTL from cache writes and keeps it across turns that only read', () => {
    const p = new ConversationParser();
    expect(p.facts.cache).toBeNull();
    p.push([
      call('a1', '2026-11-08T10:00:00Z', {
        input_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 40_000,
        cache_creation: { ephemeral_1h_input_tokens: 40_000, ephemeral_5m_input_tokens: 0 },
        output_tokens: 100,
      }),
    ]);
    expect(p.facts.cache).toEqual({ at: '2026-11-08T10:00:00Z', read: 0, written: 40_000, uncached: 5, ttl: '1h' });
    p.push([call('a2', '2026-11-08T10:05:00Z', { input_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 300, output_tokens: 50 })]);
    expect(p.facts.cache).toMatchObject({ at: '2026-11-08T10:05:00Z', read: 40_000, written: 300, ttl: '1h' });
  });

  it('picks up a 5-minute cache', () => {
    const p = new ConversationParser();
    p.push([call('a1', '2026-11-08T10:00:00Z', { input_tokens: 1, cache_creation_input_tokens: 9000, cache_creation: { ephemeral_5m_input_tokens: 9000 }, output_tokens: 1 })]);
    expect(p.facts.cache?.ttl).toBe('5m');
  });

  it('leaves the TTL unknown when nothing was written yet', () => {
    const p = new ConversationParser();
    p.push([call('a1', '2026-11-08T10:00:00Z', { input_tokens: 10, output_tokens: 1 })]);
    expect(p.facts.cache?.ttl).toBeNull();
    expect(cacheStatus(p.facts.cache, Date.parse('2026-11-08T10:01:00Z'))).toBeNull();
  });
});

describe('cacheStatus', () => {
  const cache = { at: '2026-11-08T10:00:00Z', read: 90, written: 5, uncached: 5, ttl: '1h' as const };
  const at = (iso: string) => Date.parse(iso);

  it('is warm until the TTL runs out, then expired', () => {
    expect(cacheStatus(cache, at('2026-11-08T10:22:00Z'))).toEqual({ state: 'warm', leftMs: 38 * 60_000 });
    expect(cacheStatus(cache, at('2026-11-08T12:00:00Z'))).toEqual({ state: 'expired', agoMs: 60 * 60_000 });
    expect(cacheStatus({ ...cache, ttl: '5m' }, at('2026-11-08T10:06:00Z'))).toEqual({ state: 'expired', agoMs: 60_000 });
  });

  it('reports the share read from the cache', () => {
    expect(hitRatio(cache)).toBeCloseTo(0.9);
    expect(hitRatio({ ...cache, read: 0, written: 0, uncached: 0 })).toBeNull();
    expect(hitRatio(null)).toBeNull();
  });

  it('formats durations', () => {
    expect(duration(30_000)).toBe('under a minute');
    expect(duration(38 * 60_000)).toBe('38 min');
    expect(duration(72 * 60_000)).toBe('1 h 12 min');
    expect(duration(60 * 60_000)).toBe('1 h');
    expect(duration(5 * 3600_000)).toBe('5 h');
    expect(duration(3 * 86400_000)).toBe('3 days');
  });
});

describe('cache misses', () => {
  const at = (min: number) => new Date(Date.parse('2026-11-08T10:00:00Z') + min * 60_000).toISOString();
  const turn = (id: string, min: number, usage: Record<string, unknown>, model = 'claude-haiku-5-5') =>
    JSON.stringify({ type: 'assistant', uuid: `r-${id}`, timestamp: at(min), message: { id, role: 'assistant', model, content: [{ type: 'text', text: id }], usage } });
  const first = turn('m1', 0, { input_tokens: 5, cache_read_input_tokens: 14_000, cache_creation_input_tokens: 60_000, cache_creation: { ephemeral_1h_input_tokens: 60_000 }, output_tokens: 10 });
  const warm = (id: string, min: number, model?: string) => turn(id, min, { input_tokens: 5, cache_read_input_tokens: 74_000, cache_creation_input_tokens: 400, output_tokens: 10 }, model);
  const cold = (id: string, min: number, model?: string) => turn(id, min, { input_tokens: 5, cache_read_input_tokens: 14_000, cache_creation_input_tokens: 61_000, output_tokens: 10 }, model);
  const misses = (lines: string[]) => {
    const p = new ConversationParser();
    p.push(lines);
    return p.all().flatMap((i) => (i.kind === 'notice' && i.cacheMiss ? [{ reason: i.cacheMiss.reason, tokens: i.cacheMiss.tokens, text: i.text }] : []));
  };

  it('flags nothing on the first call or on calls that read the cache', () => {
    expect(misses([first, warm('m2', 2), warm('m3', 50)])).toEqual([]);
  });

  it('blames an expired cache when the gap is longer than its TTL', () => {
    const [m] = misses([first, cold('m2', 125)]);
    expect(m).toMatchObject({ reason: 'expired', tokens: 60_000 });
    expect(m!.text).toBe('Cache miss · ~60k tokens processed again at full price. The cache had expired: 2 h since the previous reply, and it lasts 1 h.');
  });

  it('does not count a big new tool result as a miss', () => {
    // Read everything the previous call cached, then wrote a 45k-token file it had just read.
    const bigResult = turn('m2', 1, { input_tokens: 5, cache_read_input_tokens: 74_000, cache_creation_input_tokens: 45_000, output_tokens: 10 });
    expect(misses([first, bigResult])).toEqual([]);
  });

  it('blames a model switch first', () => {
    const [m] = misses([first, cold('m2', 125, 'claude-sonnet-5-5')]);
    expect(m).toMatchObject({ reason: 'model' });
    expect(m!.text).toContain('(Haiku 5.5 → Sonnet 5.5)');
  });

  it('calls a fresh cache after compacting expected', () => {
    const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(3) });
    expect(misses([first, compact, cold('m2', 4)])).toMatchObject([{ reason: 'compacted' }]);
  });

  it('blames a change of tools or skills when nothing else explains it', () => {
    const delta = JSON.stringify({ type: 'attachment', uuid: 'd1', timestamp: at(3), attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__github__search'] } });
    expect(misses([first, delta, cold('m2', 4)])).toMatchObject([{ reason: 'tools' }]);
    expect(misses([first, cold('m2', 4)])).toMatchObject([{ reason: 'unknown', text: expect.stringContaining('No cause found') }]);
  });

  it('judges each call once, though it is recorded once per content block', () => {
    const second = cold('m2', 125);
    expect(misses([first, second, second.replace('"r-m2"', '"r-m2b"')])).toHaveLength(1);
  });

  it("shows a turn's misses under its message, not folded into its steps", () => {
    const p = new ConversationParser();
    p.push([first, JSON.stringify({ type: 'user', uuid: 'u2', timestamp: at(124), message: { role: 'user', content: 'Next?' } }), cold('m2', 125)]);
    const last = toTurns(p.all()).at(-1)!;
    expect(last.cacheMisses).toHaveLength(1);
    expect(last.answer.some((i) => i.kind === 'notice')).toBe(false);
  });
});
