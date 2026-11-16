import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest } from '../src/analyze/llm.js';
import { additiveDiff, applyEdit, checkProposals, collectEvidence, deniedPattern, isCorrection, ruleFits, type SetupTarget } from '../src/analyze/setup.js';
import { loadConfig } from '../src/config.js';
import { SetupSuggestions } from '../src/main/setup.js';
import type { SetupEvidence } from '../src/shared/api.js';
import { openDb } from '../src/store/db.js';

const now = Date.now();
const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

/** A transcript file the way Claude Code writes it. */
function session(dir: string, id: string, build: (t: ReturnType<typeof writer>) => void): string {
  const t = writer(id);
  build(t);
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, t.lines.join('\n') + '\n');
  return path;
}
function writer(id: string) {
  const lines: string[] = [];
  let n = 0;
  const push = (rec: object) => lines.push(JSON.stringify({ uuid: `${id}-${++n}`, sessionId: id, timestamp: at(100 - n), ...rec }));
  return {
    lines,
    user: (text: string) => {
      push({ type: 'user', message: { role: 'user', content: text } });
      return `${id}-${n}`;
    },
    tool: (tid: string, name: string, input: object, opts: { denied?: boolean } = {}) => {
      push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }] } });
      const step = `${id}-${n}`;
      push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: opts.denied ? "The user doesn't want to proceed with this tool use. The tool use was rejected." : 'ok', is_error: !!opts.denied }] },
      });
      return step;
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const s1 = session(dir, 's1', (t) => {
    t.user('Add a build step for the docs site please');
    t.user('Keep the generated files in dist untouched, they come from the build');
    t.tool('b1', 'Bash', { command: 'npm install marked' });
    t.user('No, use pnpm, not npm. We use pnpm in this repo.');
    t.tool('b2', 'Bash', { command: 'npm run build -- --prod' }, { denied: true });
  });
  const s2 = session(dir, 's2', (t) => {
    t.user('Fix the flaky date test');
    t.user('Generated files in dist are untouched by hand, they come from the build');
    t.user("Don't use npm here, use pnpm");
    t.tool('b3', 'Bash', { command: 'npm run build' }, { denied: true });
    t.tool('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' });
    t.tool('e2', 'Edit', { file_path: '/p/a.ts', old_string: 'b', new_string: 'a' });
  });
  const s3 = session(dir, 's3', (t) => {
    t.user('Release notes for 2.1');
    t.tool('k1', 'Skill', { skill: 'release-notes' });
    t.user('Actually it should use pnpm, not npm, for the changelog command');
  });
  return {
    dir,
    sessions: [
      { id: 's1', path: s1, title: 'Docs build' },
      { id: 's2', path: s2, title: 'Flaky test' },
      { id: 's3', path: s3, title: 'Release notes' },
    ],
  };
}

describe('evidence from sessions', () => {
  it('finds corrections, denials, restated facts, undone edits and corrected skills, each linked to its session', () => {
    const { sessions } = fixture();
    const ev = collectEvidence(sessions, at(1000));
    const kinds = (k: string) => ev.filter((e) => e.kind === k);
    expect(kinds('correction').map((e) => e.sessionId)).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
    expect(kinds('correction').filter((e) => /pnpm/.test(e.text)).map((e) => e.sessionId).sort()).toEqual(['s1', 's2', 's3']);
    expect(kinds('denied').map((e) => e.pattern)).toEqual(['Bash(npm run build:*)', 'Bash(npm run build:*)']);
    expect(kinds('reverted').map((e) => e.sessionId)).toEqual(['s2']);
    expect(kinds('skill')).toMatchObject([{ sessionId: 's3', pattern: 'release-notes' }]);
    expect(kinds('repeated').map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
    expect(ev.every((e) => e.itemId.startsWith(e.sessionId))).toBe(true);
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
  });

  it('reads nothing before the window', () => {
    const { sessions } = fixture();
    expect(collectEvidence(sessions, at(-5))).toEqual([]);
  });

  it('recognises how people correct Claude', () => {
    expect(isCorrection('No, use pnpm')).toBe(true);
    expect(isCorrection('use the fixture instead of a mock')).toBe(true);
    expect(isCorrection('Please add a test for the parser')).toBe(false);
    expect(deniedPattern('Bash', { command: 'git push origin main' })).toBe('Bash(git push origin:*)');
    expect(deniedPattern('WebFetch', { url: 'https://x.dev' })).toBe('WebFetch(https://x.dev)');
  });
});

const md = (content: string): SetupTarget => ({ id: 'project-claude-md', label: 'CLAUDE.md', path: '/p/CLAUDE.md', kind: 'markdown', content });
const settings = (content: string): SetupTarget => ({ id: 'project-settings', label: 'settings', path: '/p/.claude/settings.json', kind: 'settings', content });
const ev = (over: Partial<SetupEvidence>): SetupEvidence => ({ id: 1, kind: 'correction', sessionId: 's1', sessionTitle: 't', itemId: 'i', ts: at(1), text: 'x', pattern: null, ...over });

describe('proposals', () => {
  const evidence = [ev({ id: 1 }), ev({ id: 2, sessionId: 's2' }), ev({ id: 3, kind: 'denied', pattern: 'Bash(npm run build:*)' })];
  const s = (over: object) => ({ target: 'project-claude-md', kind: 'append' as const, anchor: '', text: 'Use pnpm, not npm.', why: 'w', evidence: [1, 2], match: ['pnpm'], ...over });

  it('keeps additive edits to known files that rest on real evidence', () => {
    const kept = checkProposals({ suggestions: [s({})] }, [md('# Project\n\nUse TypeScript.\n')], evidence, []);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.diff).toContain('+Use pnpm, not npm.');
    expect(kept[0]!.diff.split('\n').some((l) => l.startsWith('-') && l.slice(1).trim())).toBe(false);
    expect(kept[0]!.evidence.map((e) => e.id)).toEqual([1, 2]);
  });

  it('drops unknown files, missing evidence, text already there, dismissed ones and broad permissions', () => {
    const targets = [md('Use pnpm, not npm.\n'), settings('{}')];
    const out = {
      suggestions: [
        s({ target: 'somewhere-else' }),
        s({ evidence: [99] }),
        s({}), // already in the file
        s({ target: 'project-settings', kind: 'allow', text: 'Bash(npm:*)', evidence: [3] }),
        s({ target: 'project-settings', kind: 'deny', text: 'Bash', evidence: [3] }),
        s({ kind: 'insert_after', anchor: 'No such line', text: 'Never edit dist/.' }),
      ],
    };
    expect(checkProposals(out, targets, evidence, [])).toEqual([]);
    const fresh = [md('# P\n')];
    const once = checkProposals({ suggestions: [s({ text: 'Never edit dist by hand.' })] }, fresh, evidence, []);
    expect(checkProposals({ suggestions: [s({ text: 'Never edit dist by hand!' })] }, fresh, evidence, [{ key: once[0]!.key, text: 'Never edit dist by hand.', target: '/p/CLAUDE.md' }])).toEqual([]);
  });

  it('adds permission rules no wider than what was denied', () => {
    expect(ruleFits('Bash(npm run build:*)', [evidence[2]!])).toBe(true);
    expect(ruleFits('Bash(npm run build -- --prod)', [evidence[2]!])).toBe(true);
    expect(ruleFits('Bash(npm:*)', [evidence[2]!])).toBe(false);
    expect(ruleFits('Bash(npm run *:*)', [evidence[2]!])).toBe(false);
    const kept = checkProposals({ suggestions: [s({ target: 'project-settings', kind: 'deny', text: 'Bash(npm run build:*)', evidence: [3] })] }, [settings('{\n  "model": "opus"\n}\n')], evidence, []);
    expect(kept).toHaveLength(1);
    expect(JSON.parse(applyEdit('{"model":"opus"}', 'settings', 'deny', 'Bash(npm run build:*)', null)!)).toEqual({ model: 'opus', permissions: { deny: ['Bash(npm run build:*)'] } });
  });

  it('inserts after an anchor line, and never changes existing lines', () => {
    const after = applyEdit('# P\n## Tools\nUse vitest.\n', 'markdown', 'insert_after', 'Use pnpm, not npm.', '## Tools')!;
    expect(after).toBe('# P\n## Tools\nUse pnpm, not npm.\nUse vitest.\n');
    expect(additiveDiff(md('# P\n## Tools\nUse vitest.\n'), after)).not.toBeNull();
    expect(additiveDiff(md('# P\nold line\n'), '# P\nnew line\n')).toBeNull();
  });
});

/** Answers the setup call with one CLAUDE.md addition resting on every pnpm correction. */
class FakeLlm implements LlmClient {
  calls = 0;
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls++;
    const ids = [...req.prompt.matchAll(/^#(\d+) correction .*pnpm/gm)].map((m) => Number(m[1]));
    return { suggestions: [{ target: 'project-claude-md', kind: 'append', anchor: '', text: 'Use pnpm, not npm.', why: 'You corrected npm to pnpm in three sessions.', evidence: ids, match: ['pnpm'] }] } as T;
  }
}

function setupService(optOut: string[] = []) {
  const { dir, sessions } = fixture();
  const root = mkdtempSync(join(tmpdir(), 'setup-svc-'));
  const project = join(root, 'proj');
  mkdirSync(project);
  writeFileSync(join(project, 'CLAUDE.md'), '# Proj\n\nUse TypeScript.\n');
  const cfgPath = join(root, 'config.toml');
  writeFileSync(cfgPath, `[sources]\nclaude_dir = "${join(root, 'claude')}"\nopt_out = ${JSON.stringify(optOut.map((o) => o.replace('$PROJECT', project)))}\n`);
  const cfg = loadConfig(cfgPath);
  const db = openDb(join(root, 'db.sqlite'));
  db.prepare(`INSERT INTO projects(id, cwd, name) VALUES (1, ?, 'proj')`).run(project);
  for (const s of sessions)
    db.prepare(`INSERT INTO sessions(id, project_id, cwd, title, first_ts, last_ts, source_path) VALUES (?, 1, ?, ?, ?, ?, ?)`).run(s.id, project, s.title, at(200), at(1), s.path);
  const llm = new FakeLlm();
  return { svc: new SetupSuggestions({ db, cfg, llm, onChanged: () => {} }), llm, project, dir };
}

describe('setup suggestions', () => {
  it('suggests a CLAUDE.md addition for a correction repeated in three sessions, linked to all three', async () => {
    const { svc, project } = setupService();
    expect((await svc.review(project)).ok).toBe(true);
    const [s] = svc.view(project).suggestions;
    expect(s).toMatchObject({ targetLabel: 'CLAUDE.md (this project)', status: 'new', impact: { times: 3, sessions: 3 } });
    expect(s!.evidence.map((e) => e.sessionId).sort()).toEqual(['s1', 's2', 's3']);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('# Proj\n\nUse TypeScript.\n'); // nothing written yet
  });

  it('applies only on Apply, keeping a backup, and undoes it', async () => {
    const { svc, project } = setupService();
    await svc.review(project);
    const id = svc.view(project).suggestions[0]!.id;
    expect(svc.apply(id).ok).toBe(true);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('# Proj\n\nUse TypeScript.\n\nUse pnpm, not npm.\n');
    expect(readdirSync(project).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
    const applied = svc.view(project).suggestions[0]!;
    expect(applied.since).toEqual({ after: 0, before: 3, notWorking: false });
    expect(svc.undo(id).ok).toBe(true);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('# Proj\n\nUse TypeScript.\n');
    expect(readdirSync(project).filter((f) => f.endsWith('.bak'))).toEqual([]);
  });

  it('undoes only the added text when the file changed after applying', async () => {
    const { svc, project } = setupService();
    await svc.review(project);
    const id = svc.view(project).suggestions[0]!.id;
    svc.apply(id);
    writeFileSync(join(project, 'CLAUDE.md'), readFileSync(join(project, 'CLAUDE.md'), 'utf8') + '\nA later note.\n');
    expect(svc.undo(id).ok).toBe(true);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('# Proj\n\nUse TypeScript.\n\nA later note.\n');
  });

  it('does not bring back a dismissed suggestion on the next run', async () => {
    const { svc, project } = setupService();
    await svc.review(project);
    svc.dismiss(svc.view(project).suggestions[0]!.id);
    await svc.review(project);
    expect(svc.view(project).suggestions).toEqual([]);
  });

  it('never reads an opted-out project', async () => {
    const { svc, llm, project } = setupService(['$PROJECT']);
    const r = await svc.review(project);
    expect(r.ok).toBe(false);
    expect(llm.calls).toBe(0);
    expect(svc.view(project).window.sessions).toBe(0);
  });

  it('keeps the edit to the rule when editing a permission suggestion', async () => {
    const { svc, project } = setupService();
    await svc.review(project);
    const id = svc.view(project).suggestions[0]!.id;
    expect(svc.edit(id, 'Use pnpm for every install and script, never npm.').ok).toBe(true);
    expect(svc.view(project).suggestions[0]!.diff).toContain('+Use pnpm for every install and script, never npm.');
    expect(existsSync(join(project, '.claude'))).toBe(false);
  });
});
