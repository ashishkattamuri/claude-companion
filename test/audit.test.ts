import { describe, expect, it } from 'vitest';
import { detect } from '../src/analyze/audit/detectors.js';
import { CATEGORIES } from '../src/analyze/audit/categories.js';
import { timelineFromLines } from '../src/analyze/audit/timeline.js';

/**
 * Builds a transcript the way Claude Code writes one: each model call is an assistant record per
 * content block with the call's usage, and tool results come back in user records. The context
 * grows by each result's size, so token attribution has something real to measure.
 */
class Session {
  lines: string[] = [];
  private n = 0;
  private ctx = 10_000;

  prompt(text: string): this {
    this.lines.push(JSON.stringify({ type: 'user', uuid: `u${++this.n}`, timestamp: this.ts(), message: { role: 'user', content: text } }));
    this.ctx += Math.ceil(text.length / 4);
    return this;
  }

  /** One model call making these tool calls; each gets `result` (string) or [text, isError]. */
  call(...tools: [string, Record<string, unknown>, string | [string, boolean]][]): this {
    const id = `msg_${++this.n}`;
    const usage = { input_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: this.ctx - 505, output_tokens: 40 };
    tools.forEach(([name, input], i) =>
      this.lines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `${id}-r${i}`,
          timestamp: this.ts(),
          cwd: '/repo',
          message: { id, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `${id}-t${i}`, name, input }], usage },
        }),
      ),
    );
    this.ctx += 40;
    tools.forEach(([, , result], i) => {
      const [text, isError] = typeof result === 'string' ? [result, false] : result;
      this.lines.push(
        JSON.stringify({
          type: 'user',
          uuid: `${id}-res${i}`,
          timestamp: this.ts(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-t${i}`, content: text, is_error: isError }] },
        }),
      );
      this.ctx += Math.ceil(text.length / 4);
    });
    return this;
  }

  reply(text = 'Done.'): this {
    const id = `msg_${++this.n}`;
    const usage = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: this.ctx - 5, output_tokens: 30 };
    this.lines.push(
      JSON.stringify({ type: 'assistant', uuid: id, timestamp: this.ts(), message: { id, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage } }),
    );
    this.ctx += 30;
    return this;
  }

  compact(): this {
    this.lines.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: `c${++this.n}`, timestamp: this.ts() }));
    this.ctx = 12_000;
    return this;
  }

  timeline() {
    return timelineFromLines('s1', this.lines);
  }

  findings() {
    return detect(this.timeline()).findings;
  }

  private ts() {
    return new Date(Date.UTC(2026, 9, 24, 10, 0, this.n)).toISOString();
  }
}

/** Categories found, leaving out dead-end trails: most fixtures read things they never use. */
const cats = (s: Session) => s.findings().map((f) => f.category).filter((c) => c !== 'M54');
const file = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');

describe('audit timeline', () => {
  it('counts a response written as several records once', () => {
    const tl = new Session()
      .prompt('Look at a and b')
      .call(['Read', { file_path: '/repo/a.ts' }, file(20)], ['Read', { file_path: '/repo/b.ts' }, file(20)])
      .reply()
      .timeline();
    expect(tl.calls).toHaveLength(2);
    expect(tl.calls[0]!.tools).toHaveLength(2);
    expect(tl.steps.map((s) => s.call)).toEqual([0, 0]);
  });

  it("measures a result's tokens from how much the next call's context grew", () => {
    const tl = new Session().prompt('Read it').call(['Read', { file_path: '/repo/a.ts' }, 'x'.repeat(8000)]).reply().timeline();
    // 8000 chars at the builder's 4 chars/token.
    expect(tl.steps[0]!.result!.tokens).toBe(2000);
  });

  it('counts how many calls carried a result, up to a /compact', () => {
    const s = new Session().prompt('Go').call(['Read', { file_path: '/repo/a.ts' }, file(10)]);
    s.call(['Bash', { command: 'ls' }, 'a.ts']).call(['Bash', { command: 'pwd' }, '/repo']).compact().reply();
    const tl = s.timeline();
    // Sent with the next two calls; the compaction drops it before the reply.
    expect(tl.steps[0]!.result!.sent).toBe(2);
    expect(tl.compactions).toEqual([3]);
  });

  it('includes subagent calls under the turn that started them', () => {
    const main = new Session().prompt('one').prompt('two').call(['Agent', { description: 'look around', prompt: 'look' }, 'found it']).reply();
    const sub = new Session().prompt('look').call(['Grep', { pattern: 'x' }, 'a.ts:1:x']).reply();
    const tl = timelineFromLines('s1', main.lines, [{ agentId: 'ag1', toolUseId: 'msg_3-t0', lines: sub.lines }]);
    const subCalls = tl.calls.filter((c) => c.agent === 'ag1');
    expect(subCalls).toHaveLength(2);
    expect(subCalls.every((c) => c.turn === 2)).toBe(true);
    expect(tl.steps.find((s) => s.agent === 'ag1')!.id).toMatch(/^agent:ag1:/);
  });

  it('numbers categories like the issue does', () => {
    expect(CATEGORIES).toHaveLength(55);
    expect(CATEGORIES.map((c) => c.id).slice(0, 3)).toEqual(['A1', 'A2', 'A3']);
    expect(CATEGORIES.find((c) => c.id === 'C17')!.group).toBe('Environment discovery');
    expect(CATEGORIES.find((c) => c.id === 'L53')!.group).toBe('Edits and files');
    expect(CATEGORIES.at(-1)!.id).toBe('M55');
  });
});

describe('audit detectors', () => {
  it('flags nothing in a clean session', () => {
    const s = new Session()
      .prompt('Fix the retry bug')
      .call(['Grep', { pattern: 'retry', path: 'src' }, 'src/pay.ts:12:retry()'])
      .call(['Read', { file_path: '/repo/src/pay.ts' }, file(40)])
      .call(['Edit', { file_path: '/repo/src/pay.ts', old_string: 'retry()', new_string: 'retry(key)' }, 'Updated'])
      .call(['Bash', { command: 'npm test' }, '12 passed'])
      .reply();
    expect(s.findings()).toEqual([]);
  });

  it('flags a file read again with no change in between (A1), but not after an edit', () => {
    const s = new Session()
      .prompt('x')
      .call(['Read', { file_path: '/repo/a.ts' }, file(50)])
      .call(['Bash', { command: 'git status' }, 'clean'])
      .call(['Read', { file_path: '/repo/a.ts', offset: 10, limit: 5 }, file(5)])
      .call(['Edit', { file_path: '/repo/a.ts', old_string: 'line 1', new_string: 'line one' }, 'Updated'])
      .call(['Bash', { command: 'npm test' }, 'ok'])
      .call(['Bash', { command: 'npm test -- a' }, 'ok'])
      .call(['Bash', { command: 'npm test -- b' }, 'ok'])
      .call(['Read', { file_path: '/repo/a.ts' }, file(50)])
      .reply();
    const a1 = s.findings().filter((f) => f.category === 'A1');
    expect(a1).toHaveLength(1);
    expect(a1[0]).toMatchObject({ steps: [0, 2], confidence: 'high' });
  });

  it('marks a re-read medium when a command that may have changed files ran in between', () => {
    const s = new Session()
      .prompt('x')
      .call(['Read', { file_path: '/repo/a.ts' }, file(50)])
      .call(['Bash', { command: 'npm run format' }, 'done'])
      .call(['Read', { file_path: '/repo/a.ts' }, file(50)])
      .reply();
    expect(s.findings().find((f) => f.category === 'A1')!.confidence).toBe('medium');
  });

  it('attributes a re-read after /compact to the compaction (B13)', () => {
    const s = new Session().prompt('x').call(['Read', { file_path: '/repo/a.ts' }, file(50)]).compact().call(['Read', { file_path: '/repo/a.ts' }, file(50)]).reply();
    expect(cats(s)).toContain('B13');
    expect(cats(s)).not.toContain('A1');
  });

  it('flags a re-read right after editing (A2)', () => {
    const s = new Session()
      .prompt('x')
      .call(['Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, 'Updated'])
      .call(['Read', { file_path: '/repo/a.ts' }, file(30)])
      .reply();
    expect(cats(s)).toEqual(['A2']);
  });

  it('flags repeated searches (A4) unless an edit could have changed the answer', () => {
    const grep = ['Grep', { pattern: 'TODO', path: 'src' }, 'src/a.ts:1:TODO'] as [string, Record<string, unknown>, string];
    expect(cats(new Session().prompt('x').call(grep).call(['Bash', { command: 'ls' }, 'src']).call(grep).reply())).toEqual(['A4']);
    const edited = new Session()
      .prompt('x')
      .call(grep)
      .call(['Edit', { file_path: '/repo/src/a.ts', old_string: 'TODO', new_string: '' }, 'Updated'])
      .call(grep)
      .reply();
    expect(cats(edited)).toEqual([]);
  });

  it('tells a failing loop (E25), a repeated check (F31) and a repeated read-only command (A6) apart', () => {
    const fail = ['Bash', { command: 'npm run build' }, ['error TS2304', true]] as [string, Record<string, unknown>, [string, boolean]];
    expect(cats(new Session().prompt('x').call(fail).call(fail).call(fail).reply())).toEqual(['E25']);
    const test = ['Bash', { command: 'npx vitest run' }, '3 passed'] as [string, Record<string, unknown>, string];
    expect(cats(new Session().prompt('x').call(test).call(test).reply())).toEqual(['F31']);
    const status = ['Bash', { command: 'git status' }, 'clean'] as [string, Record<string, unknown>, string];
    expect(cats(new Session().prompt('x').call(status).call(status).reply())).toEqual(['A6']);
  });

  it('does not count polling as repetition', () => {
    const poll = ['Bash', { command: 'gh run view 123' }, 'in_progress'] as [string, Record<string, unknown>, string];
    expect(cats(new Session().prompt('x').call(poll).call(poll).call(poll).reply())).toEqual([]);
  });

  it('flags environment probing (C17) and a wrong package manager (C18)', () => {
    const s = new Session()
      .prompt('Run the tests')
      .call(['Bash', { command: 'which pnpm' }, '/usr/local/bin/pnpm'])
      .call(['Bash', { command: 'node --version' }, 'v22.1.0'])
      .call(['Bash', { command: 'npm test' }, ['This project is configured to use pnpm', true]])
      .call(['Bash', { command: 'pnpm test' }, '12 passed'])
      .reply();
    expect(cats(s).sort()).toEqual(['C17', 'C18']);
    expect(s.findings().find((f) => f.category === 'C17')!.steps).toEqual([0, 1]);
  });

  it('flags failed edits (D20), retried denials (D22) and wrong flags (D23)', () => {
    const rm = ['Bash', { command: 'rm -rf build' }, ["The user doesn't want to proceed with this tool use.", true]] as [string, Record<string, unknown>, [string, boolean]];
    const s = new Session()
      .prompt('x')
      .call(['Edit', { file_path: '/repo/a.ts', old_string: 'nope', new_string: 'y' }, ['<tool_use_error>String to replace not found in file.</tool_use_error>', true]])
      .call(rm)
      .call(rm)
      .call(['Bash', { command: 'grep --recursivee x .' }, ['grep: unrecognized option', true]])
      .reply();
    expect(cats(s).sort()).toEqual(['D20', 'D22', 'D23']);
  });

  it('flags an edit that a later edit undid (E27)', () => {
    const s = new Session()
      .prompt('x')
      .call(['Edit', { file_path: '/repo/a.ts', old_string: 'a()', new_string: 'b()' }, 'Updated'])
      .call(['Edit', { file_path: '/repo/a.ts', old_string: 'b()', new_string: 'a()' }, 'Updated'])
      .reply();
    expect(cats(s)).toEqual(['E27']);
  });

  it('flags huge command output (G33) and counts only the part above a reasonable size', () => {
    const s = new Session().prompt('x').call(['Bash', { command: 'npm install' }, 'x'.repeat(40_000)]).reply().reply();
    const g = s.findings().find((f) => f.category === 'G33')!;
    // 10k tokens, 2k kept, sent to two calls.
    expect(g.tokens).toBe(16_000);
    expect(g.cause).toMatch(/hook/);
  });

  it('treats viewing source as reading, not noisy output, and keeps it out of the headline total', () => {
    const r = detect(new Session().prompt('x').call(['Bash', { command: 'cat src/a.ts src/b.ts' }, 'x'.repeat(40_000)]).reply().timeline());
    expect(r.findings.filter((f) => f.category !== 'M54')).toMatchObject([{ category: 'A8', confidence: 'low' }]);
    expect(r.wasted.tokens).toBe(0);
    expect(r.toReview.tokens).toBeGreaterThan(0);
  });

  it("doesn't treat answering a question as a denied call", () => {
    const ask = ['AskUserQuestion', { questions: [{ question: 'Which?' }] }, ["The user doesn't want to proceed with this tool use.", true]] as [
      string,
      Record<string, unknown>,
      [string, boolean],
    ];
    expect(cats(new Session().prompt('x').call(ask).call(ask).reply())).toEqual([]);
  });

  it('flags independent reads made one call at a time (I41)', () => {
    const s = new Session()
      .prompt('x')
      .call(['Read', { file_path: '/repo/a.ts' }, file(5)])
      .call(['Read', { file_path: '/repo/b.ts' }, file(5)])
      .call(['Read', { file_path: '/repo/c.ts' }, file(5)])
      .reply();
    expect(s.findings().find((f) => f.category === 'I41')!.steps).toEqual([0, 1, 2]);
  });

  it('flags a search for a path that was already known (A5)', () => {
    const s = new Session()
      .prompt('The bug is in src/billing/invoice.ts')
      .call(['Glob', { pattern: '**/invoice.ts' }, 'src/billing/invoice.ts'])
      .reply();
    expect(cats(s)).toEqual(['A5']);
  });

  it('flags a trail of lookups whose results were never used (M54)', () => {
    const s = new Session()
      .prompt('Fix the retry bug in pay.ts')
      .call(['Grep', { pattern: 'legacyRetry', path: 'src' }, 'src/old/legacyRetry.ts:4:export function legacyRetry()'])
      .call(['Read', { file_path: '/repo/src/old/legacyRetry.ts' }, 'export function legacyRetry() { return backoffV1(3) }'])
      .call(['Read', { file_path: '/repo/src/old/backoffV1.ts' }, 'export const backoffV1 = (n) => n * 200'])
      .call(['Read', { file_path: '/repo/src/pay.ts' }, 'function charge() { retryOnce() }'])
      .call(['Edit', { file_path: '/repo/src/pay.ts', old_string: 'retryOnce()', new_string: 'retryWithKey(idempotencyKey)' }, 'Updated'])
      .reply('Switched charge() to retryWithKey.');
    const dead = s.findings().filter((f) => f.category === 'M54');
    expect(dead).toHaveLength(1);
    // The grep only led to the old files, which led nowhere: all three are the dead end.
    expect(dead[0]!.steps).toEqual([0, 1, 2]);
  });

  it("doesn't call a lookup a dead end when its result shows up in the reply", () => {
    const s = new Session()
      .prompt('Which release has the fix?')
      .call(['Bash', { command: 'git tag --contains dc818c1' }, 'v0.31.0\nv0.31.1'])
      .call(['WebFetch', { url: 'https://example.com/notes' }, 'Release v0.31.0 fixed the parser_harmony crash'])
      .reply('It shipped in v0.31.0 (parser_harmony crash fix).');
    expect(s.findings().filter((f) => f.category === 'M54')).toEqual([]);
  });

  it('flags code rewritten right after writing it (M55) and files created and never used (L52)', () => {
    const block = 'function retry(n) {\n  for (let i = 0; i < n; i++) attempt();\n}';
    const s = new Session()
      .prompt('x')
      .call(['Edit', { file_path: '/repo/a.ts', old_string: 'retry()', new_string: block }, 'Updated'])
      .call(['Edit', { file_path: '/repo/a.ts', old_string: block, new_string: 'const retry = withBackoff(attempt)' }, 'Updated'])
      .call(['Write', { file_path: '/repo/tmp_probe.py', content: 'print(1)' }, 'File created successfully at: /repo/tmp_probe.py'])
      .reply();
    expect(cats(s).sort()).toEqual(['L52', 'M55']);
    expect(s.findings().find((f) => f.category === 'M55')!.steps).toEqual([0, 1]);
  });

  it("doesn't count new source files or looking at images as waste", () => {
    const s = new Session()
      .prompt('x')
      .call(['Write', { file_path: '/repo/src/store/db.ts', content: 'export {}' }, 'File created successfully at: /repo/src/store/db.ts'])
      .call(['Read', { file_path: '/repo/shots/home.png' }, '[image]'])
      .call(['Read', { file_path: '/repo/shots/detail.png' }, '[image]'])
      .reply('Looks right.');
    expect(s.findings()).toEqual([]);
  });

  it('flags todo items dropped after work (H36), list churn (H38) and work outside the plan (H37)', () => {
    const todos = (...items: [string, string][]) => ({ todos: items.map(([content, status]) => ({ content, status, activeForm: content })) });
    const s = new Session()
      .prompt('x')
      .call(['TodoWrite', todos(['Add Redis cache', 'in_progress'], ['Write tests', 'pending']), 'ok'])
      .call(['Read', { file_path: '/repo/cache.ts' }, 'export const cacheClient = null'])
      .call(['Edit', { file_path: '/repo/cache.ts', old_string: 'null', new_string: 'createClient()' }, 'Updated'])
      .call(['TodoWrite', todos(['Write tests', 'pending'], ['Use an in-memory LRU', 'pending']), 'ok'])
      .call(['Edit', { file_path: '/repo/lru.ts', old_string: 'a', new_string: 'b' }, 'Updated'])
      .call(['TodoWrite', todos(['Use an in-memory LRU', 'pending'], ['Write tests', 'pending'], ['Benchmark', 'pending']), 'ok'])
      .call(['TodoWrite', todos(['Benchmark', 'pending'], ['Use an in-memory LRU', 'pending']), 'ok'])
      .reply();
    const f = s.findings();
    expect(f.find((x) => x.category === 'H36')!.title).toMatch(/add redis cache/);
    expect(f.find((x) => x.category === 'H38')).toMatchObject({ steps: [0, 3, 5, 6], title: expect.stringMatching(/3 times/) });
    expect(f.find((x) => x.category === 'H37')!.steps).toEqual([4]);
  });

  it('compares the files an approved plan named with the files edited', () => {
    const s = new Session()
      .prompt('x')
      .call(['ExitPlanMode', { plan: '1. Change src/pay.ts\n2. Add test/pay.test.ts\n3. Update src/config.ts' }, 'User has approved your plan.'])
      .call(['Edit', { file_path: '/repo/src/pay.ts', old_string: 'a', new_string: 'b' }, 'Updated'])
      .call(['Edit', { file_path: '/repo/src/server.ts', old_string: 'a', new_string: 'b' }, 'Updated'])
      .reply();
    const f = s.findings();
    expect(f.find((x) => x.category === 'H36')!.title).toMatch(/pay\.test\.ts, config\.ts/);
    expect(f.find((x) => x.category === 'H37')!.title).toMatch(/server\.ts/);
  });

  it('points the review at turns spent mostly looking around', () => {
    const s = new Session().prompt('Find where retries happen');
    for (let i = 0; i < 16; i++) s.call(['Read', { file_path: `/repo/src/m${i}.ts` }, `export const m${i}Value = ${i}`]);
    s.call(['Edit', { file_path: '/repo/src/m1.ts', old_string: '1', new_string: '2' }, 'Updated']).reply();
    s.prompt('Thanks').reply('Welcome');
    const hints = detect(s.timeline()).hints;
    expect(hints[0]).toMatchObject({ turn: 1, lookups: 16, edits: 1 });
  });

  it('counts a step flagged by two findings once in the total', () => {
    const big = ['Bash', { command: 'npm run build' }, ['x'.repeat(40_000), true]] as [string, Record<string, unknown>, [string, boolean]];
    const r = detect(new Session().prompt('x').call(big).call(big).reply().timeline());
    expect(r.findings.map((f) => f.category).sort()).toEqual(['E25', 'G33', 'G33']);
    const sum = r.findings.reduce((s, f) => s + f.tokens, 0);
    expect(r.wasted.tokens).toBeLessThan(sum);
    expect(r.wasted.share).toBeGreaterThan(0);
  });
});
