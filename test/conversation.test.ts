import { describe, expect, it } from 'vitest';
import { ConversationParser } from '../src/adapter/conversation.js';
import { detectPrompt } from '../src/main/screen.js';
import { describeTool, summarizeSteps, toTurns } from '../src/renderer/src/turns.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', uuid, timestamp: '2026-10-02T10:00:00Z', message: { role: 'user', content }, ...extra });
const assistant = (uuid: string, block: Record<string, unknown>, usage?: Record<string, number>) =>
  line({ type: 'assistant', uuid, timestamp: '2026-10-02T10:00:01Z', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [block], usage } });

describe('ConversationParser', () => {
  it('turns transcript records into messages, tool calls and results', () => {
    const p = new ConversationParser();
    p.push([
      line({ type: 'permission-mode', permissionMode: 'default' }),
      user('u1', 'Add a hook installer'),
      assistant('a1', { type: 'thinking', thinking: 'Let me look.' }),
      assistant('a2', { type: 'text', text: "I'll check the config." }),
      assistant('a3', { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' } }, {
        input_tokens: 10,
        cache_read_input_tokens: 30000,
        cache_creation_input_tokens: 2000,
        output_tokens: 90,
      }),
    ]);
    const tool = p.all().find((i) => i.kind === 'tool')!;
    expect(tool).toMatchObject({ name: 'Edit', result: null });

    const changed = p.push([
      user('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Updated a.ts' }], {
        toolUseResult: { structuredPatch: [{ oldStart: 3, newStart: 3, lines: ['-x', '+y'] }] },
      }),
      assistant('a4', { type: 'text', text: 'Done.' }),
      line({ type: 'cost-state', totalCostUSD: 0.12 }),
    ]);
    // The tool call is re-emitted with its result, not added as a new item.
    expect(changed.map((c) => c.id)).toEqual(['a3', 'a4']);
    expect(p.all().map((i) => i.kind)).toEqual(['user', 'thinking', 'assistant', 'tool', 'assistant']);
    expect(tool).toMatchObject({ result: { text: 'Updated a.ts', isError: false, patch: [{ lines: ['-x', '+y'] }] } });
    expect(p.facts).toMatchObject({ model: 'claude-haiku-4-5', permissionMode: 'default', contextTokens: 32100, costUsd: 0.12 });
  });

  it('hides harness messages, shows slash commands, interruptions and compaction as notices', () => {
    const p = new ConversationParser();
    p.push([
      user('m1', '<system-reminder>stuff</system-reminder>'),
      user('m2', [{ type: 'text', text: '# skill body' }], { isMeta: true }),
      user('m3', '<command-name>/compact</command-name><command-args></command-args>'),
      user('m4', [{ type: 'text', text: '[Request interrupted by user]' }]),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 's1', timestamp: '' }),
      user('m5', 'summary of earlier work', { isCompactSummary: true }),
      line({ type: 'user', uuid: 'side', isSidechain: true, message: { content: 'subagent prompt' } }),
    ]);
    expect(p.all().map((i) => (i.kind === 'notice' ? i.text : i.kind))).toEqual([
      'Ran /compact',
      'You interrupted Claude.',
      'Conversation compacted to free up context.',
    ]);
  });

  it("knows whether the session has Companion's new-chat tool", () => {
    const delta = (added: string[], removed: string[] = []) =>
      line({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: added, removedNames: removed } });
    const without = new ConversationParser();
    expect(without.facts.newChatTool).toBeNull();
    without.push([delta(['WebSearch', 'mcp__other__x'])]);
    expect(without.facts.newChatTool).toBe(false);

    const withTool = new ConversationParser();
    withTool.push([delta(['WebSearch']), delta(['mcp__companion__start_new_chat'])]);
    expect(withTool.facts.newChatTool).toBe(true);
    withTool.push([delta([], ['mcp__companion__start_new_chat'])]);
    expect(withTool.facts.newChatTool).toBe(false);
  });

  it('records the latest todo list for the side panel', () => {
    const p = new ConversationParser();
    const todos = [{ content: 'Write tests', status: 'in_progress' }];
    p.push([
      assistant('a1', { type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos } }),
      user('u1', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
    ]);
    expect(p.facts.todos).toEqual(todos);
  });
});

// Screens captured from Claude Code 2.1.286/287 running in a pseudo-terminal.
const PERMISSION_SCREEN = `
❯ Use the Bash tool to run exactly: mkdir -p /tmp/companion-probe-dir
⏺ Creating directory and listing entries
  ⎿  $ mkdir -p /tmp/companion-probe-dir
──────────────────────────────────────────────────────────────
 Bash command
 Create directory and list entries
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 mkdir -p /tmp/companion-probe-dir
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and allow access to /tmp and mkdir -p /tmp/companion-probe-dir commands
   3. No
 Esc to cancel · Tab to amend`.split('\n');

const TRUST_SCREEN = `
 Accessing workspace:
 /Users/me/workspace/personal/claude-companion
 Quick safety check: Is this a project you created or one you trust?
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`.split('\n');

// Claude Code 2.1.304: AskUserQuestion with several questions, on the second one.
const QUESTION_SCREEN = `
❯ Help me plan Thanksgiving this year with the baby.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Baby's age  ☐ Setup  ☐ Group size  ✔ Submit  →

Where will you spend Thanksgiving?

❯ 1. Hosting at home
     Guests come to us
  2. Driving to family
     Road trip, possibly overnight
  3. Flying to family
     Air travel with the baby
  4. Not decided yet
     Help me pick
  5. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.split('\n');

describe('detectPrompt', () => {
  it('reads a permission dialog with its options', () => {
    expect(detectPrompt(PERMISSION_SCREEN)).toEqual({
      kind: 'permission',
      question: 'Do you want to proceed?',
      header: 'Bash command',
      options: [
        { key: '1', label: 'Yes', selected: true },
        { key: '2', label: 'Yes, and allow access to /tmp and mkdir -p /tmp/companion-probe-dir commands', selected: false },
        { key: '3', label: 'No', selected: false },
      ],
    });
  });

  it('reads the folder trust dialog and which option is highlighted', () => {
    expect(detectPrompt(TRUST_SCREEN)).toMatchObject({ kind: 'trust', yesSelected: false });
    const moved = TRUST_SCREEN.map((l) => l.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust'));
    expect(detectPrompt(moved)).toMatchObject({ kind: 'trust', yesSelected: true });
  });

  it('reads a question Claude asks, with option descriptions in between', () => {
    expect(detectPrompt(QUESTION_SCREEN)).toMatchObject({
      kind: 'choice',
      question: 'Where will you spend Thanksgiving?',
      options: [
        { key: '1', label: 'Hosting at home', selected: true },
        { key: '2', label: 'Driving to family', selected: false },
        { key: '3', label: 'Flying to family', selected: false },
        { key: '4', label: 'Not decided yet', selected: false },
        { key: '5', label: 'Type something.', selected: false },
        { key: '6', label: 'Chat about this', selected: false },
      ],
    });
  });

  it('ignores a numbered list that does not count down to 1', () => {
    expect(detectPrompt(['Steps:', '  2. Build', '     then', '  3. Ship'])).toBeNull();
  });

  it('finds nothing on an ordinary screen', () => {
    expect(detectPrompt(['⏺ Done.', '', '❯ ', '  Haiku 4.5 | 📁 claude-companion'])).toBeNull();
  });
});

describe('turns', () => {
  it('groups tool calls into steps and keeps the final answer separate', () => {
    const p = new ConversationParser();
    p.push([
      user('u1', 'Fix it'),
      assistant('a1', { type: 'text', text: 'Looking.' }),
      assistant('a2', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }),
      user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: '42 passed' }]),
      assistant('a3', { type: 'text', text: 'All green.' }),
      user('u2', 'Thanks'),
      assistant('a4', { type: 'text', text: 'Anytime.' }),
    ]);
    const [first, second] = toTurns(p.all());
    expect(first!.steps.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(first!.answer.map((s) => s.id)).toEqual(['a3']);
    expect(second!.steps).toEqual([]);
    expect(second!.answer.map((s) => s.id)).toEqual(['a4']);
  });

  it('names new chats in a step summary and leaves tool lookups out', () => {
    const p = new ConversationParser();
    p.push([
      assistant('a1', { type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'new chat' } }),
      assistant('a2', { type: 'tool_use', id: 't2', name: 'mcp__companion__start_new_chat', input: { title: 'Caching', prompt: 'p' } }),
    ]);
    expect(summarizeSteps(p.all())).toBe('opened a new chat');
    const tool = p.all()[1] as Extract<ReturnType<ConversationParser['all']>[number], { kind: 'tool' }>;
    expect(describeTool(tool, null)).toMatchObject({ verb: 'Opening a new chat', target: 'Caching' });
  });

  it('describes tool calls in plain words, with paths relative to the project', () => {
    const p = new ConversationParser();
    p.push([assistant('a', { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/repo/src/cli.ts' } })]);
    const tool = p.all()[0] as Extract<ReturnType<ConversationParser['all']>[number], { kind: 'tool' }>;
    expect(describeTool(tool, '/repo')).toMatchObject({ verb: 'Reading', target: 'src/cli.ts' });
  });
});
