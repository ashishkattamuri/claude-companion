import { describe, expect, it } from 'vitest';
import { withContext } from '../src/renderer/src/newSession.js';

describe('withContext', () => {
  const ctx = { id: 'abc', title: 'side panels toggle', summary: 'Added a toggle for the side panels.', lastPrompt: 'ship it' };

  it('leaves the prompt alone without context', () => {
    expect(withContext('fix the bug', null)).toBe('fix the bug');
  });

  it('puts the earlier session ahead of the prompt', () => {
    expect(withContext('now add tests', ctx)).toBe('Context from an earlier session, "side panels toggle" (abc):\nAdded a toggle for the side panels.\n\nnow add tests');
  });

  it('falls back to the last request and works with no prompt', () => {
    expect(withContext('  ', { ...ctx, summary: null })).toBe('Context from an earlier session, "side panels toggle" (abc):\nIts last request was: ship it');
  });
});
