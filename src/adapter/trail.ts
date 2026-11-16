/**
 * What a session did, in order, read straight from its transcript: the requests you typed, the edits
 * Claude made (with when), the tests and checks it ran with their outcomes, and the steps that failed.
 * Everything here is a recorded fact; nothing is inferred by a model. Review, "since you last looked"
 * and hand-back packages are built on it.
 */

export interface TrailRequest {
  /** The conversation item id of the message, so it can be shown in the chat. */
  id: string;
  ts: string;
  text: string;
}

export interface TrailEdit {
  stepId: string;
  ts: string;
  /** Position in the transcript: orders events even when their timestamps tie. */
  seq: number;
  abs: string;
}

/** A test or check command Claude ran, and how it came out. */
export interface TestRun {
  stepId: string;
  ts: string;
  /** Position in the transcript, as on edits. */
  seq: number;
  command: string;
  /** test: a test runner; check: a type check, lint or build. */
  kind: 'test' | 'check';
  /** From the exit status Claude Code recorded, and the runner's own summary line when it printed one. */
  outcome: 'passed' | 'failed' | 'unknown';
  /** The runner's summary line, e.g. "Tests  157 passed (157)". */
  summary: string | null;
  /** The files or patterns the command named; null when it ran the whole suite (as configured). */
  scope: string[] | null;
}

/** A step that failed: a tool error, a denied permission, or an interrupted command. */
export interface TrailFailure {
  stepId: string;
  ts: string;
  tool: string;
  /** What was attempted, e.g. the command or file. */
  target: string;
  text: string;
  denied: boolean;
}

export interface Trail {
  requests: TrailRequest[];
  edits: TrailEdit[];
  tests: TestRun[];
  failures: TrailFailure[];
  /** Id and time of the transcript's last conversation record, to tell whether anything happened since. */
  last: { id: string; ts: string } | null;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const HARNESS = /^(<command-|<local-command|<system-reminder>|<bash-|<task-notification>|Caveat:|\[Request interrupted)/;
const DENIED = /doesn't want to proceed|was rejected|permission (was )?denied|user denied|declined to/i;

/** Test runners, then checks. Matched against each part of a command line (split on && ; |). */
const TEST_RUNNERS: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?test(:[\w:-]+)?\b/,
  /^(npx\s+|pnpm\s+exec\s+|yarn\s+|bunx\s+)?(vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run)\b/,
  /^(python3?\s+-m\s+)?(pytest|unittest|nose2?)\b/,
  /^(go\s+test|cargo\s+(test|nextest)|deno\s+test|bun\s+test|mix\s+test|dotnet\s+test|swift\s+test)\b/,
  /^(\.\/)?(gradlew?|mvnw?)\s+.*\btest\b/,
  /^(bundle\s+exec\s+)?(rspec|rake\s+test)\b/,
  /^(\.\/vendor\/bin\/)?phpunit\b/,
  /^make\s+(test|check)\b/,
];
const CHECKS: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|lint|build|check)\b/,
  /^(npx\s+)?(tsc|eslint|biome|ruff|mypy|pyright|flake8|clippy)\b/,
  /^cargo\s+(check|clippy|build)\b/,
  /^go\s+(vet|build)\b/,
];

/** Whether a shell command runs tests or a check, and which; null for anything else. */
export function classifyCommand(command: string): { kind: 'test' | 'check'; part: string } | null {
  const parts = command
    .split(/&&|\|\||;|\n/)
    .map((p) => p.trim().replace(/^(cd\s+\S+\s*$)/, '').replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, '').replace(/^(time|env)\s+/, ''))
    .filter(Boolean);
  for (const part of parts) if (TEST_RUNNERS.some((r) => r.test(part))) return { kind: 'test', part };
  for (const part of parts) if (CHECKS.some((r) => r.test(part))) return { kind: 'check', part };
  return null;
}

/** File paths or patterns a test command names; null when it names none (the configured suite). */
export function commandScope(part: string): string[] | null {
  const words = part
    .split(/\s+/)
    .slice(1)
    .filter((w) => !w.startsWith('-') && !/^(run|test|exec|--|2>&1|>|\|)$/.test(w) && !/^(npm|pnpm|yarn|bun|npx|python3?|go|cargo|tail|head|grep)$/.test(w));
  const files = words.filter((w) => /[/.*]/.test(w) && !/^\d/.test(w) && !w.startsWith('$'));
  return files.length ? files : null;
}

/**
 * How a test or check came out. Claude Code marks a non-zero exit as an error result, so that is
 * decisive; otherwise the runner's own counts decide, and with neither the outcome is unknown.
 */
export function testOutcome(text: string, isError: boolean, piped = false): { outcome: TestRun['outcome']; summary: string | null } {
  const lines = text.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
  const summaryLine =
    lines.findLast((l) => /^(Tests?|Test Files|Tests:)\s+.*\d+ (passed|failed)/i.test(l)) ??
    lines.findLast((l) => /\b\d+ (passed|failed|passing|failing)\b/i.test(l) && l.length < 200) ??
    lines.findLast((l) => /^(ok|FAIL|PASS)\s/.test(l) && l.length < 200) ??
    lines.findLast((l) => /^test result: /.test(l)) ??
    null;
  const failedCount = /\b([1-9]\d*) (failed|failing|errors?)\b/i.test(text);
  if (isError || failedCount || /^FAIL\b/m.test(text) || /test result: FAILED/.test(text)) return { outcome: 'failed', summary: summaryLine };
  if (summaryLine || /\b\d+ (passed|passing)\b/i.test(text) || /^ok\s/m.test(text) || /test result: ok/.test(text)) return { outcome: 'passed', summary: summaryLine };
  // A clean exit with no summary (a type check or build that printed nothing) passed, unless the output
  // went through a pipe: then the exit status was the last command's (e.g. `| tail`), not the runner's.
  return { outcome: piped || /\berror\b/i.test(text) ? 'unknown' : 'passed', summary: null };
}

interface Pending {
  name: string;
  stepId: string;
  ts: string;
  input: Record<string, any>;
}

/** Reads a transcript's JSONL lines into the session's trail. */
export function collectTrail(lines: string[]): Trail {
  const pending = new Map<string, Pending>();
  const trail: Trail = { requests: [], edits: [], tests: [], failures: [], last: null };
  let seq = 0;
  for (const line of lines) {
    seq++;
    let rec: Record<string, any>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || rec.isSidechain) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : '';
    if (typeof rec.uuid === 'string') trail.last = { id: rec.uuid, ts };
    const content = rec.message?.content;

    if (rec.type === 'assistant' && Array.isArray(content)) {
      content.forEach((block: any, i: number) => {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') return;
        const stepId = content.length > 1 ? `${rec.uuid}:${i}` : rec.uuid;
        pending.set(block.id, { name: String(block.name ?? ''), stepId, ts, input: block.input && typeof block.input === 'object' ? block.input : {} });
      });
      continue;
    }
    if (rec.type !== 'user' || rec.isCompactSummary) continue;

    if (typeof content === 'string' || (Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result'))) {
      const text = typeof content === 'string' ? content : (content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      if (!rec.isMeta && text.trim() && !HARNESS.test(text.trim()) && typeof rec.uuid === 'string') trail.requests.push({ id: rec.uuid, ts, text: text.trim() });
      continue;
    }

    for (const block of content as any[]) {
      if (block?.type !== 'tool_result') continue;
      const call = pending.get(block.tool_use_id);
      if (!call) continue;
      pending.delete(block.tool_use_id);
      const text = resultText(block.content);
      const isError = !!block.is_error;
      const r = rec.toolUseResult;

      if (EDIT_TOOLS.has(call.name) && !isError) {
        const abs = (r && typeof r === 'object' && typeof r.filePath === 'string' ? r.filePath : null) ?? call.input.file_path ?? call.input.notebook_path;
        if (typeof abs === 'string') trail.edits.push({ stepId: call.stepId, ts: call.ts, seq, abs });
      }
      if (call.name === 'Bash' && typeof call.input.command === 'string') {
        const cls = classifyCommand(call.input.command);
        const out = r && typeof r === 'object' && typeof r.stdout === 'string' ? `${r.stdout}\n${r.stderr ?? ''}` : text;
        if (cls && !DENIED.test(text)) {
          const piped = /(^|[^|])\|(?!\|)/.test(call.input.command.slice(call.input.command.indexOf(cls.part)));
          const { outcome, summary } = r?.interrupted ? { outcome: 'unknown' as const, summary: 'Interrupted' } : testOutcome(out, isError, piped);
          trail.tests.push({ stepId: call.stepId, ts: call.ts, seq, command: call.input.command.trim(), kind: cls.kind, outcome, summary, scope: cls.kind === 'test' ? commandScope(cls.part) : null });
        }
      }
      if (isError) {
        const target = String(call.input.command ?? call.input.file_path ?? call.input.pattern ?? call.input.url ?? '').split('\n')[0]!.slice(0, 160);
        trail.failures.push({ stepId: call.stepId, ts: call.ts, tool: call.name, target, text: text.slice(0, 400), denied: DENIED.test(text) });
      }
    }
  }
  return trail;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n');
  return '';
}

/**
 * Whether a file's latest edit has test evidence after it. `passed` and `failed` only say a test or
 * check ran after the edit and how it came out; whether it exercised this file is not known.
 */
export type Verification =
  | { state: 'passed' | 'failed' | 'unknown'; run: TestRun }
  /** Tests ran, but only before this file's last edit. */
  | { state: 'stale'; run: TestRun }
  | { state: 'none' };

export function verificationFor(lastEditSeq: number | null, tests: TestRun[]): Verification {
  if (!tests.length) return { state: 'none' };
  const after = lastEditSeq !== null ? tests.filter((t) => t.seq > lastEditSeq) : tests;
  // A test runner outranks a check: a passing build says less about behavior than a failing test.
  const pick = (runs: TestRun[]) => runs.filter((t) => t.kind === 'test').at(-1) ?? runs.at(-1);
  const run = pick(after);
  if (run) return { state: run.outcome, run };
  return { state: 'stale', run: pick(tests)! };
}

/** Where each file was last edited in the transcript. */
export function lastEdits(trail: Trail): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of trail.edits) out.set(e.abs, e.seq);
  return out;
}
