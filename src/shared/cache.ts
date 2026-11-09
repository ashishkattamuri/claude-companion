/**
 * The prompt cache's state for a chat, from its last model call. Each call that reads the cache
 * keeps it alive for its TTL again; once that runs out, the next message reprocesses the whole
 * conversation at the cache-write price instead of the read price.
 */
import type { CacheFacts } from '../adapter/conversation.js';

export const TTL_MS: Record<'5m' | '1h', number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/** Below this, a cold resume isn't worth a warning. */
export const COLD_WARN_TOKENS = 30_000;

export type CacheStatus = { state: 'warm'; leftMs: number } | { state: 'expired'; agoMs: number };

/** Warm with time left, expired for how long, or null when the TTL isn't known yet. */
export function cacheStatus(cache: CacheFacts | null, now: number): CacheStatus | null {
  if (!cache?.ttl) return null;
  const at = Date.parse(cache.at);
  if (Number.isNaN(at)) return null;
  const left = at + TTL_MS[cache.ttl] - now;
  return left > 0 ? { state: 'warm', leftMs: left } : { state: 'expired', agoMs: -left };
}

/** Share of the last call's input read from the cache, 0–1; null when there was no input. */
export function hitRatio(cache: CacheFacts | null): number | null {
  if (!cache) return null;
  const total = cache.read + cache.written + cache.uncached;
  return total > 0 ? cache.read / total : null;
}

/** 1500 → "1.5k", 142000 → "142k", 1200000 → "1.2M". */
export const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));

/** For a confirmation: what a change of tools costs the running chats, or '' when it reaches none. */
export function cacheImpactText(impact: { chats: { title: string; tokens: number }[]; total: number }): string {
  const { chats, total } = impact;
  if (!chats.length) return '';
  const which = chats.length === 1 ? '1 running chat' : `${chats.length} running chats`;
  const list = chats.map((c) => `• ${c.title}: ~${tokens(c.tokens)}`).join('\n');
  return (
    `\n\nIt also changes the tools in ${which} right away, so ${chats.length === 1 ? 'its' : 'each one’s'} next message processes the whole ` +
    `conversation again at full price instead of reading it from the cache (~${tokens(total)} tokens${chats.length === 1 ? '' : ' in all'}):\n${list}`
  );
}

/** 45s → "under a minute", 38 min → "38 min", 72 min → "1 h 12 min", 5 h → "5 h", 3 days → "3 days". */
export function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 2 && min % 60) return `${h} h ${min % 60} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}
