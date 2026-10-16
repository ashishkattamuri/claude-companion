import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TranscriptTail } from '../src/main/transcript.js';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('keeps following a transcript that Claude Code moves to a worktree project folder', () => {
  root = mkdtempSync(join(tmpdir(), 'companion-tail-'));
  const main = join(root, '-repo');
  const worktree = join(root, '-repo--claude-worktrees-fix');
  mkdirSync(main);
  mkdirSync(worktree);
  writeFileSync(join(main, 's1.jsonl'), '{"n":1}\n');
  const tail = new TranscriptTail(root, 's1');
  expect(tail.poll()).toEqual(['{"n":1}']);

  renameSync(join(main, 's1.jsonl'), join(worktree, 's1.jsonl'));
  appendFileSync(join(worktree, 's1.jsonl'), '{"n":2}\n');
  expect(tail.poll()).toEqual([]);
  expect(tail.poll()).toEqual(['{"n":2}']);
});
