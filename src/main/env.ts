import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

/**
 * Apps started from the Dock or Finder get a minimal PATH (no Homebrew, no ~/.local/bin), so
 * `claude` wouldn't be found. Ask the user's login shell for its PATH once, at startup.
 */
export function resolveShellPath(): string | null {
  const shell = process.env.SHELL || userInfo().shell || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.match(/__PATH__(.*)__END__/s)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Markers that must not leak into sessions we start. Claude Code's own session markers (set when
 * Companion itself was launched from inside a Claude session) make the child think it is a
 * subagent: it then skips writing its transcript and registering as live.
 */
const DROP = new Set([
  'ELECTRON_RUN_AS_NODE',
  'COMPANION_INTERNAL',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
]);

/** The environment Claude sessions run in: ours, minus runtime markers, with the login shell's PATH in front. */
export function sessionEnv(shellPath: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !DROP.has(k)) env[k] = v;
  }
  if (shellPath) {
    const merged = new Set([...shellPath.split(':'), ...(env.PATH ?? '').split(':')].filter(Boolean));
    env.PATH = [...merged].join(':');
  }
  return env;
}
