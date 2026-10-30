import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entriesFromLines, PAGE_CHARS, searchEarlier, type EarlierChat } from '../src/analyze/earlier.js';
import type { LlmClient } from '../src/analyze/llm.js';
import { loadConfig, type Config } from '../src/config.js';
import { CompanionService } from '../src/main/service.js';
import { openDb, type DB } from '../src/store/db.js';

let t = 0;
const at = () => `2026-10-20T14:00:${String(t++ % 60).padStart(2, '0')}.000Z`;
const user = (content: unknown, extra = {}) => JSON.stringify({ type: 'user', uuid: `u${t}`, sessionId: 's', timestamp: at(), message: { role: 'user', content }, ...extra });
const assistant = (content: unknown) => JSON.stringify({ type: 'assistant', uuid: `a${t}`, sessionId: 's', timestamp: at(), message: { role: 'assistant', content } });
const toolUse = (id: string, name: string, input: unknown) => assistant([{ type: 'tool_use', id, name, input }]);
const toolResult = (id: string, content: unknown, isError = false) => user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);

/** A session where the exact error is deep in a long tool output, past what the database keeps. */
const LONG_OUTPUT = `${'npm test output line\n'.repeat(500)}Error: connect ECONNREFUSED 127.0.0.1:6379 (REDIS_URL unset)\n${'trailing line\n'.repeat(100)}`;
const lines = () => [
  JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
  user('Why do the tests hang?'),
  assistant([{ type: 'thinking', thinking: 'let me look' }, { type: 'text', text: 'Let me run them.' }]),
  toolUse('t1', 'Bash', { command: 'npm test', description: 'Run the tests' }),
  toolResult('t1', LONG_OUTPUT, true),
  user('<system-reminder>harness text</system-reminder>'),
  user('ignored', { isMeta: true }),
  assistant([{ type: 'text', text: 'sidechain' }]).replace('"type":"assistant"', '"type":"assistant","isSidechain":true'),
  assistant([{ type: 'text', text: 'The tests need REDIS_URL set; we ruled out the retry middleware because it broke idempotency.' }]),
  user('Benchmark the cache'),
  toolUse('t2', 'Bash', { command: 'npm run bench' }),
  toolResult('t2', [{ type: 'text', text: 'p50 12ms p99 48ms' }]),
];

const chat = (relation = 'parent', id = 'parent-id'): EarlierChat => ({ id, title: 'Debug tests', relation, entries: entriesFromLines(lines()) });

describe('reading an earlier conversation', () => {
  it('keeps messages, tool calls and full tool output, and skips harness text, thinking and subagents', () => {
    const es = entriesFromLines(lines());
    expect(es.map((e) => [e.n, e.turn, e.role, e.tool])).toEqual([
      [1, 1, 'user', null],
      [2, 1, 'assistant', null],
      [3, 1, 'tool', 'Bash'],
      [4, 1, 'result', 'Bash'],
      [5, 1, 'assistant', null],
      [6, 2, 'user', null],
      [7, 2, 'tool', 'Bash'],
      [8, 2, 'result', 'Bash'],
    ]);
    expect(es[3]!.text).toBe(LONG_OUTPUT);
    expect(es[3]!.isError).toBe(true);
    expect(JSON.parse(es[2]!.text)).toEqual({ command: 'npm test', description: 'Run the tests' });
  });
});

describe('searching it', () => {
  it('finds an exact error deep in a tool output, word for word, with the steps around it', () => {
    const out = searchEarlier([chat()], { query: 'ECONNREFUSED' });
    expect(out).toContain('1 step matching "ECONNREFUSED" in the parent chat "Debug tests" (chat: parent-id)');
    expect(out).toContain('Error: connect ECONNREFUSED 127.0.0.1:6379 (REDIS_URL unset)');
    expect(out).toMatch(/\[#4 · 2026-10-20 14:00 · result of Bash \(error\)\] …\(\d+ chars before\)/);
    expect(out).toContain('[#3 · 2026-10-20 14:00 · tool call Bash] {"command":"npm test"');
    expect(out).toContain('[#5 · 2026-10-20 14:00 · Claude] The tests need REDIS_URL');
    expect(out.length).toBeLessThan(PAGE_CHARS + 400);
  });

  it('takes regular expressions, and falls back to all words when a phrase finds nothing', () => {
    expect(searchEarlier([chat()], { query: 'p\\d\\d \\d+ms' })).toContain('p50 12ms p99 48ms');
    expect(searchEarlier([chat()], { query: '/P99/' })).toContain('#8');
    expect(searchEarlier([chat()], { query: 'idempotency retry' })).toContain('ruled out the retry middleware');
    expect(searchEarlier([chat()], { query: 'unbalanced (' })).toContain('0 steps matching');
  });

  it('says so when nothing matches', () => {
    expect(searchEarlier([chat()], { query: 'kubernetes' })).toMatch(/^0 steps matching "kubernetes".*call with no query for an outline/);
  });

  it('outlines the conversation when called with no query', () => {
    const out = searchEarlier([chat()], {});
    expect(out).toContain('Turn 1 · #1–#5 · 2026-10-20 14:00 · "Why do the tests hang?" · tools: Bash');
    expect(out).toContain('Turn 2 · #6–#8 · 2026-10-20 14:00 · "Benchmark the cache" · tools: Bash');
  });

  it('reads the steps around one in full, paging through long ones', () => {
    const first = searchEarlier([chat()], { around: 4 });
    expect(first).toContain('Steps around #4 of the parent chat');
    expect(first).toContain('For more, call again with page: 2.');
    expect(first).toContain('[#1 · 2026-10-20 14:00 · user] Why do the tests hang?');
    const pages = [first];
    while (pages.at(-1)!.includes('For more')) pages.push(searchEarlier([chat()], { around: 4, page: pages.length + 1 }));
    expect(pages.every((p) => p.length < PAGE_CHARS + 400)).toBe(true);
    const all = pages.join('\n');
    expect(all).toMatch(/\[#4 · .* · result of Bash \(error\)\] \(chars 1–7800 of \d+\) npm test output line/);
    expect(all).toContain('ECONNREFUSED 127.0.0.1:6379');
    expect(all).toContain('[#7 · 2026-10-20 14:00 · tool call Bash] {"command":"npm run bench"}');
    expect(searchEarlier([chat()], { around: 99 })).toContain('There is no step #99; steps go from #1 to #8.');
  });

  it('labels results by chat when searching several', () => {
    const out = searchEarlier([chat(), chat('grandparent', 'gp-id')], { query: 'p50' });
    expect(out).toContain('2 steps matching "p50"');
    expect(out).toContain('[parent #8 ·');
    expect(out).toContain('[grandparent #8 ·');
    expect(out).toContain('and chat: <id>');
  });
});

describe('which conversations a chat can search', () => {
  let root: string;
  let cfg: Config;
  let db: DB;
  let svc: CompanionService;
  const write = (id: string, body: string[]) => writeFileSync(join(root, 'claude', 'projects', '-work-app', `${id}.jsonl`), `${body.join('\n')}\n`);
  const link = (child: string, parent: string, kind: string) =>
    db.prepare(`INSERT INTO session_links(child_id, parent_id, title, kind, created_at) VALUES (?, ?, 't', ?, ?)`).run(child, parent, kind, at());
  const ask = (sessionId: string, params: Record<string, unknown> = {}) =>
    svc.handleSocket({ method: 'search_earlier', params: { claudePid: 1, sessionId, ...params } });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'companion-earlier-'));
    mkdirSync(join(root, 'claude', 'projects', '-work-app'), { recursive: true });
    const config = join(root, 'config.toml');
    writeFileSync(config, `[sources]\nclaude_dir = "${join(root, 'claude')}"\n[data]\ndir = "${join(root, 'data')}"\n`);
    cfg = loadConfig(config);
    db = openDb(cfg.dbPath);
    svc = new CompanionService({ db, cfg, llm: {} as LlmClient, loadLive: () => [], env: () => ({}), analysis: false, notes: false });
    // grandparent → parent (branch) → child (hand-off) → child copy (restart); and an unrelated chat.
    write('gp', [user('Codename is ORCA-9')]);
    write('parent', [user('The TTL is 300 seconds')]);
    write('child', [user('Continue please')]);
    write('copy', [user('Continue please')]);
    write('other', [user('Secret from another chat')]);
    link('parent', 'gp', 'branch');
    link('child', 'parent', 'handoff');
    link('copy', 'child', 'restart');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('searches the parent by default, going past restarts', async () => {
    const r = await ask('copy', { query: 'TTL' });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toContain('The TTL is 300 seconds');
    expect(r.ok && r.message).not.toContain('ORCA-9');
    expect(await ask('copy', { query: 'ORCA' })).toMatchObject({ ok: true, message: expect.stringContaining('0 steps matching') });
  });

  it('searches up through grandparents with lineage scope', async () => {
    const r = await ask('child', { query: 'ORCA|TTL', scope: 'lineage' });
    expect(r.ok && r.message).toContain('2 steps matching');
    expect(r.ok && r.message).toContain('[grandparent #1 · 2026-10-20 14:00 · user] Codename is ORCA-9');
    const around = await ask('child', { around: 1, chat: 'gp' });
    expect(around.ok && around.message).toContain('Steps around #1 of the grandparent chat');
  });

  it('never reads chats outside the lineage', async () => {
    expect(await ask('child', { around: 1, chat: 'other' })).toEqual({ ok: false, error: 'Chat other is not one this chat was opened from.' });
    expect(await ask('other', { query: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('not opened from another chat') });
    expect(await ask('gp', { query: 'x' })).toMatchObject({ ok: false });
  });
});
