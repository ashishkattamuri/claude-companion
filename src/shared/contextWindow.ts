const M = 1_000_000;
const K200 = 200_000;

/**
 * Model ID patterns with a 1M-token window by default. Everything else is 200k.
 * Opus/Sonnet from 4.6 on, every Haiku from 5, and every Fable and Mythos model.
 */
const LONG_CONTEXT = [
  /claude-(opus|sonnet)-4-([6-9]|\d{2,})\b/,
  /claude-(opus|sonnet|haiku)-([5-9]|\d{2,})\b/,
  /claude-(fable|mythos)\b/,
];

/**
 * Context window size for a session: from its model when known, with Claude Code's
 * `[1m]` suffix honoured. Never smaller than the tokens in use, so the meter stays at or under 100%.
 */
export function contextWindowFor(model: string | null | undefined, tokens = 0): number {
  const id = (model ?? '').toLowerCase();
  const fromModel = /\[1m\]/.test(id) || LONG_CONTEXT.some((re) => re.test(id)) ? M : K200;
  return tokens > fromModel ? M : fromModel;
}
