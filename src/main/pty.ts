import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { TermInfo, TermReplay } from '../shared/api.js';

/** Enough scrollback to repaint a tab, without holding a long session's whole output in memory. */
const REPLAY_LIMIT = 512 * 1024;

interface Term {
  info: TermInfo;
  proc: pty.IPty;
  /** Most recent output, capped at REPLAY_LIMIT. */
  buffer: string;
  /** Total characters ever written; the stream offset clients use to stitch replay and live data. */
  written: number;
}

export interface SpawnSpec {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Runs each Claude session in its own pseudo-terminal, so the real CLI works unchanged
 * (permissions, slash commands, plan mode). Emits `data` (id, chunk, end) and `exit` (id, code).
 */
export class PtyManager extends EventEmitter {
  private terms = new Map<string, Term>();

  open(spec: SpawnSpec): TermInfo {
    const proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: spec.cwd,
      env: { ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const term: Term = {
      info: { id: spec.id, sessionId: spec.sessionId, title: spec.title, cwd: spec.cwd, exited: false, exitCode: null },
      proc,
      buffer: '',
      written: 0,
    };
    this.terms.set(spec.id, term);
    proc.onData((chunk) => {
      term.written += chunk.length;
      term.buffer += chunk;
      if (term.buffer.length > REPLAY_LIMIT) term.buffer = term.buffer.slice(-REPLAY_LIMIT);
      this.emit('data', spec.id, chunk, term.written);
    });
    proc.onExit(({ exitCode }) => {
      term.info = { ...term.info, exited: true, exitCode };
      this.emit('exit', spec.id, exitCode);
    });
    return term.info;
  }

  list(): TermInfo[] {
    return [...this.terms.values()].map((t) => t.info);
  }

  get(id: string): TermInfo | null {
    return this.terms.get(id)?.info ?? null;
  }

  findBySession(sessionId: string): TermInfo | null {
    return this.list().find((t) => t.sessionId === sessionId && !t.exited) ?? null;
  }

  replay(id: string): TermReplay {
    const t = this.terms.get(id);
    return t ? { data: t.buffer, end: t.written } : { data: '', end: 0 };
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id);
    if (t && !t.info.exited) t.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (t && !t.info.exited && cols > 0 && rows > 0) t.proc.resize(cols, rows);
  }

  /** Ends the process (if still running) and forgets the tab. */
  close(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (!t.info.exited) t.proc.kill();
    this.terms.delete(id);
  }

  running(): TermInfo[] {
    return this.list().filter((t) => !t.exited);
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}
