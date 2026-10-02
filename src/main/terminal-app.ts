import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Result } from '../shared/api.js';

const ITERM = '/Applications/iTerm.app';

/** Opens a new window in iTerm (if installed) or Terminal and runs `command` in `cwd`. */
export function openInTerminalApp(command: string, cwd: string): Promise<Result> {
  const line = `cd ${shellQuote(cwd)} && ${command}`;
  const script = existsSync(ITERM)
    ? [
        'tell application "iTerm"',
        'activate',
        'set w to (create window with default profile)',
        `tell current session of w to write text ${appleString(line)}`,
        'end tell',
      ]
    : ['tell application "Terminal"', 'activate', `do script ${appleString(line)}`, 'end tell'];
  return new Promise((resolve) => {
    execFile('osascript', script.flatMap((l) => ['-e', l]), (err) =>
      resolve(err ? { ok: false, error: `Could not open a terminal: ${err.message.split('\n')[0]}` } : { ok: true, value: undefined }),
    );
  });
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const appleString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
