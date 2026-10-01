import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeLine, type MessageEvent } from '../src/adapter/normalize.js';

const lines = readFileSync(new URL('./fixtures/basic.jsonl', import.meta.url), 'utf8').trim().split('\n');
const events = lines.map(normalizeLine);
const messages = events.filter((e): e is MessageEvent => e.kind === 'message');
const byUuid = (uuid: string) => messages.find((m) => m.uuid === uuid)!;

describe('normalizeLine', () => {
  it('classifies user prompts, including text-block prompts', () => {
    expect(byUuid('u1').messageKind).toBe('prompt');
    expect(byUuid('u5')).toMatchObject({ messageKind: 'prompt', text: 'Also add a test for exponential backoff' });
  });

  it('marks harness-injected user text as meta', () => {
    expect(byUuid('u3').messageKind).toBe('meta'); // isMeta flag
    expect(byUuid('u4').messageKind).toBe('meta'); // slash-command echo
  });

  it('splits assistant blocks into thinking, text and tool_use', () => {
    expect(byUuid('a1').messageKind).toBe('thinking');
    expect(byUuid('a2')).toMatchObject({ messageKind: 'text', text: "I'll look at the handler first." });
    expect(byUuid('a3')).toMatchObject({
      messageKind: 'tool_use',
      toolName: 'Read',
      text: 'file_path: /work/demo-app/src/webhook.ts',
    });
  });

  it('truncates tool results', () => {
    const r = byUuid('u2');
    expect(r.messageKind).toBe('tool_result');
    expect(r.text.length).toBeLessThanOrEqual(513);
  });

  it('extracts titles and last prompts', () => {
    expect(events).toContainEqual(expect.objectContaining({ kind: 'title', title: 'Webhook retry logic' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'last_prompt' }));
    expect(normalizeLine(JSON.stringify({ type: 'summary', summary: 'Old title' }))).toMatchObject({
      kind: 'title',
      title: 'Old title',
    });
  });

  it("reads Claude Code's away summaries and drops the settings hint", () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'away_summary', uuid: 'w1', sessionId: 's', timestamp: '2026-09-30T10:00:00Z',
      content: 'Goal: ship retries. Next: fix the test. (disable recaps in /config)',
    });
    expect(normalizeLine(line)).toMatchObject({
      kind: 'message', role: 'system', messageKind: 'away_summary', text: 'Goal: ship retries. Next: fix the test.',
    });
    expect(normalizeLine(JSON.stringify({ type: 'system', subtype: 'turn_duration' }))).toEqual({ kind: 'ignored', type: 'system' });
  });

  it('never throws on unknown or malformed input', () => {
    expect(events).toContainEqual({ kind: 'unknown', type: 'brand-new-record-type' });
    expect(events).toContainEqual({ kind: 'invalid' });
    expect(normalizeLine('null')).toEqual({ kind: 'invalid' });
    expect(normalizeLine(JSON.stringify({ type: 'user', uuid: 'x' }))).toEqual({ kind: 'unknown', type: 'user' });
  });
});
