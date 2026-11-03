import { describe, expect, it } from 'vitest';
import { contextWindowFor } from '../src/shared/contextWindow.js';

describe('contextWindowFor', () => {
  it('gives 1M-window models 1M from the first message', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-mythos-5-1'])
      expect(contextWindowFor(m, 52_000), m).toBe(1_000_000);
  });

  it('keeps 200k-window models at 200k', () => {
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5', 'claude-3-7-sonnet-20250219', 'some-unknown-model'])
      expect(contextWindowFor(m, 52_000), m).toBe(200_000);
  });

  it('honours the [1m] suffix', () => {
    expect(contextWindowFor('claude-sonnet-4-5[1m]', 1000)).toBe(1_000_000);
  });

  it('falls back to 1M when usage is past 200k, and to 200k with no model', () => {
    expect(contextWindowFor('claude-sonnet-4-5', 250_000)).toBe(1_000_000);
    expect(contextWindowFor(null, 250_000)).toBe(1_000_000);
    expect(contextWindowFor(null)).toBe(200_000);
  });
});
