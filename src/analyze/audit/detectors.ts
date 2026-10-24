import { basename, resolve } from 'node:path';
import { WEIGHTS, weighted, type ModelCall, type Timeline, type ToolStep } from './timeline.js';

/**
 * Mechanical waste detectors. Each looks at the timeline for one pattern and reports candidates
 * with the steps involved and what they cost. They over-report on purpose where the pattern can
 * be legitimate (a re-read after something changed the file outside the transcript, a re-run of a
 * test after a fix); the review model confirms or rejects each candidate.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  category: string;
  title: string;
  /** Every step involved, in order; the first is often the original the rest repeated. */
  steps: number[];
  confidence: Confidence;
  /** A hint for the review: the likely cause in the harness, when the pattern suggests one. */
  cause?: string;
  /** What the waste cost, per step or call, so totals can count each step once across findings. */
  costs: Cost[];
  tokens: number;
  weighted: number;
}

export interface Cost {
  /** `s<step>` or `c<call>`. */
  key: string;
  tokens: number;
  weighted: number;
}

export interface AuditReport {
  sessionId: string;
  calls: number;
  tokens: number;
  weighted: number;
  costUsd: number | null;
  /** High- and medium-confidence findings, each step counted once. */
  wasted: Totals;
  /** Low-confidence findings on top of that: likely waste, but they need the review to say. */
  toReview: Totals;
  findings: Finding[];
}

export interface Totals {
  tokens: number;
  weighted: number;
  share: number;
  costUsd: number | null;
}

// ---------- costs ----------

/** A step's result: what it put in the context, every time it was sent. */
function resultCost(s: ToolStep): Cost {
  const r = s.result;
  if (!r || !r.tokens) return { key: `s${s.index}`, tokens: 0, weighted: 0 };
  const sent = Math.max(1, r.sent);
  return { key: `s${s.index}`, tokens: r.tokens * sent, weighted: r.tokens * (WEIGHTS.cacheWrite + WEIGHTS.cacheRead * (sent - 1)) };
}

/** A model call that needn't have happened: everything it read and wrote. */
function callCost(c: ModelCall): Cost {
  return { key: `c${c.index}`, tokens: c.prompt + c.usage.output, weighted: weighted(c.usage) };
}

/**
 * The cost of wasted steps: their results, plus any call whose tool calls were all wasted (without
 * them the model would have gone straight to its next action), plus calls named as avoidable.
 */
function costOf(tl: Timeline, wasted: number[], avoidableCalls: number[] = []): Cost[] {
  const set = new Set(wasted);
  const calls = new Set(avoidableCalls);
  for (const i of wasted) {
    const call = tl.calls[tl.steps[i]!.call]!;
    if (call.tools.every((t) => set.has(t))) calls.add(call.index);
  }
  return [...wasted.map((i) => resultCost(tl.steps[i]!)), ...[...calls].map((c) => callCost(tl.calls[c]!))];
}

function finding(
  tl: Timeline,
  f: { category: string; title: string; steps: number[]; wasted: number[]; confidence: Confidence; cause?: string; avoidableCalls?: number[]; costs?: Cost[] },
): Finding {
  const costs = f.costs ?? costOf(tl, f.wasted, f.avoidableCalls);
  return {
    category: f.category,
    title: f.title,
    steps: f.steps,
    confidence: f.confidence,
    ...(f.cause ? { cause: f.cause } : {}),
    costs,
    tokens: costs.reduce((s, c) => s + c.tokens, 0),
    weighted: costs.reduce((s, c) => s + c.weighted, 0),
  };
}

// ---------- reading steps ----------

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
/** Tools whose result is the user talking (an answer, a plan approval), not output to trim or retry. */
const USER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TodoWrite']);

const filePath = (s: ToolStep): string | null => {
  const p = s.input.file_path ?? s.input.notebook_path;
  return typeof p === 'string' ? resolve(s.cwd ?? '/', p) : null;
};

const command = (s: ToolStep): string | null => (s.name === 'Bash' && typeof s.input.command === 'string' ? s.input.command : null);

const normalize = (c: string) => c.trim().replace(/\s+/g, ' ');

/** Splits a shell command into its simple commands. Quoted text is blanked first, so a `|` in a pattern doesn't split. */
const segments = (c: string) =>
  c
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((s) => s.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ''))
    .filter(Boolean);

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'ag', 'fd', 'find', 'pwd', 'which', 'type', 'whereis', 'wc', 'echo',
  'printf', 'tree', 'file', 'stat', 'du', 'df', 'env', 'printenv', 'jq', 'less', 'sort', 'uniq', 'cut', 'awk', 'sed', 'diff',
  'cd', 'basename', 'dirname', 'realpath', 'readlink', 'uname', 'whoami', 'id', 'true', 'test', '[',
]);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'remote', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'config']);
const SEARCH_CMDS = new Set(['grep', 'egrep', 'rg', 'ag', 'fd', 'find']);

function readOnlySegment(seg: string): boolean {
  const words = seg.split(/\s+/);
  const w = words[0]!;
  // Redirecting into a file writes it; into /dev/null or another stream doesn't.
  if (/(^|[^0-9&])>{1,2}\s*(?!\/dev\/null|&)\S/.test(seg)) return false;
  if (w === 'git') return READ_ONLY_GIT.has(words[1] ?? '') && !/\s(-D|-d|--delete|-m|--move|--set|--unset|--add)\b/.test(seg);
  if (w === 'sed') return !/\s-i\b|\s--in-place\b/.test(seg);
  if (w === 'find') return !/\s-(delete|exec|execdir|ok)\b/.test(seg);
  if (words.length <= 2 && /^(-v|-V|--version|version)$/.test(words[1] ?? '')) return true;
  return READ_ONLY.has(w);
}

const readOnly = (c: string) => segments(c).every(readOnlySegment);
const isSearchCmd = (c: string) => segments(c).some((s) => SEARCH_CMDS.has(s.split(/\s+/)[0]!));

/** Tests, builds, linters, type checks. */
const CHECK = /\b(vitest|jest|mocha|pytest|tox|nox|tsc|eslint|ruff|mypy|pyright|flake8|clippy|go (test|vet|build)|cargo (test|build|check)|make|gradle|mvn|(npm|pnpm|yarn|bun)( run)? (test|build|lint|typecheck|check)\w*)\b/;

/** Commands whose output changes on its own: polling is not repetition. */
const TIME_DEPENDENT = /\b(sleep|curl|wget|gh|ps|date|top|kubectl|docker|ping|lsof|watch|jobs|uptime|git fetch|git pull|tail -f)\b/;

/** A step that may have changed files: edits, and any command not known to be read-only. */
function mutates(s: ToolStep): 'none' | 'file' | 'unknown' {
  if (EDIT_TOOLS.has(s.name)) return s.result?.isError ? 'none' : 'file';
  const c = command(s);
  if (c !== null) return readOnly(c) ? 'none' : 'unknown';
  return 'none';
}

const byThread = (tl: Timeline) => {
  const threads = new Map<string | null, ToolStep[]>();
  for (const s of tl.steps) threads.set(s.agent, [...(threads.get(s.agent) ?? []), s]);
  return [...threads.values()];
};

const ok = (s: ToolStep) => s.result !== null && !s.result.isError;

/** Whether a /compact happened between two calls of the main conversation. */
const compactedBetween = (tl: Timeline, a: ToolStep, b: ToolStep) =>
  a.agent === null && tl.compactions.some((c) => c > a.call && c <= b.call);

export function describe(s: ToolStep): string {
  const p = filePath(s);
  const c = command(s);
  if (c !== null) return `Bash: ${normalize(c).slice(0, 120)}`;
  if (s.name === 'Read' && p) {
    const from = num(s.input.offset);
    const lim = num(s.input.limit);
    return `Read ${p}${from || lim ? `:${from ?? 1}-${(from ?? 1) + (lim ?? 2000) - 1}` : ''}`;
  }
  if (p) return `${s.name} ${p}`;
  if (s.name === 'Grep') return `Grep "${s.input.pattern}"${s.input.path ? ` in ${s.input.path}` : ''}`;
  if (s.name === 'Glob') return `Glob ${s.input.pattern}${s.input.path ? ` in ${s.input.path}` : ''}`;
  if (s.name === 'WebFetch') return `WebFetch ${s.input.url}`;
  if (s.name === 'WebSearch') return `WebSearch "${s.input.query}"`;
  if (SUBAGENT_TOOLS.has(s.name)) return `${s.name}: ${s.input.description ?? ''}`;
  return s.name;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- A. Redundant retrieval ----------

interface ReadRec {
  step: ToolStep;
  from: number;
  to: number;
  /** A command that may have changed files ran since. */
  dirty: boolean;
}

function readRange(s: ToolStep): { path: string; from: number; to: number } | null {
  if (s.name === 'Read') {
    const path = filePath(s);
    if (!path) return null;
    const from = num(s.input.offset) ?? 1;
    return { path: s.input.pages ? `${path}#${s.input.pages}` : path, from, to: from + (num(s.input.limit) ?? 2000) - 1 };
  }
  const c = command(s);
  const m = c && /^cat\s+(?:-n\s+)?(["']?)([^\s|;&>"']+)\1\s*$/.exec(c.trim());
  return m ? { path: resolve(s.cwd ?? '/', m[2]!), from: 1, to: Infinity } : null;
}

/** A1 (and B13 across a /compact), A2, A3. */
export function rereads(tl: Timeline): Finding[] {
  const out: Finding[] = [];
  for (const steps of byThread(tl)) {
    const reads = new Map<string, ReadRec[]>();
    const lastEdit = new Map<string, number>(); // path -> position in `steps`
    const groups = new Map<ToolStep, ToolStep[]>(); // original read -> repeats
    const dirtyGroups = new Set<ToolStep>();
    const afterEdit: [ToolStep, ToolStep][] = [];
    steps.forEach((s, pos) => {
      const m = mutates(s);
      const p = filePath(s);
      if (m === 'file' && p) {
        reads.delete(p);
        lastEdit.set(p, pos);
        return;
      }
      if (m === 'unknown') {
        const c = command(s)!;
        for (const [path, recs] of reads) {
          if (c.includes(basename(path.split('#')[0]!))) reads.delete(path);
          else for (const r of recs) r.dirty = true;
        }
        return;
      }
      const r = readRange(s);
      if (!r || !ok(s)) return;
      const edited = lastEdit.get(r.path);
      if (edited !== undefined && pos - edited <= 2 && s.name === 'Read') {
        afterEdit.push([steps[edited]!, s]);
        lastEdit.delete(r.path);
      }
      const prior = (reads.get(r.path) ?? []).find((x) => x.from <= r.to && r.from <= x.to);
      if (prior) {
        const group = groups.get(prior.step) ?? [];
        group.push(s);
        groups.set(prior.step, group);
        if (prior.dirty) dirtyGroups.add(prior.step);
        return;
      }
      reads.set(r.path, [...(reads.get(r.path) ?? []), { step: s, from: r.from, to: r.to, dirty: false }]);
    });

    for (const [orig, repeats] of groups) {
      const path = readRange(orig)!.path;
      const lost = repeats.filter((x) => compactedBetween(tl, orig, x));
      const plain = repeats.filter((x) => !lost.includes(x));
      const dirty = dirtyGroups.has(orig);
      if (plain.length)
        out.push(
          finding(tl, {
            category: 'A1',
            title: `Read ${path} again ${times(plain.length)} with no change to it in between`,
            steps: [orig.index, ...plain.map((x) => x.index)],
            wasted: plain.map((x) => x.index),
            confidence: dirty ? 'medium' : 'high',
          }),
        );
      if (lost.length)
        out.push(
          finding(tl, {
            category: 'B13',
            title: `Read ${path} again after /compact dropped it`,
            steps: [orig.index, ...lost.map((x) => x.index)],
            wasted: lost.map((x) => x.index),
            confidence: 'medium',
            cause: 'lost in compaction; pinning the file keeps it',
          }),
        );
    }
    if (afterEdit.length)
      out.push(
        finding(tl, {
          category: 'A2',
          title: `Re-read ${plural(afterEdit.length, 'file')} right after editing ${afterEdit.length > 1 ? 'them' : 'it'}`,
          steps: afterEdit.flatMap(([e, r]) => [e.index, r.index]),
          wasted: afterEdit.map(([, r]) => r.index),
          confidence: 'medium',
        }),
      );
    out.push(...slicedReads(tl, steps));
  }
  return out;
}

/** A3: three or more separate calls reading different parts of one file in the same turn. */
function slicedReads(tl: Timeline, steps: ToolStep[]): Finding[] {
  const out: Finding[] = [];
  const runs = new Map<string, ToolStep[]>();
  const flush = (key: string) => {
    const run = runs.get(key);
    runs.delete(key);
    if (!run || run.length < 3) return;
    if (new Set(run.map((s) => s.call)).size < 3) return;
    out.push(
      finding(tl, {
        category: 'A3',
        title: `Read ${key.split('|')[1]} in ${run.length} separate slices`,
        steps: run.map((s) => s.index),
        wasted: [],
        avoidableCalls: [...new Set(run.slice(1).map((s) => s.call))],
        confidence: 'low',
      }),
    );
  };
  for (const s of steps) {
    const p = filePath(s);
    if (mutates(s) === 'file' && p) for (const k of [...runs.keys()]) if (k.endsWith(`|${p}`)) flush(k);
    if (s.name !== 'Read' || !p || !ok(s) || num(s.input.offset) === null) continue;
    const key = `${s.turn}|${p}`;
    runs.set(key, [...(runs.get(key) ?? []), s]);
  }
  for (const k of [...runs.keys()]) flush(k);
  return out;
}

/** A4, A6, E25, F31: the same search or command again, with nothing changed in between. */
export function repeats(tl: Timeline): Finding[] {
  const out: Finding[] = [];
  for (const steps of byThread(tl)) {
    const seen = new Map<string, { first: ToolStep; later: ToolStep[]; changedSince: boolean; dirtySince: boolean }>();
    for (const s of steps) {
      // A denied call isn't a failing loop; retrying one is its own finding (D22).
      const key = s.result?.isError && DENIED.test(s.result.text) ? null : repeatKey(s);
      const m = mutates(s);
      if (key) {
        const prev = seen.get(key);
        if (prev && !prev.changedSince) prev.later.push(s);
        else seen.set(key, { first: s, later: [], changedSince: false, dirtySince: false });
      }
      if (m !== 'none')
        for (const [k, v] of seen) {
          if (k === key) continue;
          // An edit changes what a search or check would find; an unknown command may have.
          if (m === 'file') v.changedSince = true;
          else v.dirtySince = true;
        }
    }
    for (const { first, later, dirtySince } of seen.values()) {
      if (!later.length) continue;
      const c = command(first);
      const all = [first, ...later];
      let category: string;
      let what: string;
      if (c === null) {
        category = 'A4';
        what = describe(first);
      } else if (all.every((x) => x.result?.isError)) {
        category = 'E25';
        what = `\`${normalize(c).slice(0, 80)}\` failed`;
      } else if (CHECK.test(c)) {
        category = 'F31';
        what = `\`${normalize(c).slice(0, 80)}\``;
      } else {
        category = isSearchCmd(c) ? 'A4' : 'A6';
        what = `\`${normalize(c).slice(0, 80)}\``;
      }
      out.push(
        finding(tl, {
          category,
          title: `${what} ${category === 'E25' ? '' : 'ran '}${times(all.length)} with nothing changed in between`,
          steps: all.map((x) => x.index),
          wasted: later.map((x) => x.index),
          confidence: dirtySince || (c !== null && !readOnly(c) && category === 'A6') ? 'medium' : 'high',
        }),
      );
    }
  }
  return out;
}

function repeatKey(s: ToolStep): string | null {
  if (SEARCH_TOOLS.has(s.name)) return `${s.name}|${JSON.stringify(sorted(s.input))}`;
  const c = command(s);
  if (c === null || s.input.run_in_background || TIME_DEPENDENT.test(c)) return null;
  return `Bash|${s.cwd}|${normalize(c)}`;
}

/** A7: the same page fetched or the same web search made twice. */
export function webRepeats(tl: Timeline): Finding[] {
  const out: Finding[] = [];
  for (const steps of byThread(tl)) {
    const seen = new Map<string, ToolStep[]>();
    for (const s of steps) {
      if (!ok(s)) continue;
      const key = s.name === 'WebFetch' ? `url|${s.input.url}` : s.name === 'WebSearch' ? `q|${String(s.input.query).toLowerCase().trim()}` : null;
      if (key) seen.set(key, [...(seen.get(key) ?? []), s]);
    }
    for (const group of seen.values())
      if (group.length > 1)
        out.push(
          finding(tl, {
            category: 'A7',
            title: `${describe(group[0]!)} ${group.length} times`,
            steps: group.map((s) => s.index),
            wasted: group.slice(1).map((s) => s.index),
            confidence: 'high',
          }),
        );
  }
  return out;
}

/** A5: searching for a file whose path had already shown up. */
export function knownPathSearches(tl: Timeline): Finding[] {
  const hits: [ToolStep, string][] = [];
  for (const steps of byThread(tl)) {
    const known = new Map<string, string>(); // basename -> a full path seen for it
    const learn = (text: string) => {
      for (const m of text.matchAll(/(?:\.{0,2}\/|\b[\w@.+-]+\/)[\w@.+/-]*\/?[\w@+-]+\.[A-Za-z0-9]{1,8}\b/g)) known.set(basename(m[0]), m[0]);
    };
    // The user's messages count for the main conversation, from when they were sent.
    const messages = steps[0]?.agent === null ? [...tl.messages] : [];
    for (const s of steps) {
      while (messages.length && messages[0]!.ts <= s.ts) learn(messages.shift()!.text);
      const target = searchedName(s);
      if (target && known.has(target)) hits.push([s, known.get(target)!]);
      if (s.result) learn(s.result.text);
      learn(JSON.stringify(s.input));
    }
  }
  if (!hits.length) return [];
  return [
    finding(tl, {
      category: 'A5',
      title: `Searched for ${plural(hits.length, 'file')} whose path was already known (${hits.slice(0, 3).map(([, p]) => p).join(', ')})`,
      steps: hits.map(([s]) => s.index),
      wasted: hits.map(([s]) => s.index),
      confidence: 'medium',
    }),
  ];
}

/** The literal file name a Glob or `find -name` looks for, if it names one. */
function searchedName(s: ToolStep): string | null {
  let pattern: string | null = null;
  if (s.name === 'Glob' && typeof s.input.pattern === 'string') pattern = s.input.pattern.split('/').at(-1) ?? null;
  const c = command(s);
  if (c) pattern = /\bfind\b.*\s-i?name\s+["']?([^\s"']+)/.exec(c)?.[1] ?? null;
  return pattern && /^[\w@.+-]+\.[A-Za-z0-9]{1,8}$/.test(pattern) ? pattern : null;
}

// ---------- C. Environment discovery ----------

const TOOLCHAINS = 'node|deno|bun|npm|npx|pnpm|yarn|python3?|pip3?|uv|poetry|go|cargo|rustc|java|javac|mvn|gradle|ruby|gem|gcc|g\\+\\+|clang|cmake|make|docker|kubectl|git|gh|tsc|swift|xcodebuild|brew|claude';
const PROBE = new RegExp(`^(which|command -v|type|whereis)\\s+\\S+$|^\\S+\\s+--version$|^(${TOOLCHAINS})\\s+(-v|-V|version)$`);

/** C17: probing for tools and versions. */
export function envProbes(tl: Timeline): Finding[] {
  const probes = tl.steps.filter((s) => {
    const c = command(s);
    return c !== null && segments(c).some((seg) => PROBE.test(seg));
  });
  if (!probes.length) return [];
  return [
    finding(tl, {
      category: 'C17',
      title: `Probed the environment ${times(probes.length)} (${probes.slice(0, 3).map((s) => `\`${normalize(command(s)!).slice(0, 40)}\``).join(', ')})`,
      steps: probes.map((s) => s.index),
      wasted: probes.map((s) => s.index),
      confidence: probes.length > 1 ? 'medium' : 'low',
      cause: 'no environment info at start',
    }),
  ];
}

const PM_FAMILIES = [
  ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'bunx'],
  ['pip', 'pip3', 'uv', 'poetry', 'pipenv', 'conda'],
];

/** C18: a command failing under one package manager, then working under another. */
export function wrongPackageManager(tl: Timeline): Finding[] {
  const wasted: ToolStep[] = [];
  const all: number[] = [];
  for (const steps of byThread(tl)) {
    const bash = steps.filter((s) => command(s) !== null);
    bash.forEach((s, i) => {
      const pm = packageManager(command(s)!);
      if (!pm || !s.result?.isError) return;
      const family = PM_FAMILIES.find((f) => f.includes(pm))!;
      const fix = bash.slice(i + 1, i + 7).find((x) => {
        const other = packageManager(command(x)!);
        return other && other !== pm && family.includes(other) && ok(x);
      });
      if (fix) {
        wasted.push(s);
        all.push(s.index, fix.index);
      }
    });
  }
  if (!wasted.length) return [];
  return [
    finding(tl, {
      category: 'C18',
      title: `Tried the wrong package manager first ${times(wasted.length)}`,
      steps: [...new Set(all)],
      wasted: wasted.map((s) => s.index),
      confidence: 'high',
      cause: 'the package manager is not stated in CLAUDE.md',
    }),
  ];
}

function packageManager(c: string): string | null {
  for (const seg of segments(c)) {
    const w = seg.split(/\s+/)[0]!;
    if (PM_FAMILIES.some((f) => f.includes(w))) return w;
  }
  return null;
}

// ---------- D. Failed tool calls ----------

const FAILURES: [string, (s: ToolStep, text: string) => boolean, string][] = [
  ['D20', (s, t) => EDIT_TOOLS.has(s.name) && /not found|has not been read|modified since|found \d+ matches|old_string|no changes to make/i.test(t), 'edits failed on stale or unread text'],
  ['C19', (s, t) => (s.name === 'Read' && /does not exist|ENOENT|no such file/i.test(t)) || (command(s)?.trim().startsWith('cd ') === true && /no such file/i.test(t)), 'path or working-directory mistakes'],
  ['D21', (_, t) => /InputValidationError|Invalid tool parameters|is not a valid|required parameter|unexpected parameter/i.test(t), 'tool input errors'],
  ['D23', (s, t) => command(s) !== null && /command not found|unknown option|unrecognized option|invalid option|illegal option|unknown command/i.test(t), 'commands not found or with wrong flags'],
  ['D24', (s, t) => command(s) !== null && /command timed out|timed out after/i.test(t), 'commands timed out in the foreground'],
];

const DENIED = /doesn't want to proceed|was rejected|permission to use .* (has been )?denied|user denied|denied by the user/i;

/** D20-D24, C19: tool calls that failed in ways that point at the harness, not at the code. */
export function failures(tl: Timeline): Finding[] {
  const groups = new Map<string, ToolStep[]>();
  for (const s of tl.steps) {
    if (!s.result?.isError) continue;
    const hit = FAILURES.find(([, test]) => test(s, s.result!.text));
    if (hit) groups.set(hit[0], [...(groups.get(hit[0]) ?? []), s]);
  }
  const out = [...groups].map(([category, steps]) => {
    const label = FAILURES.find(([c]) => c === category)![2];
    return finding(tl, {
      category,
      title: `${label[0]!.toUpperCase()}${label.slice(1)} (${steps.length}), e.g. ${describe(steps[0]!)}`,
      steps: steps.map((s) => s.index),
      wasted: steps.map((s) => s.index),
      confidence: 'high',
    });
  });

  // D22: the same call tried again after the user denied it.
  for (const steps of byThread(tl)) {
    const denied = new Map<string, ToolStep>();
    const retries: [ToolStep, ToolStep][] = [];
    for (const s of steps) {
      const key = `${s.name}|${JSON.stringify(sorted(s.input))}`;
      const before = denied.get(key);
      if (before) retries.push([before, s]);
      if (s.result?.isError && DENIED.test(s.result.text) && !USER_TOOLS.has(s.name)) denied.set(key, s);
    }
    if (retries.length)
      out.push(
        finding(tl, {
          category: 'D22',
          title: `Retried ${plural(retries.length, 'denied call')} unchanged: ${describe(retries[0]![1])}`,
          steps: retries.flatMap(([a, b]) => [a.index, b.index]),
          wasted: retries.map(([, b]) => b.index),
          confidence: 'high',
          cause: 'a missing permission rule, or the model ignoring the denial',
        }),
      );
  }
  return out;
}

// ---------- E. Loops ----------

/** E27: an edit undone by a later edit. */
export function reverts(tl: Timeline): Finding[] {
  const pairs: [ToolStep, ToolStep][] = [];
  for (const steps of byThread(tl)) {
    const edits: ToolStep[] = [];
    for (const s of steps) {
      if (s.name !== 'Edit' || !ok(s)) continue;
      const undone = edits.find(
        (e) => filePath(e) === filePath(s) && e.input.old_string === s.input.new_string && e.input.new_string === s.input.old_string,
      );
      if (undone) pairs.push([undone, s]);
      edits.push(s);
    }
  }
  if (!pairs.length) return [];
  return [
    finding(tl, {
      category: 'E27',
      title: `Made and then undid ${plural(pairs.length, 'edit')} (${[...new Set(pairs.map(([a]) => filePath(a)))].slice(0, 2).join(', ')})`,
      steps: pairs.flatMap(([a, b]) => [a.index, b.index]),
      wasted: pairs.flatMap(([a, b]) => [a.index, b.index]),
      confidence: 'high',
    }),
  ];
}

// ---------- G. Output bloat ----------

const BIG_RESULT = 5_000;
const FILE_VIEWERS = /^(cat|head|tail|nl|less|wc|sed -n|grep|rg|ls|cd)\b/;
const KEEP = 2_000;
const LONG_CARRY = 200_000;

/**
 * A8, G33: one result big enough to matter; G34: a result carried through many calls. Only what's
 * above a reasonable size counts as waste: the review decides how much of it was needed.
 */
export function bloat(tl: Timeline): Finding[] {
  const out: Finding[] = [];
  const carried: ToolStep[] = [];
  for (const s of tl.steps) {
    const r = s.result;
    if (!r || SUBAGENT_TOOLS.has(s.name) || USER_TOOLS.has(s.name)) continue;
    const sent = Math.max(1, r.sent);
    if (r.tokens >= BIG_RESULT) {
      const excess = r.tokens - KEEP;
      const c = command(s);
      // Viewing source is reading, not noise: whether a range would have done is for the review.
      const viewing = c !== null && segments(c).every((seg) => FILE_VIEWERS.test(seg));
      const wholeFile = (s.name === 'Read' && num(s.input.offset) === null && num(s.input.limit) === null) || viewing;
      const noisy = c !== null && !viewing;
      out.push(
        finding(tl, {
          category: wholeFile ? 'A8' : 'G33',
          title: `${describe(s)} returned ~${k(r.tokens)} tokens, carried through ${plural(sent, 'call')}`,
          steps: [s.index],
          wasted: [],
          confidence: noisy ? 'medium' : 'low',
          ...(noisy ? { cause: 'noisy command output; a hook or a filter could trim it' } : {}),
          costs: [{ key: `s${s.index}`, tokens: excess * sent, weighted: excess * (WEIGHTS.cacheWrite + WEIGHTS.cacheRead * (sent - 1)) }],
        }),
      );
    } else if (r.tokens * (sent - 1) >= LONG_CARRY) carried.push(s);
  }
  if (carried.length) {
    carried.sort((a, b) => b.result!.tokens * b.result!.sent - a.result!.tokens * a.result!.sent);
    out.push(
      finding(tl, {
        category: 'G34',
        title: `${plural(carried.length, 'result')} stayed in context for a long time (${describe(carried[0]!)}: ${plural(carried[0]!.result!.sent, 'call')})`,
        steps: carried.map((s) => s.index),
        wasted: [],
        confidence: 'low',
        costs: carried.map((s) => ({
          key: `s${s.index}`,
          tokens: s.result!.tokens * (s.result!.sent - 1),
          weighted: s.result!.tokens * WEIGHTS.cacheRead * (s.result!.sent - 1),
        })),
      }),
    );
  }
  return out;
}

// ---------- I, L. Round trips ----------

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);

/**
 * I41: three or more calls in a row, each making one read that didn't depend on the one before.
 * Only the structured read tools: a shell command's dependence on earlier output can't be told.
 */
export function serialReads(tl: Timeline): Finding[] {
  const out: Finding[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    if (run.length >= 3)
      out.push(
        finding(tl, {
          category: 'I41',
          title: `${run.length} independent reads made one call at a time`,
          steps: run.map((s) => s.index),
          wasted: [],
          avoidableCalls: run.slice(1).map((s) => s.call),
          confidence: 'low',
        }),
      );
    run = [];
  };
  let prev: ModelCall | null = null;
  for (const call of tl.calls) {
    if (call.agent !== null) continue;
    const s = call.tools.length === 1 ? tl.steps[call.tools[0]!]! : null;
    const read = s !== null && ok(s) && READ_TOOLS.has(s.name);
    const independent = read && run.length > 0 && !dependsOn(s!, run.at(-1)!);
    const consecutive = prev !== null && run.length > 0 && run.at(-1)!.call === prev.index;
    if (read && (run.length === 0 || (independent && consecutive))) run.push(s!);
    else {
      flush();
      if (read) run.push(s!);
    }
    prev = call;
  }
  flush();
  return out;
}

/** Whether `s` uses something only `before`'s result told it. */
function dependsOn(s: ToolStep, before: ToolStep): boolean {
  const text = before.result?.text ?? '';
  const targets = [s.input.file_path, s.input.path, s.input.pattern, s.input.url, command(s)].filter((v): v is string => typeof v === 'string');
  return targets.some((t) => text.includes(t) || text.includes(basename(t)));
}

/** L50: four or more calls in a row, each making one edit to the same file. */
export function piecemealEdits(tl: Timeline): Finding[] {
  const out: Finding[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    if (run.length >= 4)
      out.push(
        finding(tl, {
          category: 'L50',
          title: `${run.length} edits to ${filePath(run[0]!)} made one call at a time`,
          steps: run.map((s) => s.index),
          wasted: [],
          avoidableCalls: run.slice(1).map((s) => s.call),
          confidence: 'low',
        }),
      );
    run = [];
  };
  for (const call of tl.calls) {
    if (call.agent !== null) continue;
    const s = call.tools.length === 1 ? tl.steps[call.tools[0]!]! : null;
    if (s && s.name === 'Edit' && ok(s) && (run.length === 0 || filePath(run[0]!) === filePath(s))) run.push(s);
    else {
      flush();
      if (s && s.name === 'Edit' && ok(s)) run.push(s);
    }
  }
  flush();
  return out;
}

// ---------- J, K ----------

/** J45: two subagents started with the same task. */
export function duplicateSubagents(tl: Timeline): Finding[] {
  const seen = new Map<string, ToolStep[]>();
  for (const s of tl.steps) {
    if (!SUBAGENT_TOOLS.has(s.name)) continue;
    const key = normalize(String(s.input.prompt ?? s.input.description ?? '')).toLowerCase();
    if (key) seen.set(key, [...(seen.get(key) ?? []), s]);
  }
  const out: Finding[] = [];
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    const agents = group.slice(1).map((s) => tl.agents.find((a) => a.toolUseId === s.toolUseId)?.agentId);
    out.push(
      finding(tl, {
        category: 'J45',
        title: `Started the same subagent task ${group.length} times: ${describe(group[0]!)}`,
        steps: group.map((s) => s.index),
        wasted: group.slice(1).map((s) => s.index),
        avoidableCalls: tl.calls.filter((c) => c.agent !== null && agents.includes(c.agent)).map((c) => c.index),
        confidence: 'medium',
      }),
    );
  }
  return out;
}

/** K47: many calls with the context nearly full and no /compact. Shown for the review; not counted as waste. */
export function nearlyFull(tl: Timeline): Finding[] {
  const main = tl.calls.filter((c) => c.agent === null);
  const window = main.some((c) => c.prompt > 200_000) ? 1_000_000 : 200_000;
  const full = main.filter((c) => c.prompt >= window * 0.85);
  if (full.length < 5) return [];
  const steps = full.flatMap((c) => c.tools.slice(0, 1));
  return [
    finding(tl, {
      category: 'K47',
      title: `${full.length} calls ran with the context over 85% full`,
      steps,
      wasted: [],
      confidence: 'low',
      costs: [],
    }),
  ];
}

// ---------- the audit ----------

export const DETECTORS = [rereads, repeats, webRepeats, knownPathSearches, envProbes, wrongPackageManager, failures, reverts, bloat, serialReads, piecemealEdits, duplicateSubagents, nearlyFull];

export function detect(tl: Timeline): AuditReport {
  const findings = DETECTORS.flatMap((d) => d(tl)).sort((a, b) => b.weighted - a.weighted);
  const total = tl.calls.reduce((s, c) => s + c.prompt + c.usage.output, 0);
  const totalWeighted = tl.calls.reduce((s, c) => s + weighted(c.usage), 0);
  // A step or call flagged by several findings counts once, at its largest cost.
  const totals = (fs: Finding[], already = new Set<string>()): Totals => {
    const worst = new Map<string, Cost>();
    for (const f of fs)
      for (const c of f.costs) {
        if (already.has(c.key)) continue;
        const prev = worst.get(c.key);
        if (!prev || c.weighted > prev.weighted) worst.set(c.key, c);
      }
    const tokens = [...worst.values()].reduce((s, c) => s + c.tokens, 0);
    const w = [...worst.values()].reduce((s, c) => s + c.weighted, 0);
    const share = totalWeighted ? Math.min(1, w / totalWeighted) : 0;
    return { tokens, weighted: w, share, costUsd: tl.costUsd !== null ? tl.costUsd * share : null };
  };
  const sure = findings.filter((f) => f.confidence !== 'low');
  const sureKeys = new Set(sure.flatMap((f) => f.costs.map((c) => c.key)));
  return {
    sessionId: tl.sessionId,
    calls: tl.calls.length,
    tokens: total,
    weighted: totalWeighted,
    costUsd: tl.costUsd,
    wasted: totals(sure),
    toReview: totals(findings.filter((f) => f.confidence === 'low'), sureKeys),
    findings,
  };
}

// ---------- helpers ----------

function sorted(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
