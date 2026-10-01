import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Identifies our entry among the user's hooks. Commands run in a shell, so a trailing comment is harmless. */
const MARKER = '# claude-companion';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number }[];
}

type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export const settingsPath = (claudeDir: string) => join(claudeDir, 'settings.json');

/** The command Claude Code runs when a session ends: hand off to the companion and return at once. */
export function hookCommand(nodePath: string, cliPath: string): string {
  return `"${nodePath}" "${cliPath}" hook session-end ${MARKER}`;
}

const isOurs = (e: HookEntry) => e.hooks.some((h) => h.command?.includes(MARKER));

export function hookStatus(claudeDir: string): { installed: boolean; command: string | null } {
  const entry = read(settingsPath(claudeDir)).hooks?.SessionEnd?.find(isOurs);
  return { installed: !!entry, command: entry?.hooks[0]?.command ?? null };
}

export function installHook(claudeDir: string, command: string): { backup: string | null } {
  const path = settingsPath(claudeDir);
  const settings = read(path);
  const backup = backupOnce(path);
  const hooks = (settings.hooks ??= {});
  hooks.SessionEnd = [
    ...(hooks.SessionEnd ?? []).filter((e) => !isOurs(e)),
    { hooks: [{ type: 'command', command, timeout: 10 }] },
  ];
  write(path, settings);
  return { backup };
}

export function uninstallHook(claudeDir: string): boolean {
  const path = settingsPath(claudeDir);
  const settings = read(path);
  const before = settings.hooks?.SessionEnd ?? [];
  const after = before.filter((e) => !isOurs(e));
  if (after.length === before.length) return false;
  if (after.length) settings.hooks!.SessionEnd = after;
  else delete settings.hooks!.SessionEnd;
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  write(path, settings);
  return true;
}

function read(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text) as Settings;
  } catch {
    throw new Error(`${path} is not valid JSON; not touching it.`);
  }
}

/** Write to a temp file and rename, so a crash can't leave Claude Code with a half-written settings file. */
function write(path: string, settings: Settings) {
  const tmp = `${path}.companion-tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}

function backupOnce(path: string): string | null {
  const backup = `${path}.before-companion`;
  if (!existsSync(path) || existsSync(backup)) return null;
  copyFileSync(path, backup);
  return backup;
}
