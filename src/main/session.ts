import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { ConversationParser } from '../adapter/conversation.js';
import type { SessionMode, SessionSnapshot, SessionState } from '../shared/api.js';
import { findBackground, isAlive, readBackground, type BackgroundEntry } from './background.js';
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

interface Attachment {
  pty: pty.IPty;
  screen: Screen;
  buffer: string;
  written: number;
  exited: boolean;
}

export interface ChannelInfo {
  cwd: string | null;
  title: string;
  mode: SessionMode;
  /** Background sessions: the short id `claude attach` takes. */
  jobId?: string;
  /** Sessions running in another terminal: the pid to watch. */
  mirrorPid?: number;
  /** Messages the app already sent (e.g. a new session's first prompt), to label them correctly. */
  sentFromApp?: string[];
}

/**
 * One session as the window sees it. Events: `items` (changed conversation items), `state`,
 * `data` (terminal output chunk + stream offset), `sent` (id of a user message sent from the app),
 * `status` (status or mode changed), `ended` (the session's claude process finished).
 *
 * Sessions run as Claude Code background sessions. Companion's terminal pane is one more
 * `claude attach` client, next to any terminal you attach yourself, so every attached place can
 * type into the same live session. The conversation view is rendered from the transcript.
 */
export class SessionChannel extends EventEmitter {
  readonly parser = new ConversationParser();
  private tail: TranscriptTail;
  private att: Attachment | null = null;
  private bg: BackgroundEntry | null = null;
  private timer: NodeJS.Timeout | null = null;
  private queue: string[] = [];
  private awaitingEcho: string[] = [];
  private sentFromApp = new Set<string>();
  private lastStateJson = '';
  private screenDirty = false;
  private mirrorPid: number | null;
  state: SessionState;

  constructor(
    readonly sessionId: string,
    private deps: ChannelDeps,
    info: ChannelInfo,
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
      jobId: info.jobId ?? null,
    };
    if (info.jobId) this.bg = findBackground(deps.claudeDir, info.jobId);
    this.awaitingEcho.push(...(info.sentFromApp ?? []));
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      items: this.parser.all(),
      sentFromApp: [...this.sentFromApp],
      replay: this.att ? { data: this.att.buffer, end: this.att.written } : null,
    };
  }

  /** Companion's terminal pane is attached and can type into the session. */
  get attached(): boolean {
    return !!this.att && !this.att.exited;
  }

  /** The session's claude process is running in the background (attached here or not). */
  get alive(): boolean {
    return !!this.bg;
  }

  /** A background session was just started or found for this session. */
  useBackground(entry: BackgroundEntry): void {
    this.bg = entry;
    this.mirrorPid = null;
    this.tail.follow(entry.sessionId);
    this.update({ mode: 'background', jobId: entry.jobId, elsewhere: null, status: 'starting' });
  }

  /** Attaches Companion's terminal pane: `claude attach <job>` in a pseudo-terminal. */
  attach(): void {
    if (this.attached || !this.bg) return;
    const att: Attachment = {
      pty: pty.spawn(this.deps.claudeBin, ['attach', this.bg.jobId], {
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
    this.att = att;
    att.pty.onData((chunk) => {
      att.written += chunk.length;
      att.buffer += chunk;
      if (att.buffer.length > REPLAY_LIMIT) att.buffer = att.buffer.slice(-REPLAY_LIMIT);
      att.screen.write(chunk);
      this.screenDirty = true;
      this.emit('data', chunk, att.written);
    });
    att.pty.onExit(() => {
      att.exited = true;
      att.screen.dispose();
      // Detaching leaves a background session running; it just isn't attached here any more.
      this.update({ mode: this.bg ? 'background' : 'history', prompt: null });
    });
    this.update({ mode: 'attached' });
  }

  /** Closes Companion's terminal pane. The session keeps running. */
  detach(): void {
    if (this.attached) this.att!.pty.kill();
  }

  /** Queues a message; it is typed into the session as soon as Claude Code can take input. */
  send(text: string): void {
    this.queue.push(text);
    this.update({ queued: [...this.queue] });
    this.flush();
  }

  answer(key: string): void {
    const a = this.att;
    if (!a || a.exited || !this.state.prompt) return;
    if (this.state.prompt.kind === 'trust') {
      // The trust menu has no numbers: move to the wanted option, then confirm.
      const wantYes = key === 'yes';
      if (wantYes !== this.state.prompt.yesSelected) a.pty.write(wantYes ? '\x1b[B' : '\x1b[A');
      setTimeout(() => a.pty.write('\r'), 60);
    } else {
      a.pty.write(key);
    }
  }

  interrupt(): void {
    this.write('\x1b');
  }

  /** Shift+Tab: Claude Code cycles default → accept edits → plan mode. */
  cyclePermissionMode(): void {
    this.write('\x1b[Z');
  }

  write(data: string): void {
    if (this.attached) this.att!.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.attached || cols < 10 || rows < 4) return;
    this.att!.pty.resize(cols, rows);
    this.att!.screen.resize(cols, rows);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detach();
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

    if (this.state.mode === 'mirror') this.tickMirror();
    else if (this.bg) this.tickBackground();
    this.update({ facts: { ...this.parser.facts } });
  }

  private tickBackground(): void {
    const entry = readBackground(this.deps.claudeDir, this.bg!.pid);
    if (!entry) {
      // Stopped, or claude exited inside it.
      this.bg = null;
      this.detach();
      this.update({ mode: 'history', status: 'stopped', prompt: null, jobId: null });
      this.emit('ended');
      return;
    }
    this.bg = entry;

    let prompt = this.state.prompt;
    if (this.attached && this.screenDirty) {
      this.screenDirty = false;
      const found = detectPrompt(this.att!.screen.lines());
      // A numbered list in Claude's own reply looks like a menu; only trust it while Claude Code says it's waiting.
      prompt = found && (found.kind === 'trust' || entry.status === 'waiting') ? found : null;
    } else if (!this.attached || (prompt && prompt.kind !== 'trust' && entry.status !== 'waiting')) {
      prompt = null;
    }

    const status: SessionState['status'] =
      prompt || entry.status === 'waiting' ? 'waiting' : entry.status === 'busy' ? 'busy' : entry.status === 'idle' ? 'idle' : 'starting';
    this.update({ status, prompt });
    this.flush();
  }

  private tickMirror(): void {
    if (this.mirrorPid === null || !isAlive(this.mirrorPid)) {
      this.update({ mode: 'history', status: 'stopped', elsewhere: null });
      this.emit('ended');
      return;
    }
    const status = readStatus(this.deps.claudeDir, this.mirrorPid);
    this.update({ status: status === 'busy' ? 'busy' : status === 'waiting' ? 'waiting' : 'idle' });
  }

  /** Types queued messages once Claude Code shows its input box (registered, no dialog open). */
  private flush(): void {
    const a = this.att;
    if (!a || a.exited || !this.queue.length) return;
    if (this.state.prompt || this.state.status === 'starting') return;
    const text = this.queue.shift()!;
    this.awaitingEcho.push(text);
    // Bracketed paste keeps multi-line messages in one prompt; Enter submits it.
    a.pty.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => a.pty.write('\r'), 80);
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

function readStatus(claudeDir: string, pid: number): string | null {
  try {
    return JSON.parse(readFileSync(join(claudeDir, 'sessions', `${pid}.json`), 'utf8')).status ?? null;
  } catch {
    return null;
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const sameText = (a: string, b: string) => squash(a) === squash(b);
