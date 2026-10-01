import { spawnSync } from 'node:child_process';

export interface LaunchRequest {
  cwd: string;
  args: string[];
}

export interface LaunchResult {
  code: number | null;
  error?: string;
}

export const resumeSession = (cwd: string, sessionId: string): LaunchRequest => ({
  cwd,
  args: ['--resume', sessionId],
});

export const newSession = (cwd: string, prompt?: string): LaunchRequest => ({
  cwd,
  args: prompt?.trim() ? [prompt.trim()] : [],
});

/** `COMPANION_CLAUDE_BIN` swaps in another binary, which tests use to exercise the terminal handoff. */
const claudeBin = () => process.env.COMPANION_CLAUDE_BIN ?? 'claude';

/**
 * Runs claude in the foreground with the terminal attached. The caller must have released the
 * terminal first (Ink's `suspendTerminal`).
 *
 * This is deliberately synchronous. With an async spawn, libuv keeps polling the shared TTY while
 * the child runs; the child switches the TTY to blocking mode and drains it, so Node ends up stuck
 * in a blocking read() after the child exits and the TUI freezes until the next keypress (which it
 * then swallows). Blocking the event loop keeps Node off the TTY entirely until claude is done.
 */
export function runInteractive(req: LaunchRequest): LaunchResult {
  // Ctrl-C belongs to claude. The parent gets the same SIGINT, but only handles it once the event
  // loop resumes, so the no-op handler must outlive the spawn or Node's default handler would exit.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const r = spawnSync(claudeBin(), req.args, { cwd: req.cwd, stdio: 'inherit' });
    return r.error ? { code: null, error: r.error.message } : { code: r.status };
  } finally {
    setTimeout(() => process.off('SIGINT', ignore), 250);
  }
}
