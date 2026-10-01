import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type { DB } from '../store/db.js';

export interface LlmRequest<T> {
  purpose: string;
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface LlmClient {
  complete<T>(req: LlmRequest<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

const CliResult = z.looseObject({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
});

const RATE_LIMIT = /rate.?limit|usage limit|429|overloaded|quota/i;

/**
 * Calls Claude through `claude -p` so analysis runs on the user's own Claude login.
 *
 * Each call is isolated from the user's setup: no tools, no settings files (so no hooks, and our own
 * SessionEnd hook can't re-trigger), no MCP servers, nothing saved as a session, and a run
 * directory with no CLAUDE.md. `COMPANION_INTERNAL` marks the process as ours for anything else.
 */
export class ClaudeCliClient implements LlmClient {
  constructor(
    private db: DB,
    private runDir: string,
    private timeoutMs = 180_000,
  ) {
    mkdirSync(runDir, { recursive: true });
  }

  async complete<T>(req: LlmRequest<T>): Promise<T> {
    const started = Date.now();
    const args = [
      '-p',
      '--model', req.model,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(cliJsonSchema(req.schema)),
      '--system-prompt', req.system,
      '--tools', '',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
    let cost: number | null = null;
    try {
      const stdout = await run(process.env.COMPANION_CLAUDE_BIN ?? 'claude', args, req.prompt, this.runDir, this.timeoutMs);
      const out = CliResult.parse(JSON.parse(stdout));
      cost = out.total_cost_usd ?? null;
      if (out.is_error) throw new LlmError(out.result ?? 'claude reported an error', RATE_LIMIT.test(out.result ?? ''));
      const data = req.schema.safeParse(out.structured_output ?? JSON.parse(out.result ?? 'null'));
      if (!data.success) throw new LlmError(`Unexpected response shape: ${data.error.message.slice(0, 300)}`);
      this.record(req, started, true, cost, null);
      return data.data;
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError(String((err as Error).message ?? err), RATE_LIMIT.test(String(err)));
      this.record(req, started, false, cost, e.message);
      throw e;
    }
  }

  private record(req: LlmRequest<unknown>, started: number, ok: boolean, cost: number | null, error: string | null) {
    this.db
      .prepare(
        `INSERT INTO llm_calls(ts, purpose, model, ok, cost_usd, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date(started).toISOString(), req.purpose, req.model, ok ? 1 : 0, cost, Date.now() - started, error);
  }
}

/** Claude Code's validator rejects a `$schema` it doesn't know (zod defaults to draft 2020-12), so omit it. */
export function cliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return rest;
}

/** The prompt goes over stdin: transcripts can be far longer than a command line allows. */
function run(bin: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, COMPANION_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new LlmError(`claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new LlmError(`Could not run claude: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // With --output-format json, errors usually still arrive as a JSON result on stdout.
      if (code === 0 || stdout.trim().startsWith('{')) resolve(stdout);
      else reject(new LlmError(`claude exited with ${code}: ${(stderr || stdout).trim().slice(0, 500)}`, RATE_LIMIT.test(stderr)));
    });
    child.stdin.end(input);
  });
}
