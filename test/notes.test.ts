import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest } from '../src/analyze/llm.js';
import { notesBehind, readNotes, recentExchanges, updateNotes } from '../src/analyze/notes.js';
import { loadConfig, type Config } from '../src/config.js';
import { scan } from '../src/ingest/scanner.js';
import { listenForSessions } from '../src/main/app-socket.js';
import { branchContext } from '../src/main/branch.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { SocketRequest } from '../src/mcp/protocol.js';
import { openDb, type DB } from '../src/store/db.js';

class FakeLlm implements LlmClient {
  calls: LlmRequest<unknown>[] = [];
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls.push(req as LlmRequest<unknown>);
    return { notes: `## Goal\nnotes v${this.calls.length}` } as T;
  }
}

let root: string;
let projectDir: string;
let db: DB;
let cfg: Config;
let llm: FakeLlm;
const SID = 's1';

const prompt = (uuid: string, ts: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, sessionId: SID, timestamp: ts, cwd: '/work/app', message: { role: 'user', content: text } });
const reply = (uuid: string, ts: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, sessionId: SID, timestamp: ts, cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const write = (lines: string[]) => writeFileSync(join(projectDir, `${SID}.jsonl`), `${lines.join('\n')}\n`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-notes-'));
  projectDir = join(root, 'claude', 'projects', '-work-app');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(root, 'config.toml'), `[sources]\nclaude_dir = "${join(root, 'claude')}"\n`);
  process.env.COMPANION_DB = join(root, 'data', 'db.sqlite');
  cfg = loadConfig(join(root, 'config.toml'));
  db = openDb(cfg.dbPath);
  llm = new FakeLlm();
});

afterEach(() => {
  db.close();
  delete process.env.COMPANION_DB;
  rmSync(root, { recursive: true, force: true });
});

describe('session notes', () => {
  it('writes notes from the conversation and only reads what is new on the next update', async () => {
    write([prompt('u1', '2026-10-15T10:00:00Z', 'Use Redis for the cache, TTL 300s'), reply('a1', '2026-10-15T10:00:05Z', 'Done, see cache.ts')]);
    scan(db, cfg);
    expect(notesBehind(db, SID)).toBe(true);
    expect(await updateNotes(db, cfg, llm, SID)).toBe(1);
    expect(llm.calls[0]!.prompt).toContain('TTL 300s');
    expect(llm.calls[0]!.prompt).toContain('There are no notes yet.');
    const notes = readNotes(db, SID)!;
    expect(readFileSync(notes.path, 'utf8')).toContain('notes v1');
    expect(notesBehind(db, SID)).toBe(false);
    expect(await updateNotes(db, cfg, llm, SID)).toBe(0);

    write([
      prompt('u1', '2026-10-15T10:00:00Z', 'Use Redis for the cache, TTL 300s'),
      reply('a1', '2026-10-15T10:00:05Z', 'Done, see cache.ts'),
      prompt('u2', '2026-10-15T10:05:00Z', 'Now add metrics'),
    ]);
    scan(db, cfg);
    expect(recentExchanges(db, SID)).toBe('[USER] Now add metrics');
    await updateNotes(db, cfg, llm, SID);
    const second = llm.calls[1]!.prompt;
    expect(second).toContain('<current_notes>\n## Goal\nnotes v1');
    expect(second).toContain('Now add metrics');
    const newActivity = second.slice(second.indexOf('<new_activity>'));
    expect(newActivity).not.toContain('TTL 300s'); // already in the notes
    expect(recentExchanges(db, SID)).toBe('');
  });

  it('gives a new chat everything it needs as background context', () => {
    const ctx = branchContext({
      parentTitle: 'Cache layer',
      parentId: SID,
      kind: 'branch',
      notes: '## Goal\nRedis cache',
      recent: '[USER] Now add metrics',
      pins: ['/work/app/src/cache.ts'],
    });
    expect(ctx).toContain('moved a topic from an earlier Claude Code conversation');
    expect(ctx).toContain('<earlier_conversation_notes>\n## Goal\nRedis cache');
    expect(ctx).toContain('[USER] Now add metrics');
    expect(ctx).toContain('- /work/app/src/cache.ts');
    expect(ctx).toContain('do not recap it');
  });
});

describe('new-chat tool', () => {
  it('lets Claude ask Companion to open a new chat from the calling session', async () => {
    mkdirSync(join(root, 'claude', 'sessions'), { recursive: true });
    writeFileSync(join(root, 'claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'parent-session' }));
    const sock = join(root, 's.sock');
    process.env.COMPANION_SOCKET = sock;
    const received: SocketRequest[] = [];
    const server = listenForSessions(sock, async (req) => {
      received.push(req);
      return { ok: true, message: 'Opened a new chat "Testing strategy".' };
    });
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createMcpServer(cfg, 4242).connect(serverSide);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(clientSide);

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['start_new_chat']);
      expect(tools[0]!.description).toMatch(/separate/);

      const res = await client.callTool({ name: 'start_new_chat', arguments: { title: 'Testing strategy', prompt: 'Let us plan the tests.' } });
      expect(res.isError).toBe(false);
      expect((res.content as { text: string }[])[0]!.text).toContain('Opened a new chat');
      expect(received).toEqual([
        { method: 'new_chat', params: { claudePid: 4242, sessionId: 'parent-session', title: 'Testing strategy', prompt: 'Let us plan the tests.' } },
      ]);
      await client.close();
    } finally {
      server.close();
      delete process.env.COMPANION_SOCKET;
    }
  });

  it('tells Claude when Companion is not running', async () => {
    process.env.COMPANION_SOCKET = join(root, 'nobody.sock');
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createMcpServer(cfg, 1).connect(serverSide);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(clientSide);
      const res = await client.callTool({ name: 'start_new_chat', arguments: { title: 't', prompt: 'p' } });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0]!.text).toContain('Companion is not running');
      await client.close();
    } finally {
      delete process.env.COMPANION_SOCKET;
    }
  });
});
