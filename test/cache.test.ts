import { describe, expect, it } from 'vitest';
import { ConversationParser } from '../src/adapter/conversation.js';
import { cacheStatus, duration, hitRatio } from '../src/shared/cache.js';

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
    expect(duration(5 * 3600_000)).toBe('5 h');
    expect(duration(3 * 86400_000)).toBe('3 days');
  });
});
