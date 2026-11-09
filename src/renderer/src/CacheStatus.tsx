import { useEffect, useState } from 'react';
import type { SessionState } from '../../shared/api';
import { COLD_WARN_TOKENS, cacheStatus, duration, hitRatio } from '../../shared/cache';

/** The current time, updated every `ms`. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** One line under the context window: how long the cache stays warm and how much the last turn read from it. */
export function CacheLine({ state }: { state: SessionState }) {
  const now = useNow();
  const { cache } = state.facts;
  const status = cacheStatus(cache, now);
  const ratio = hitRatio(cache);
  if (!status) return null;
  const warm = status.state === 'warm';
  const busy = state.status === 'busy';
  return (
    <p
      className={`cache-line ${warm || busy ? 'warm' : 'cold'}`}
      title={`Claude Code caches this chat for ${cache!.ttl === '1h' ? 'an hour' : '5 minutes'} after each reply. While it's warm, the next message reads the conversation from the cache; once it expires, the whole conversation is processed again at full price.`}
    >
      <span className="dot" aria-hidden />
      {busy ? (
        <span>Cache in use</span>
      ) : warm ? (
        <span>
          Cache warm · <b className="tabular">{duration(status.leftMs)}</b> left
        </span>
      ) : (
        <span>Cache expired {duration(status.agoMs)} ago</span>
      )}
      {ratio !== null && (
        <span className="cache-ratio muted tabular">Last reply read {Math.floor(ratio * 100)}% of its input from the cache</span>
      )}
    </p>
  );
}

/**
 * Above the composer, once the cache has expired on a long chat: the next message reprocesses the
 * whole conversation. A hand-off starts fresh from the session notes instead.
 */
export function ColdCacheNote({ state, onHandOff }: { state: SessionState; onHandOff: () => void }) {
  const now = useNow();
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const { cache, contextTokens } = state.facts;
  const status = cacheStatus(cache, now);
  if (state.mode === 'mirror' || state.status === 'busy' || !status || status.state !== 'expired') return null;
  if (!contextTokens || contextTokens < COLD_WARN_TOKENS || dismissedAt === cache!.at) return null;
  return (
    <div className="cold-note" role="status">
      <span>
        The cache expired {duration(status.agoMs)} ago, so your next message reprocesses <b>~{k(contextTokens)} tokens</b> at full price instead of
        reading them from the cache.
      </span>
      <span className="cold-actions">
        <button className="link" onClick={onHandOff} title="Open a fresh session that picks up from this one's notes">
          Hand off to a fresh session
        </button>
        <button className="link muted" onClick={() => setDismissedAt(cache!.at)}>
          Send here anyway
        </button>
      </span>
    </div>
  );
}
