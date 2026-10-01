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

/** The environment Claude sessions run in: ours, with the login shell's PATH merged in front. */
export function sessionEnv(shellPath: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Never leak our runtime switches into the user's sessions.
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'COMPANION_INTERNAL') env[k] = v;
  }
  if (shellPath) {
    const merged = new Set([...shellPath.split(':'), ...(env.PATH ?? '').split(':')].filter(Boolean));
    env.PATH = [...merged].join(':');
  }
  return env;
}
