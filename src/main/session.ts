import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { ConversationParser } from '../adapter/conversation.js';
import type { SessionMode, SessionSnapshot, SessionState } from '../shared/api.js';
import { detectPrompt, Screen } from './screen.js';
import { TranscriptTail } from './transcript.js';

const POLL_MS = 250;
/** Enough scrollback to repaint the terminal view, without keeping a long session's whole output. */
const REPLAY_LIMIT = 512 * 1024;
const COLS = 120;
const ROWS = 36;

export interface ChannelDeps {
  projectsDir: string;
  claudeDir: string;
  claudeBin: string;
  env: () => Record<string, string>;
}

interface Registry {
  status?: string;
  waitingFor?: string;
  sessionId?: string;
}

interface Proc {
  pty: pty.IPty;
  screen: Screen;
  buffer: string;
  written: number;
  exited: boolean;
}

/**
 * One session as the window sees it. Events: `items` (changed conversation items), `state`,
 * `data` (terminal output chunk + stream offset), `sent` (id of a user message sent from the app).
 *
 * In owned mode the session's `claude` runs in a pseudo-terminal here. The conversation view is
 * rendered from the transcript Claude Code writes, and anything typed in the app is typed into
 * that same terminal, so the two can never disagree.
 */
export class SessionChannel extends EventEmitter {
  readonly parser = new ConversationParser();
  private tail: TranscriptTail;
  private proc: Proc | null = null;
  private timer: NodeJS.Timeout | null = null;
  private queue: string[] = [];
  private awaitingEcho: string[] = [];
  private sentFromApp = new Set<string>();
  private lastStateJson = '';
  private screenDirty = false;
  private mirrorPid: number | null = null;
  state: SessionState;

  constructor(
    readonly sessionId: string,
    private deps: ChannelDeps,
    info: { cwd: string | null; title: string; mode: SessionMode; mirrorPid?: number },
  ) {
    super();
    this.tail = new TranscriptTail(deps.projectsDir, sessionId);
    this.mirrorPid = info.mirrorPid ?? null;
    this.state = {
      sessionId,
      mode: info.mode,
      status: info.mode === 'history' ? 'stopped' : 'starting',
      prompt: null,
      queued: [],
      facts: this.parser.facts,
      cwd: info.cwd,
      title: info.title,
      elsewhere: info.mirrorPid ? `pid ${info.mirrorPid}` : null,
    };
    this.parser.push(this.tail.poll());
    if (info.mode === 'mirror') this.tickMirror();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      items: this.parser.all(),
      sentFromApp: [...this.sentFromApp],
      replay: this.proc ? { data: this.proc.buffer, end: this.proc.written } : null,
    };
  }

  get running(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  /** Runs claude for this session in a pseudo-terminal. */
  start(args: string[]): void {
    if (this.running) return;
    const proc: Proc = {
      pty: pty.spawn(this.deps.claudeBin, args, {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: this.state.cwd ?? process.cwd(),
        env: { ...this.deps.env(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      }),
      screen: new Screen(COLS, ROWS),
      buffer: '',
      written: 0,
      exited: false,
    };
    this.proc = proc;
    this.mirrorPid = null;
    proc.pty.onData((chunk) => {
      proc.written += chunk.length;
      proc.buffer += chunk;
      if (proc.buffer.length > REPLAY_LIMIT) proc.buffer = proc.buffer.slice(-REPLAY_LIMIT);
      proc.screen.write(chunk);
      this.screenDirty = true;
      this.emit('data', chunk, proc.written);
    });
    proc.pty.onExit(() => {
      proc.exited = true;
      this.update({ mode: 'history', status: 'stopped', prompt: null });
      this.emit('exit');
    });
    this.update({ mode: 'owned', status: 'starting', elsewhere: null });
  }

  /** A message given to claude on its command line still came from the app. */
  expectFromApp(text: string): void {
    this.awaitingEcho.push(text);
  }

  /** Queues a message; it is typed into the terminal as soon as Claude Code can take input. */
  send(text: string): void {
    this.queue.push(text);
    this.update({ queued: [...this.queue] });
    this.flush();
  }

  answer(key: string): void {
    const p = this.proc;
    if (!p || p.exited || !this.state.prompt) return;
    if (this.state.prompt.kind === 'trust') {
      // The trust menu has no numbers: move to the wanted option, then confirm.
      const wantYes = key === 'yes';
      const atYes = this.state.prompt.yesSelected;
      if (wantYes !== atYes) p.pty.write(wantYes ? '\x1b[B' : '\x1b[A');
      setTimeout(() => p.pty.write('\r'), 60);
    } else {
      p.pty.write(key);
    }
  }

  interrupt(): void {
    if (this.running) this.proc!.pty.write('\x1b');
  }

  /** Shift+Tab: Claude Code cycles default → accept edits → plan mode. */
  cyclePermissionMode(): void {
    if (this.running) this.proc!.pty.write('\x1b[Z');
  }

  write(data: string): void {
    if (this.running) this.proc!.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.running || cols < 10 || rows < 4) return;
    this.proc!.pty.resize(cols, rows);
    this.proc!.screen.resize(cols, rows);
  }

  stop(): void {
    if (this.running) this.proc!.pty.kill();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stop();
    this.proc?.screen.dispose();
    this.removeAllListeners();
  }

  private tick(): void {
    const lines = this.tail.poll();
    if (lines.length) {
      const changed = this.parser.push(lines);
      for (const item of changed) {
        if (item.kind !== 'user') continue;
        const i = this.awaitingEcho.findIndex((t) => sameText(t, item.text));
        if (i >= 0) {
          this.awaitingEcho.splice(i, 1);
          this.sentFromApp.add(item.id);
          this.emit('sent', item.id);
        }
      }
      if (changed.length) this.emit('items', changed);
      if (this.parser.facts.title && this.parser.facts.title !== this.state.title) this.update({ title: this.parser.facts.title });
    }

    if (this.proc && !this.proc.exited) this.tickOwned();
    else if (this.state.mode === 'mirror') this.tickMirror();
    this.update({ facts: { ...this.parser.facts } });
  }

  private tickOwned(): void {
    const reg = readRegistry(this.deps.claudeDir, this.proc!.pty.pid);
    // Resuming can give the session a new id; follow the transcript Claude Code actually writes.
    if (reg?.sessionId) this.tail.follow(reg.sessionId);

    let prompt = this.state.prompt;
    if (this.screenDirty) {
      this.screenDirty = false;
      const found = detectPrompt(this.proc!.screen.lines());
      // A numbered list in Claude's own reply looks like a menu; only trust it while Claude Code says it's waiting.
      prompt = found && (found.kind === 'trust' || reg?.status === 'waiting') ? found : null;
    } else if (prompt && prompt.kind !== 'trust' && reg?.status !== 'waiting') {
      prompt = null;
    }

    const status: SessionState['status'] = prompt
      ? 'waiting'
      : reg?.status === 'busy'
        ? 'busy'
        : reg?.status === 'waiting'
          ? 'waiting'
          : reg?.status === 'idle'
            ? 'idle'
            : 'starting';
    this.update({ status, prompt });
    this.flush();
  }

  private tickMirror(): void {
    const alive = this.mirrorPid !== null && isAlive(this.mirrorPid);
    if (!alive) return this.update({ mode: 'history', status: 'stopped', elsewhere: null });
    const reg = readRegistry(this.deps.claudeDir, this.mirrorPid!);
    const status = reg?.status === 'busy' ? 'busy' : reg?.status === 'waiting' ? 'waiting' : 'idle';
    this.update({ status });
  }

  /** Types queued messages once Claude Code shows its input box (registered, no dialog open). */
  private flush(): void {
    const p = this.proc;
    if (!p || p.exited || !this.queue.length) return;
    if (this.state.prompt || this.state.status === 'starting') return;
    const text = this.queue.shift()!;
    this.awaitingEcho.push(text);
    // Bracketed paste keeps multi-line messages in one prompt; Enter submits it.
    p.pty.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => p.pty.write('\r'), 80);
    this.update({ queued: [...this.queue] });
  }

  private update(patch: Partial<SessionState>): void {
    const next = { ...this.state, ...patch };
    const json = JSON.stringify(next);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    const statusChanged = next.status !== this.state.status || next.mode !== this.state.mode;
    this.state = next;
    this.emit('state', next);
    // The session list shows status too (e.g. "needs you"), so let it refresh.
    if (statusChanged) this.emit('status');
  }
}

function readRegistry(claudeDir: string, pid: number): Registry | null {
  try {
    return JSON.parse(readFileSync(join(claudeDir, 'sessions', `${pid}.json`), 'utf8')) as Registry;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const sameText = (a: string, b: string) => squash(a) === squash(b);

