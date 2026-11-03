import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ContextUsage, parseContextReport } from '../src/main/context-usage.js';

// Claude Code 2.1.317's `claude -p /context` report, trimmed after the category table.
const REPORT = `## Context Usage

**Model:** claude-haiku-5-5
**Tokens:** 31.4k / 1m (3%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.3k | 0.3% |
| System tools | 1.1k | 0.1% |
| MCP tools | 673 | 0.1% |
| MCP server instructions | 2.3k | 0.2% |
| MCP tools (deferred) | 569.8k | 57.0% |
| System tools (deferred) | 17.1k | 1.7% |
| Skills | 7.3k | 0.7% |
| Messages | 16.8k | 1.7% |
| Free space | 935.6k | 93.6% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__x__y | x | 165 |
`;

describe('parseContextReport', () => {
  it('reads the loaded categories and the autocompact buffer', () => {
    expect(parseContextReport(REPORT)).toEqual({
      categories: [
        { name: 'System prompt', tokens: 3300 },
        { name: 'System tools', tokens: 1100 },
        { name: 'MCP tools', tokens: 673 },
        { name: 'MCP server instructions', tokens: 2300 },
        { name: 'Skills', tokens: 7300 },
        { name: 'Messages', tokens: 16800 },
      ],
      autocompact: 33000,
    });
  });

  it('leaves out deferred tools and free space, and stops at the next section', () => {
    const names = parseContextReport(REPORT)!.categories.map((c) => c.name);
    expect(names.some((n) => /deferred|free|mcp__/i.test(n))).toBe(false);
  });

  it('returns null for a report in another shape', () => {
    expect(parseContextReport('Unknown command: /context')).toBeNull();
    expect(parseContextReport('### Estimated usage by category\n\nnothing here')).toBeNull();
  });
});

describe('ContextUsage', () => {
  it('reads a session breakdown with claude -p /context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-usage-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\nexec node "${join(process.cwd(), 'test/e2e/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
    let changed = 0;
    const cu = new ContextUsage({ claudeBin: fake, env: () => ({ PATH: process.env.PATH ?? '' }), onChanged: () => changed++ });
    try {
      expect(cu.get('abc', dir)).toBeNull();
      await vi.waitFor(() => expect(changed).toBe(1), { timeout: 10_000 });
      const b = cu.get('abc', dir)!;
      expect(b.categories.map((c) => c.name)).toContain('Messages');
      expect(b.autocompact).toBe(33_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
